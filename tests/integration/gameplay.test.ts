import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import type { NeonServer } from "../../src/server/app";
import type { RoomView, SnapshotMsg, WelcomeMsg } from "../../src/shared/types";
import { TestClient } from "../helpers/ws-client";
import { httpBase, pageOrigin, startTestServer, wsUrl } from "../helpers/server";

const servers: NeonServer[] = [];
const clients: TestClient[] = [];

function boot(): NeonServer {
  const app = startTestServer();
  servers.push(app);
  return app;
}

async function connect(
  app: NeonServer,
  name: string,
  token?: string,
): Promise<{ client: TestClient; welcome: WelcomeMsg }> {
  const client = new TestClient(wsUrl(app), pageOrigin(app));
  clients.push(client);
  await client.connect();
  client.send({
    t: "identify",
    v: PROTOCOL_VERSION,
    ...(token ? { token } : {}),
    ...(name ? { name } : {}),
  });
  const welcome = await client.next("welcome");
  return { client, welcome };
}

async function createRoom(client: TestClient): Promise<RoomView> {
  client.send({
    t: "create_room",
    v: PROTOCOL_VERSION,
    isPrivate: true,
    settings: { maxPlayers: 8, durationSec: 60, scoreLimit: 15 },
  });
  const state = await client.next("room_state");
  return state.room;
}

async function waitForPlaying(client: TestClient): Promise<SnapshotMsg> {
  const message = await client.nextWhere(
    (candidate) => candidate.t === "snapshot" && candidate.phase === "playing",
    8_000,
    "a playing snapshot",
  );
  return message as SnapshotMsg;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of servers.splice(0)) await app.stop();
});

describe("rooms and lobby", () => {
  test("creates a private room with a shareable six-character code", async () => {
    const app = boot();
    const { client: host, welcome } = await connect(app, "Alpha");

    expect(welcome.you).toMatch(/^[a-f0-9]{12}$/);
    expect(welcome.token.length).toBeGreaterThan(16);
    expect(welcome.resumed).toBe(false);
    expect(welcome.room).toBeNull();

    const room = await createRoom(host);
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(room.isPrivate).toBe(true);
    expect(room.hostId).toBe(welcome.you);
    expect(room.phase).toBe("lobby");
    expect(room.players).toHaveLength(1);
    expect(room.players[0]).toMatchObject({ name: "Alpha", ready: false, connected: true, isHost: true });
  });

  test("a second player joins the code and sees live roster updates", async () => {
    const app = boot();
    const { client: host } = await connect(app, "Alpha");
    const room = await createRoom(host);
    const { client: guest, welcome: guestWelcome } = await connect(app, "Beta");

    guest.send({ t: "join_room", v: PROTOCOL_VERSION, code: room.code.toLowerCase() });
    const guestState = await guest.next("room_state");
    expect(guestState.room.code).toBe(room.code);
    expect(guestState.room.players).toHaveLength(2);
    expect(guestState.room.players.some((player) => player.id === guestWelcome.you)).toBe(true);

    const hostState = await host.nextWhere(
      (message) => message.t === "room_state" && message.room.players.length === 2,
      4_000,
      "host roster update",
    );
    expect(hostState.t).toBe("room_state");
  });

  test("ready toggles are broadcast and only the host can start", async () => {
    const app = boot();
    const { client: host } = await connect(app, "Alpha");
    const room = await createRoom(host);
    const { client: guest } = await connect(app, "Beta");
    guest.send({ t: "join_room", v: PROTOCOL_VERSION, code: room.code });
    await guest.next("room_state");

    guest.send({ t: "set_ready", v: PROTOCOL_VERSION, ready: true });
    const readyState = await guest.nextWhere(
      (message) => message.t === "room_state" && message.room.players.some((p) => p.ready),
      4_000,
      "ready state",
    );
    expect(readyState.t).toBe("room_state");

    guest.send({ t: "start_match", v: PROTOCOL_VERSION });
    const denied = await guest.next("error");
    expect(denied.code).toBe("not_host");
    expect(denied.fatal).toBe(false);

    // A non-host cannot edit settings either.
    guest.send({
      t: "update_settings",
      v: PROTOCOL_VERSION,
      settings: { maxPlayers: 6, durationSec: 60, scoreLimit: 15 },
    });
    const settingsDenied = await guest.next("error");
    expect(settingsDenied.code).toBe("not_host");

    host.send({
      t: "update_settings",
      v: PROTOCOL_VERSION,
      settings: { maxPlayers: 6, durationSec: 60, scoreLimit: 20 },
    });
    const updated = await host.nextWhere(
      (message) =>
        message.t === "room_state" &&
        message.room.settings.maxPlayers === 6 &&
        message.room.settings.scoreLimit === 20,
      4_000,
      "updated settings",
    );
    expect(updated.t).toBe("room_state");
  });

  test("unknown and malformed room codes are rejected", async () => {
    const app = boot();
    const { client } = await connect(app, "Alpha");
    client.send({ t: "join_room", v: PROTOCOL_VERSION, code: "ZZZZZZ" });
    const notFound = await client.next("error");
    expect(notFound.code).toBe("room_not_found");

    client.send({ t: "join_room", v: PROTOCOL_VERSION, code: "nope" });
    const invalid = await client.next("error");
    expect(invalid.code).toBe("room_not_found");
  });

  test("leaving a room notifies the leaver and the remaining host", async () => {
    const app = boot();
    const { client: host } = await connect(app, "Alpha");
    const room = await createRoom(host);
    const { client: guest } = await connect(app, "Beta");
    guest.send({ t: "join_room", v: PROTOCOL_VERSION, code: room.code });
    await guest.next("room_state");
    await host.nextWhere(
      (message) => message.t === "room_state" && message.room.players.length === 2,
      4_000,
      "two-player roster",
    );

    guest.send({ t: "leave_room", v: PROTOCOL_VERSION });
    const left = await guest.next("left_room");
    expect(left.reason).toBe("voluntary");
    expect(left.roomCode).toBe(room.code);

    const shrunk = await host.nextWhere(
      (message) => message.t === "room_state" && message.room.players.length === 1,
      4_000,
      "one-player roster",
    );
    expect(shrunk.t).toBe("room_state");
  });
});

describe("match flow", () => {
  test("host starts a match, inputs move the authoritative player, match ends and rematches", async () => {
    const app = boot();
    const { client: host } = await connect(app, "Alpha");
    const room = await createRoom(host);
    const { client: guest, welcome: guestWelcome } = await connect(app, "Beta");
    guest.send({ t: "join_room", v: PROTOCOL_VERSION, code: room.code });
    await guest.next("room_state");
    await host.nextWhere(
      (message) => message.t === "room_state" && message.room.players.length === 2,
      4_000,
      "two-player roster",
    );

    host.send({ t: "start_match", v: PROTOCOL_VERSION });
    const startHost = await host.next("match_start");
    const startGuest = await guest.next("match_start");
    expect(startHost.match.roomCode).toBe(room.code);
    expect(startHost.match.roster.map((entry) => entry.name).sort()).toEqual(["Alpha", "Beta"]);
    expect(startGuest.match.startedAt).toBe(startHost.match.startedAt);

    const countdownSnapshot = await host.next("snapshot");
    expect(countdownSnapshot.phase).toBe("countdown");

    const liveHost = await waitForPlaying(host);
    const liveGuest = await waitForPlaying(guest);
    expect(liveHost.players).toHaveLength(2);
    expect(liveHost.tick).toBeGreaterThanOrEqual(0);
    expect(liveHost.crystals.length).toBeGreaterThan(0);
    expect(liveGuest.phase).toBe("playing");

    const guestLive = liveHost.players.find((player) => player.id === guestWelcome.you)!;
    // Walk toward the arena centre so spawns near a wall still have room.
    const direction = guestLive.x > 1200 ? -1 : 1;
    const startX = guestLive.x;
    guest.send({
      t: "input",
      v: PROTOCOL_VERSION,
      seq: 1,
      moveX: direction,
      moveY: 0,
      aim: 1.25,
      fire: false,
      dash: false,
    });

    let moved = false;
    for (let i = 0; i < 100 && !moved; i += 1) {
      const snapshot = await host.next("snapshot");
      const player = snapshot.players.find((entry) => entry.id === guestWelcome.you);
      if (!player) continue;
      if (snapshot.acks[guestWelcome.you] >= 1) {
        expect(player.x).not.toBe(startX);
        expect(snapshot.acks[guestWelcome.you]).toBe(1);
        moved = true;
      }
    }
    expect(moved).toBe(true);

    guest.send({
      t: "input",
      v: PROTOCOL_VERSION,
      seq: 2,
      moveX: 0,
      moveY: 0,
      aim: 1.25,
      fire: false,
      dash: false,
    });

    host.send({ t: "ping", v: PROTOCOL_VERSION, id: 99, clientTime: 123_456 });
    const pong = await host.next("pong");
    expect(pong.id).toBe(99);
    expect(pong.clientTime).toBe(123_456);
    expect(pong.serverTime).toBeGreaterThan(0);

    // End the match through the explicitly gated test hook.
    const finishResponse = await fetch(`${httpBase(app)}/api/test/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: room.code }),
    });
    expect(finishResponse.status).toBe(200);
    expect(await finishResponse.json()).toEqual({ ok: true });

    const endHost = await host.next("match_end");
    const endGuest = await guest.next("match_end");
    expect(endHost.results.reason).toBe("time");
    expect(endHost.results.roomCode).toBe(room.code);
    expect(endHost.results.rankings).toHaveLength(2);
    expect(endHost.results.winners.length).toBeGreaterThanOrEqual(1);
    expect(endGuest.results.endedAt).toBeGreaterThan(0);

    // Any room member may trigger a rematch.
    guest.send({ t: "rematch", v: PROTOCOL_VERSION });
    const rematchHost = await host.next("match_start");
    const rematchGuest = await guest.next("match_start");
    expect(rematchHost.match.startedAt).toBe(rematchGuest.match.startedAt);
    expect(rematchHost.match.roster).toHaveLength(2);
  }, 20_000);

  test("reconnecting with the session token resumes the same match", async () => {
    const app = boot();
    const { client: host } = await connect(app, "Alpha");
    const room = await createRoom(host);
    const { client: guest, welcome: guestWelcome } = await connect(app, "Beta");
    guest.send({ t: "join_room", v: PROTOCOL_VERSION, code: room.code });
    await guest.next("room_state");
    host.send({ t: "start_match", v: PROTOCOL_VERSION });
    await waitForPlaying(host);

    guest.close();
    const offline = await host.nextWhere(
      (message) =>
        message.t === "snapshot" &&
        message.players.some((player) => player.id === guestWelcome.you && !player.connected),
      8_000,
      "disconnected player snapshot",
    );
    expect(offline.t).toBe("snapshot");

    const { client: resumed, welcome } = await connect(app, "", guestWelcome.token);
    expect(welcome.resumed).toBe(true);
    expect(welcome.you).toBe(guestWelcome.you);
    expect(welcome.room?.code).toBe(room.code);
    expect(welcome.match?.roomCode).toBe(room.code);

    const backOnline = await host.nextWhere(
      (message) =>
        message.t === "snapshot" &&
        message.players.some((player) => player.id === guestWelcome.you && player.connected),
      8_000,
      "reconnected player snapshot",
    );
    expect(backOnline.t).toBe("snapshot");
    const resumedSnapshot = await resumed.next("snapshot");
    expect(resumedSnapshot.phase).not.toBe("finished");
  }, 20_000);

  test("returning to the lobby resets the room for the host", async () => {
    const app = boot();
    const { client: host } = await connect(app, "Alpha");
    const room = await createRoom(host);
    host.send({ t: "start_match", v: PROTOCOL_VERSION });
    await host.next("match_start");
    await waitForPlaying(host);

    await fetch(`${httpBase(app)}/api/test/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: room.code }),
    });
    await host.next("match_end");

    host.send({ t: "return_to_lobby", v: PROTOCOL_VERSION });
    const lobby = await host.nextWhere(
      (message) => message.t === "room_state" && message.room.phase === "lobby",
      4_000,
      "lobby room state",
    );
    if (lobby.t !== "room_state") throw new Error("unreachable");
    expect(lobby.room.players[0].ready).toBe(false);
  }, 20_000);

  test("quick match puts two players in the same public room", async () => {
    const app = boot();
    const { client: first, welcome: firstWelcome } = await connect(app, "Alpha");
    first.send({ t: "quick_match", v: PROTOCOL_VERSION });
    const firstState = await first.next("room_state");
    expect(firstState.room.isPrivate).toBe(false);
    expect(firstState.room.autoStartInMs).not.toBeNull();

    const { client: second, welcome: secondWelcome } = await connect(app, "Beta");
    second.send({ t: "quick_match", v: PROTOCOL_VERSION });
    const secondState = await second.next("room_state");
    expect(secondState.room.code).toBe(firstState.room.code);
    expect(secondState.room.players.map((player) => player.id).sort()).toEqual(
      [firstWelcome.you, secondWelcome.you].sort(),
    );
  });
});
