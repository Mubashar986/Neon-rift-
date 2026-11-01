import { afterEach, describe, expect, test } from "bun:test";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "../../src/shared/constants";
import type { NeonServer } from "../../src/server/app";
import { TestClient } from "../helpers/ws-client";
import { httpBase, pageOrigin, startTestServer, wsUrl } from "../helpers/server";

const servers: NeonServer[] = [];
const clients: TestClient[] = [];

function boot(overrides: Parameters<typeof startTestServer>[0] = {}): NeonServer {
  const app = startTestServer(overrides);
  servers.push(app);
  return app;
}

async function connect(app: NeonServer, name = "Probe"): Promise<TestClient> {
  const client = new TestClient(wsUrl(app), pageOrigin(app));
  clients.push(client);
  await client.connect();
  client.send({ t: "identify", v: PROTOCOL_VERSION, name });
  await client.next("welcome");
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of servers.splice(0)) await app.stop();
});

describe("WebSocket handshake", () => {
  test("rejects a cross-site origin in production", async () => {
    const app = boot({ isProduction: true });
    const client = new TestClient(wsUrl(app), "https://evil.example");
    clients.push(client);
    await expect(client.connect()).rejects.toThrow();
    await client.waitForClose(2_000);
  });

  test("rejects a null origin", async () => {
    const app = boot();
    const client = new TestClient(wsUrl(app), "null");
    clients.push(client);
    await expect(client.connect()).rejects.toThrow();
  });

  test("accepts same-host and origin-less clients", async () => {
    const app = boot();
    const sameHost = new TestClient(wsUrl(app), pageOrigin(app));
    clients.push(sameHost);
    await sameHost.connect();
    sameHost.send({ t: "identify", v: PROTOCOL_VERSION, name: "SameHost" });
    await sameHost.next("welcome");

    const native = new TestClient(wsUrl(app));
    clients.push(native);
    await native.connect();
    native.send({ t: "identify", v: PROTOCOL_VERSION, name: "Native" });
    await native.next("welcome");
  });
});

describe("message validation", () => {
  test("unidentified sockets cannot issue commands", async () => {
    const app = boot();
    const client = new TestClient(wsUrl(app), pageOrigin(app));
    clients.push(client);
    await client.connect();
    client.send({ t: "quick_match", v: PROTOCOL_VERSION });
    const error = await client.next("error");
    expect(error.code).toBe("not_identified");
  });

  test("malformed frames are rejected and repeated abuse closes the socket", async () => {
    const app = boot();
    const client = await connect(app);
    for (let i = 0; i < 8; i += 1) client.sendRaw("{definitely not json");
    const error = await client.next("error");
    expect(error.code).toBe("invalid_message");
    expect(error.fatal).toBe(false);
    await client.waitForClose(3_000);
  });

  test("binary frames are rejected", async () => {
    const app = boot();
    const client = await connect(app);
    client.sendBinary(new Uint8Array([0x7b, 0x7d]));
    const error = await client.next("error");
    expect(error.code).toBe("invalid_message");
  });

  test("wrong protocol versions are rejected", async () => {
    const app = boot();
    const client = await connect(app);
    client.sendRaw(JSON.stringify({ t: "quick_match", v: PROTOCOL_VERSION + 1 }));
    const error = await client.next("error");
    expect(error.code).toBe("unsupported_version");
  });

  test("oversized frames are refused at the transport limit", async () => {
    const app = boot();
    const client = await connect(app);
    client.sendRaw("x".repeat(MAX_MESSAGE_BYTES + 1_000));
    await client.waitForClose(3_000);
  });

  test("hostile names are sanitized before broadcast", async () => {
    const app = boot();
    const client = new TestClient(wsUrl(app), pageOrigin(app));
    clients.push(client);
    await client.connect();
    client.send({ t: "identify", v: PROTOCOL_VERSION, name: "Ne\u0000o<>" });
    const welcome = await client.next("welcome");
    expect(welcome.name).toBe("Neo");
    expect(welcome.name).not.toContain("<");
  });

  test("rate limiting rejects a burst of valid messages", async () => {
    const app = boot();
    const client = await connect(app);
    const ping = JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, id: 1, clientTime: 0 });
    for (let i = 0; i < 400; i += 1) client.sendRaw(ping);
    const error = await client.nextWhere(
      (message) => message.t === "error" && message.code === "rate_limited",
      4_000,
      "rate limit error",
    );
    expect(error.t).toBe("error");
  }, 10_000);
});

describe("session security", () => {
  test("token replay takes over the session and closes the original socket", async () => {
    const app = boot();
    const first = new TestClient(wsUrl(app), pageOrigin(app));
    clients.push(first);
    await first.connect();
    first.send({ t: "identify", v: PROTOCOL_VERSION, name: "Alpha" });
    const firstWelcome = await first.next("welcome");

    const second = new TestClient(wsUrl(app), pageOrigin(app));
    clients.push(second);
    await second.connect();
    second.send({ t: "identify", v: PROTOCOL_VERSION, token: firstWelcome.token });
    const secondWelcome = await second.next("welcome");
    expect(secondWelcome.resumed).toBe(true);
    expect(secondWelcome.you).toBe(firstWelcome.you);

    const takeover = await first.next("error");
    expect(takeover.code).toBe("session_takeover");
    expect(takeover.fatal).toBe(true);
    await first.waitForClose(3_000);
  });

  test("a garbage token creates a fresh identity instead of erroring", async () => {
    const app = boot();
    const client = new TestClient(wsUrl(app), pageOrigin(app));
    clients.push(client);
    await client.connect();
    client.send({ t: "identify", v: PROTOCOL_VERSION, token: "not-a-real-token", name: "Fresh" });
    const welcome = await client.next("welcome");
    expect(welcome.resumed).toBe(false);
    expect(welcome.you).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe("HTTP surface", () => {
  test("health and status endpoints report live metrics", async () => {
    const app = boot();
    const health = await fetch(`${httpBase(app)}/healthz`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody.ok).toBe(true);
    expect(healthBody.service).toBe("neon-rift-arena");

    const status = await fetch(`${httpBase(app)}/api/status`);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(statusBody.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(statusBody.simulation).toMatchObject({ tickRate: 30, snapshotRate: 15 });
  });

  test("the SPA shell is served for invite links with security headers", async () => {
    const app = boot();
    const response = await fetch(`${httpBase(app)}/play?room=ABC123`, {
      headers: { Accept: "text/html" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const html = await response.text();
    expect(html).toContain("NEON RIFT");
  });

  test("unknown API and asset paths are 404", async () => {
    const app = boot();
    expect((await fetch(`${httpBase(app)}/api/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${httpBase(app)}/missing.js`)).status).toBe(404);
  });

  test("the finish hook is disabled unless explicitly enabled", async () => {
    const app = boot({ enableTestEndpoints: false });
    const response = await fetch(`${httpBase(app)}/api/test/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: "ABC123" }),
    });
    expect(response.status).toBe(404);
  });

  test("the enabled finish hook validates its input", async () => {
    const app = boot();
    const bad = await fetch(`${httpBase(app)}/api/test/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${httpBase(app)}/api/test/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: "!!!!!!" }),
    });
    expect(missing.status).toBe(400);

    const absent = await fetch(`${httpBase(app)}/api/test/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: "ABC234" }),
    });
    expect(absent.status).toBe(404);
  });
});
