/**
 * Real WebSocket load test. It drives actual clients against a real server:
 * identify -> private room -> start match -> 30Hz input for N seconds, then
 * reports measured connection, snapshot, acknowledgement-latency and server
 * tick metrics. No numbers are simulated.
 *
 * Examples:
 *   bun run loadtest --spawn --clients 8 --rooms 1 --duration 15
 *   bun run loadtest --url ws://127.0.0.1:3000/ws --clients 16 --rooms 2
 *
 * Options:
 *   --spawn              start a local production server (port from --port)
 *   --port 3200          local server port when --spawn is used
 *   --url                WebSocket URL (default ws://127.0.0.1:3000/ws)
 *   --origin             Origin header (default derived from --url)
 *   --clients 8          total clients
 *   --rooms 1            number of private rooms (clients split evenly)
 *   --duration 15        measured seconds after every room is live
 *   --warmup 0           extra seconds of input before measurement starts
 *   --json               only print the JSON report
 */
import { cpus, platform, release } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "../src/shared/constants";
import type { ClientMessage, MatchStartMsg, RoomStateMsg, ServerMessage, SnapshotMsg } from "../src/shared/types";

interface Options {
  spawn: boolean;
  port: number;
  url: string;
  origin: string;
  clients: number;
  rooms: number;
  durationSec: number;
  warmupSec: number;
  json: boolean;
}

function parseOptions(argv: string[]): Options {
  const read = (flag: string, fallback: string): string => {
    const index = argv.findIndex((value) => value === `--${flag}` || value.startsWith(`--${flag}=`));
    if (index < 0) return fallback;
    const token = argv[index];
    if (token.includes("=")) return token.slice(token.indexOf("=") + 1);
    return argv[index + 1] ?? fallback;
  };
  const has = (flag: string): boolean => argv.includes(`--${flag}`);

  const port = Number(read("port", "3200"));
  const url = read("url", `ws://127.0.0.1:${port}/ws`);
  return {
    spawn: has("spawn"),
    port,
    url,
    origin: read("origin", url.replace(/^ws/, "http").replace(/\/ws.*$/, "")),
    clients: Math.max(1, Number(read("clients", "8"))),
    rooms: Math.max(1, Number(read("rooms", "1"))),
    durationSec: Math.max(1, Number(read("duration", "15"))),
    warmupSec: Math.max(0, Number(read("warmup", "0"))),
    json: has("json"),
  };
}

const options = parseOptions(process.argv.slice(2));
const httpBase = options.origin;
const clientsPerRoom = Math.max(1, Math.floor(options.clients / options.rooms));
const totalClients = clientsPerRoom * options.rooms;

interface Waiter {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class BenchClient {
  readonly sentAt = new Map<number, number>();
  readonly latencies: number[] = [];
  seq = 0;
  snapshots = 0;
  bytesIn = 0;
  bytesOut = 0;
  messagesIn = 0;
  closed = false;
  selfId = "";
  private socket: WebSocket | null = null;
  private waiters: Waiter[] = [];
  private inputTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly index: number,
    readonly name: string,
    private readonly url: string,
    private readonly origin: string,
  ) {}

  async connect(): Promise<number> {
    const started = performance.now();
    const socket = new WebSocket(this.url, { headers: { Origin: this.origin } } as unknown as string[]);
    this.socket = socket;

    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: connect timeout`)), 5_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`${this.name}: connection error`));
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      this.messagesIn += 1;
      this.bytesIn += raw.length;
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === "snapshot") this.handleSnapshot(message);
      this.deliver(message);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${this.name}: socket closed while waiting`));
      }
    });

    return performance.now() - started;
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(message);
    this.bytesOut += raw.length;
    this.socket.send(raw);
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 10_000,
    label = "message",
  ): Promise<ServerMessage> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.name}: timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: resolvePromise, reject, timer });
    });
  }

  startInput(durationMs: number): void {
    if (this.inputTimer) return;
    const periodMs = 1000 / 30;
    const endsAt = performance.now() + durationMs;
    this.inputTimer = setInterval(() => {
      if (performance.now() >= endsAt || this.closed) {
        this.stopInput();
        return;
      }
      this.seq += 1;
      const phase = performance.now() / 900 + this.index;
      this.sentAt.set(this.seq, performance.now());
      if (this.sentAt.size > 600) {
        const oldest = this.sentAt.keys().next().value;
        if (oldest !== undefined) this.sentAt.delete(oldest);
      }
      this.send({
        t: "input",
        v: PROTOCOL_VERSION,
        seq: this.seq,
        moveX: Math.cos(phase),
        moveY: Math.sin(phase * 0.7),
        aim: (phase % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2),
        fire: this.seq % 4 === 0,
        dash: this.seq % 75 === 0,
      });
    }, periodMs);
  }

  stopInput(): void {
    if (this.inputTimer) {
      clearInterval(this.inputTimer);
      this.inputTimer = null;
    }
  }

  close(): void {
    this.stopInput();
    this.socket?.close();
    this.socket = null;
  }

  private handleSnapshot(snapshot: SnapshotMsg): void {
    this.snapshots += 1;
    const ack = snapshot.acks[this.selfId];
    if (ack === undefined) return;
    for (const [seq, sent] of this.sentAt) {
      if (seq <= ack) {
        this.latencies.push(performance.now() - sent);
        this.sentAt.delete(seq);
      }
    }
  }

  private deliver(message: ServerMessage): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function fetchStatus(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${httpBase}/api/status`);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${httpBase}/healthz`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(150);
  }
  throw new Error(`server did not become healthy at ${httpBase}`);
}

function spawnServer(): ReturnType<typeof Bun.spawn> {
  const root = resolve(import.meta.dir, "..");
  const child = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(options.port),
      PUBLIC_ORIGIN: httpBase,
      LOG_LEVEL: "warn",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  return child;
}

async function main(): Promise<void> {
  let server: ReturnType<typeof Bun.spawn> | null = null;
  if (options.spawn) {
    server = spawnServer();
    await waitForHealth();
  }

  const statusBefore = await fetchStatus();
  const clients: BenchClient[] = [];
  const connectTimes: number[] = [];
  const startTimes: number[] = [];

  try {
    const roomCodes: string[] = [];
    await Promise.all(
      Array.from({ length: options.rooms }, async (_, roomIndex) => {
        const roomClients: BenchClient[] = [];
        for (let i = 0; i < clientsPerRoom; i += 1) {
          const index = roomIndex * clientsPerRoom + i;
          roomClients.push(
            new BenchClient(index, `Bench-${roomIndex + 1}-${i + 1}`, options.url, options.origin),
          );
        }
        clients.push(...roomClients);

        await Promise.all(
          roomClients.map(async (client) => {
            connectTimes.push(await client.connect());
            client.send({ t: "identify", v: PROTOCOL_VERSION, name: client.name });
            const welcome = (await client.waitFor((m) => m.t === "welcome", 8_000, "welcome")) as {
              you: string;
            };
            client.selfId = welcome.you;
          }),
        );

        const host = roomClients[0];
        host.send({
          t: "create_room",
          v: PROTOCOL_VERSION,
          isPrivate: true,
          settings: { maxPlayers: 8, durationSec: 300, scoreLimit: 100 },
        });
        const created = (await host.waitFor((m) => m.t === "room_state", 8_000, "room state")) as RoomStateMsg;
        roomCodes.push(created.room.code);

        await Promise.all(
          roomClients.slice(1).map(async (client) => {
            client.send({ t: "join_room", v: PROTOCOL_VERSION, code: created.room.code });
            await client.waitFor((m) => m.t === "room_state", 8_000, "join confirmation");
          }),
        );

        const startedAt = performance.now();
        host.send({ t: "start_match", v: PROTOCOL_VERSION });
        await Promise.all(
          roomClients.map((client) =>
            client.waitFor((m) => m.t === "match_start", 10_000, "match start").then((message) => {
              const start = message as MatchStartMsg;
              if (start.match.roomCode !== created.room.code) {
                throw new Error(`${client.name}: room code mismatch in match_start`);
              }
            }),
          ),
        );
        startTimes.push(performance.now() - startedAt);

        await Promise.all(
          roomClients.map((client) =>
            client.waitFor(
              (m) => m.t === "snapshot" && m.phase === "playing",
              12_000,
              "playing snapshot",
            ),
          ),
        );
      }),
    );

    const measuredStart = performance.now();
    const snapshotBase = new Map(clients.map((client) => [client, client.snapshots]));
    for (const client of clients) client.startInput((options.warmupSec + options.durationSec + 0.5) * 1000);
    await Bun.sleep(options.warmupSec * 1000);

    const windowStart = performance.now();
    await Bun.sleep(options.durationSec * 1000);
    const windowEnd = performance.now();
    for (const client of clients) client.stopInput();

    const statusAfter = await fetchStatus();
    const elapsedSec = (windowEnd - windowStart) / 1000;

    const latencies = clients.flatMap((client) => client.latencies);
    const snapshotTotal = clients.reduce((sum, client) => sum + client.snapshots, 0);
    const bytesIn = clients.reduce((sum, client) => sum + client.bytesIn, 0);
    const bytesOut = clients.reduce((sum, client) => sum + client.bytesOut, 0);
    const inputsSent = clients.reduce((sum, client) => sum + client.seq, 0);
    const acked = clients.reduce(
      (sum, client) => sum + client.seq - client.sentAt.size,
      0,
    );
    const snapshotsInWindow = totalClients > 0
      ? clients.reduce((sum, client) => sum + (client.snapshots - (snapshotBase.get(client) ?? 0)), 0) / elapsedSec
      : 0;

    const tick = (statusAfter?.tick ?? {}) as { avgMs?: number; maxMs?: number; samples?: number; lastTickAgeMs?: number };
    const memory = (statusAfter?.memoryMb ?? {}) as { rss?: number; heapUsed?: number };
    const messages = (statusAfter?.messages ?? {}) as { in?: number; out?: number; invalid?: number; rateLimited?: number };

    const report = {
      generatedAt: new Date().toISOString(),
      environment: {
        platform: platform(),
        release: release(),
        cpus: cpus().length,
        bun: Bun.version,
        // The server runs in this same process only when --spawn is used.
        serverMode: options.spawn ? "spawned locally by loadtest" : "external",
      },
      configuration: {
        clients: totalClients,
        rooms: options.rooms,
        clientsPerRoom,
        durationSec: options.durationSec,
        warmupSec: options.warmupSec,
        url: options.url,
        roomCodes,
      },
      client: {
        connectMs: {
          avg: round(connectTimes.reduce((a, b) => a + b, 0) / Math.max(1, connectTimes.length)),
          max: round(Math.max(0, ...connectTimes)),
        },
        matchStartMs: {
          avg: round(startTimes.reduce((a, b) => a + b, 0) / Math.max(1, startTimes.length)),
          max: round(Math.max(0, ...startTimes)),
        },
        inputAckRatio: inputsSent === 0 ? 0 : round(acked / inputsSent, 3),
        ackLatencyMs: {
          samples: latencies.length,
          p50: round(percentile(latencies, 50)),
          p95: round(percentile(latencies, 95)),
          p99: round(percentile(latencies, 99)),
          max: round(latencies.length > 0 ? Math.max(...latencies) : 0),
        },
        snapshotsPerSecondPerClient: round(snapshotsInWindow / Math.max(1, totalClients)),
        bytesInPerSecond: round(bytesIn / elapsedSec, 0),
        bytesOutPerSecond: round(bytesOut / elapsedSec, 0),
        messagesReceived: snapshotTotal,
        closedEarly: clients.filter((client) => client.closed).length,
      },
      server: {
        tick: {
          avgMs: tick.avgMs ?? 0,
          maxMs: tick.maxMs ?? 0,
          samples: tick.samples ?? 0,
          lastTickAgeMs: tick.lastTickAgeMs ?? 0,
        },
        rssMb: memory.rss ?? 0,
        heapUsedMb: memory.heapUsed ?? 0,
        totals: messages,
        statusBeforeAvailable: statusBefore !== null,
      },
      measuredForSec: round(elapsedSec),
      loadTestElapsedSec: round((performance.now() - measuredStart) / 1000),
    };

    const outDir = resolve(import.meta.dir, "../loadtest-results");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(outDir, `run-${stamp}.json`);
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("\nNEON RIFT load test");
      console.log(`  clients/rooms      ${totalClients} / ${options.rooms} (${clientsPerRoom} per room)`);
      console.log(`  measured window    ${round(elapsedSec, 1)}s`);
      console.log(`  connect avg/max    ${report.client.connectMs.avg} / ${report.client.connectMs.max} ms`);
      console.log(`  match start avg    ${report.client.matchStartMs.avg} ms`);
      console.log(
        `  ack latency p50    ${report.client.ackLatencyMs.p50} ms   p95 ${report.client.ackLatencyMs.p95} ms   p99 ${report.client.ackLatencyMs.p99} ms`,
      );
      console.log(`  input ack ratio    ${(report.client.inputAckRatio * 100).toFixed(1)}%`);
      console.log(
        `  snapshots/client   ${report.client.snapshotsPerSecondPerClient}/s (target ${15})`,
      );
      console.log(
        `  bandwidth in/out   ${(report.client.bytesInPerSecond / 1024).toFixed(1)} / ${(report.client.bytesOutPerSecond / 1024).toFixed(1)} KiB/s (all clients)`,
      );
      console.log(
        `  server tick        avg ${report.server.tick.avgMs} ms   max ${report.server.tick.maxMs} ms   RSS ${report.server.rssMb} MB`,
      );
      console.log(`  report             ${outPath}\n`);
    }

    const failed = clients.some((client) => client.closed) || report.client.inputAckRatio < 0.8;
    if (failed) {
      console.error("load test failed: a client disconnected early or too few inputs were acknowledged");
      process.exitCode = 1;
    }
  } finally {
    for (const client of clients) client.close();
    await Bun.sleep(100);
    if (server) {
      server.kill();
      await server.exited;
    }
  }
}

await main();
