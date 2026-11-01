import type { ClientMessage, ServerMessage } from "../../src/shared/types";

type MessageType = ServerMessage["t"];

interface Waiter {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal WebSocket client used by the integration tests. Every inbound
 * frame is queued; `next()` can wait for a message that arrived earlier or
 * for a future one, which keeps tests free of arbitrary sleeps.
 */
export class TestClient {
  private socket: WebSocket | null = null;
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private closeListeners = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly origin?: string,
  ) {}

  async connect(): Promise<void> {
    const options = this.origin ? { headers: { Origin: this.origin } } : undefined;
    const socket = new WebSocket(
      this.url,
      options as unknown as string[] | undefined,
    );
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 4_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          this.closed = true;
          reject(new Error("WebSocket failed to open"));
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      this.deliver(parsed);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const listener of this.closeListeners) listener();
      this.closeListeners.clear();
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("WebSocket closed while waiting for a message"));
      }
    });
  }

  get isClosed(): boolean {
    return this.closed || this.socket?.readyState !== WebSocket.OPEN;
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Cannot send: socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(raw: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Cannot send: socket is not open");
    }
    this.socket.send(raw);
  }

  sendBinary(bytes: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Cannot send: socket is not open");
    }
    this.socket.send(bytes);
  }

  async next<T extends MessageType>(
    type: T,
    timeoutMs = 4_000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const message = await this.nextWhere(
      (candidate) => candidate.t === type,
      timeoutMs,
      `message of type "${type}"`,
    );
    return message as Extract<ServerMessage, { t: T }>;
  }

  async nextWhere(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 4_000,
    label = "matching message",
  ): Promise<ServerMessage> {
    const index = this.inbox.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.inbox.splice(index, 1);
      return message;
    }

    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${label}; inbox has ${this.inbox
              .map((message) => message.t)
              .join(", ") || "nothing"}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async waitForClose(timeoutMs = 4_000): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
      this.closeListeners.add(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private deliver(message: ServerMessage): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.inbox.push(message);
    // Bound memory if a test never drains a noisy snapshot stream.
    if (this.inbox.length > 400) this.inbox.splice(0, this.inbox.length - 400);
  }
}

/** Await a client event with a hard timeout, collecting parsed frames. */
export async function until(
  client: TestClient,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 4_000,
): Promise<ServerMessage> {
  return client.nextWhere(predicate, timeoutMs);
}
