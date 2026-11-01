import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  normalizeRoomCode,
  parseClientMessage,
  sanitizeName,
} from "../../src/shared/protocol";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "../../src/shared/constants";

function parse(value: unknown) {
  return parseClientMessage(typeof value === "string" ? value : JSON.stringify(value));
}

describe("name sanitization", () => {
  test("trims and collapses whitespace", () => {
    expect(sanitizeName("  Neon   Rift  ")).toBe("Neon Rift");
  });

  test("strips control characters, markup and zero-width characters", () => {
    expect(sanitizeName("Ne\u0000o\u200b<>\u202eRift")).toBe("NeoRift");
  });

  test("keeps unicode letters", () => {
    expect(sanitizeName("Ægir_Ø")).toBe("Ægir_Ø");
    expect(sanitizeName("ネオン")).toBe("ネオン");
  });

  test("rejects names that are too short, too long or punctuation only", () => {
    expect(sanitizeName("a")).toBeNull();
    expect(sanitizeName("ab")).toBe("ab");
    expect(sanitizeName("x".repeat(17))).toBeNull();
    expect(sanitizeName("}}}!!!")).toBeNull();
    expect(sanitizeName(42)).toBeNull();
  });
});

describe("room codes", () => {
  test("normalizes case and whitespace", () => {
    expect(normalizeRoomCode(" nx7k2q ")).toBe("NX7K2Q");
  });

  test("rejects confusable and out-of-alphabet characters", () => {
    expect(normalizeRoomCode("ABCI23")).toBeNull();
    expect(normalizeRoomCode("ABC0O1")).toBeNull();
    expect(normalizeRoomCode("ABC12")).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
  });
});

describe("protocol parser", () => {
  test("rejects binary and malformed frames", () => {
    const binary = parseClientMessage(new Uint8Array([1, 2, 3]));
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.code).toBe(ERROR_CODES.INVALID_MESSAGE);

    const malformed = parse("{not json");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe(ERROR_CODES.INVALID_MESSAGE);
  });

  test("enforces the protocol version", () => {
    const result = parse({ t: "quick_match", v: PROTOCOL_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.UNSUPPORTED_VERSION);
  });

  test("rejects unknown and untyped messages", () => {
    for (const payload of [{ v: PROTOCOL_VERSION }, { t: "hack", v: PROTOCOL_VERSION }]) {
      const result = parse(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_MESSAGE);
    }
  });

  test("rejects oversized frames before parsing", () => {
    const result = parse("x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_MESSAGE);
  });

  test("identify sanitizes the name", () => {
    const result = parse({ t: "identify", v: PROTOCOL_VERSION, name: "  Neo  " });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.t === "identify") {
      expect(result.message.name).toBe("Neo");
      expect(result.message.token).toBeUndefined();
    }
  });

  test("identify rejects invalid names and tokens", () => {
    expect(parse({ t: "identify", v: PROTOCOL_VERSION, name: "!" }).ok).toBe(false);
    const token = parse({ t: "identify", v: PROTOCOL_VERSION, token: "x".repeat(129) });
    expect(token.ok).toBe(false);
  });

  test("create_room requires a boolean privacy flag", () => {
    expect(parse({ t: "create_room", v: PROTOCOL_VERSION }).ok).toBe(false);
    const result = parse({
      t: "create_room",
      v: PROTOCOL_VERSION,
      isPrivate: true,
      settings: { maxPlayers: 4 },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.t === "create_room") {
      // Partial settings are filled from defaults.
      expect(result.message.settings).toEqual({ maxPlayers: 4, durationSec: 180, scoreLimit: 30 });
    }
  });

  test("create_room rejects unknown or out-of-range settings", () => {
    for (const settings of [
      { maxPlayers: 99 },
      { durationSec: 5 },
      { scoreLimit: 1_000 },
      { difficulty: "nightmare" },
    ]) {
      const result = parse({
        t: "create_room",
        v: PROTOCOL_VERSION,
        isPrivate: false,
        settings,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_SETTINGS);
    }
  });

  test("join_room normalizes the code", () => {
    const result = parse({ t: "join_room", v: PROTOCOL_VERSION, code: " nx7k2q " });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.t === "join_room") {
      expect(result.message.code).toBe("NX7K2Q");
    }
  });

  test("input validation blocks cheats and malformed vectors", () => {
    const base = {
      t: "input",
      v: PROTOCOL_VERSION,
      seq: 1,
      moveX: 0,
      moveY: 0,
      aim: 0,
      fire: false,
      dash: false,
    };
    expect(parse(base).ok).toBe(true);

    for (const patch of [
      { seq: -1 },
      { seq: 1.5 },
      { moveX: 1.5 },
      { moveY: Number.NaN },
      { aim: Number.POSITIVE_INFINITY },
      { aim: 500 },
      { fire: "yes" },
      { dash: 1 },
    ]) {
      const result = parse({ ...base, ...patch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_INPUT);
    }
  });

  test("ping validates id and client clock", () => {
    expect(parse({ t: "ping", v: PROTOCOL_VERSION, id: 0, clientTime: 0 }).ok).toBe(true);
    expect(parse({ t: "ping", v: PROTOCOL_VERSION, id: -1, clientTime: 0 }).ok).toBe(false);
    expect(parse({ t: "ping", v: PROTOCOL_VERSION, id: 1, clientTime: Number.NaN }).ok).toBe(false);
  });

  test("update_settings requires the full object", () => {
    const partial = parse({
      t: "update_settings",
      v: PROTOCOL_VERSION,
      settings: { maxPlayers: 4 },
    });
    expect(partial.ok).toBe(false);

    const full = parse({
      t: "update_settings",
      v: PROTOCOL_VERSION,
      settings: { maxPlayers: 4, durationSec: 60, scoreLimit: 15 },
    });
    expect(full.ok).toBe(true);
  });

  test("set_name applies the same name policy", () => {
    const sanitized = parse({ t: "set_name", v: PROTOCOL_VERSION, name: "<script>" });
    expect(sanitized.ok).toBe(true);
    if (sanitized.ok && sanitized.message.t === "set_name") {
      expect(sanitized.message.name).toBe("script");
    }
    expect(parse({ t: "set_name", v: PROTOCOL_VERSION, name: "!!!" }).ok).toBe(false);
    const ok = parse({ t: "set_name", v: PROTOCOL_VERSION, name: "Vector" });
    expect(ok.ok).toBe(true);
  });
});
