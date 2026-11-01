import { MAX_MESSAGE_BYTES, NAME_MAX_LENGTH, NAME_MIN_LENGTH, PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "./constants";
import type { RoomSettings } from "./game-rules";
import type { ClientMessage } from "./types";

export const ERROR_CODES = {
  INVALID_MESSAGE: "invalid_message",
  UNSUPPORTED_VERSION: "unsupported_version",
  RATE_LIMITED: "rate_limited",
  NOT_IDENTIFIED: "not_identified",
  ALREADY_IDENTIFIED: "already_identified",
  INVALID_NAME: "invalid_name",
  IN_ROOM: "in_room",
  NOT_IN_ROOM: "not_in_room",
  ROOM_NOT_FOUND: "room_not_found",
  ROOM_FULL: "room_full",
  ROOM_STARTED: "room_started",
  NOT_HOST: "not_host",
  INVALID_SETTINGS: "invalid_settings",
  INVALID_INPUT: "invalid_input",
  SERVER_FULL: "server_full",
  SESSION_TAKEOVER: "session_takeover",
  INTERNAL: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: ErrorCode; message: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F<>"]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const length = [...cleaned].length;
  if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH) return null;
  // Require at least one letter or number so a wall of punctuation is rejected.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return cleaned;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (cleaned.length !== ROOM_CODE_LENGTH) return null;
  for (const char of cleaned) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return null;
  }
  return cleaned;
}

function parseRoomSettings(value: unknown, requireAll: boolean): RoomSettings | null {
  if (!isObject(value)) return null;

  const keys = Object.keys(value);
  const allowed = new Set(["maxPlayers", "durationSec", "scoreLimit"]);
  for (const key of keys) {
    if (!allowed.has(key)) return null;
  }

  const { maxPlayers, durationSec, scoreLimit } = value;

  if (requireAll) {
    if (!isInteger(maxPlayers, 2, 8)) return null;
    if (!isInteger(durationSec, 30, 300)) return null;
    if (!isInteger(scoreLimit, 0, 100)) return null;
    return { maxPlayers, durationSec, scoreLimit };
  }

  if (maxPlayers !== undefined && !isInteger(maxPlayers, 2, 8)) return null;
  if (durationSec !== undefined && !isInteger(durationSec, 30, 300)) return null;
  if (scoreLimit !== undefined && !isInteger(scoreLimit, 0, 100)) return null;

  return {
    maxPlayers: (maxPlayers as number | undefined) ?? 8,
    durationSec: (durationSec as number | undefined) ?? 180,
    scoreLimit: (scoreLimit as number | undefined) ?? 30,
  };
}

/**
 * Strict parser for every inbound frame. Returns typed errors instead of
 * throwing; the caller decides whether to close the socket.
 */
export function parseClientMessage(raw: unknown): ParseResult {
  if (typeof raw !== "string") {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Binary frames are not supported." };
  }
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Message exceeds the size limit." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Malformed JSON." };
  }

  if (!isObject(parsed)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Message must be a JSON object." };
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: ERROR_CODES.UNSUPPORTED_VERSION,
      message: `Protocol version ${PROTOCOL_VERSION} required.`,
    };
  }

  const type = parsed.t;
  if (typeof type !== "string") {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Missing message type." };
  }

  switch (type) {
    case "identify": {
      if (parsed.token !== undefined && (typeof parsed.token !== "string" || parsed.token.length > 128)) {
        return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Invalid session token." };
      }
      if (parsed.name !== undefined && (typeof parsed.name !== "string" || parsed.name.length > 64)) {
        return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Invalid name." };
      }
      const name = parsed.name === undefined ? undefined : sanitizeName(parsed.name);
      if (parsed.name !== undefined && name === null) {
        return { ok: false, code: ERROR_CODES.INVALID_NAME, message: "Choose a name of 2–16 characters." };
      }
      return {
        ok: true,
        message: {
          t: "identify",
          v: PROTOCOL_VERSION,
          token: parsed.token as string | undefined,
          name: name ?? undefined,
        },
      };
    }

    case "create_room": {
      if (!isBoolean(parsed.isPrivate)) {
        return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "isPrivate must be a boolean." };
      }
      let settings: RoomSettings | undefined;
      if (parsed.settings !== undefined) {
        const result = parseRoomSettings(parsed.settings, false);
        if (!result) {
          return { ok: false, code: ERROR_CODES.INVALID_SETTINGS, message: "Invalid room settings." };
        }
        settings = result;
      }
      return {
        ok: true,
        message: { t: "create_room", v: PROTOCOL_VERSION, isPrivate: parsed.isPrivate, settings },
      };
    }

    case "join_room": {
      const code = normalizeRoomCode(parsed.code);
      if (!code) {
        return { ok: false, code: ERROR_CODES.ROOM_NOT_FOUND, message: "That room code is not valid." };
      }
      return { ok: true, message: { t: "join_room", v: PROTOCOL_VERSION, code } };
    }

    case "quick_match":
      return { ok: true, message: { t: "quick_match", v: PROTOCOL_VERSION } };

    case "leave_room":
      return { ok: true, message: { t: "leave_room", v: PROTOCOL_VERSION } };

    case "set_ready": {
      if (!isBoolean(parsed.ready)) {
        return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "ready must be a boolean." };
      }
      return { ok: true, message: { t: "set_ready", v: PROTOCOL_VERSION, ready: parsed.ready } };
    }

    case "update_settings": {
      const settings = parseRoomSettings(parsed.settings, true);
      if (!settings) {
        return { ok: false, code: ERROR_CODES.INVALID_SETTINGS, message: "Invalid room settings." };
      }
      return { ok: true, message: { t: "update_settings", v: PROTOCOL_VERSION, settings } };
    }

    case "start_match":
      return { ok: true, message: { t: "start_match", v: PROTOCOL_VERSION } };

    case "input": {
      if (!isInteger(parsed.seq, 0, 2_147_483_647)) {
        return { ok: false, code: ERROR_CODES.INVALID_INPUT, message: "Invalid input sequence." };
      }
      if (!isNumberInRange(parsed.moveX, -1, 1) || !isNumberInRange(parsed.moveY, -1, 1)) {
        return { ok: false, code: ERROR_CODES.INVALID_INPUT, message: "Invalid movement vector." };
      }
      if (!isFiniteNumber(parsed.aim) || Math.abs(parsed.aim) > 100) {
        return { ok: false, code: ERROR_CODES.INVALID_INPUT, message: "Invalid aim angle." };
      }
      if (!isBoolean(parsed.fire) || !isBoolean(parsed.dash)) {
        return { ok: false, code: ERROR_CODES.INVALID_INPUT, message: "Invalid input buttons." };
      }
      return {
        ok: true,
        message: {
          t: "input",
          v: PROTOCOL_VERSION,
          seq: parsed.seq,
          moveX: parsed.moveX,
          moveY: parsed.moveY,
          aim: parsed.aim,
          fire: parsed.fire,
          dash: parsed.dash,
        },
      };
    }

    case "ping": {
      if (!isInteger(parsed.id, 0, 2_147_483_647) || !isFiniteNumber(parsed.clientTime)) {
        return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Invalid ping." };
      }
      return {
        ok: true,
        message: { t: "ping", v: PROTOCOL_VERSION, id: parsed.id, clientTime: parsed.clientTime },
      };
    }

    case "rematch":
      return { ok: true, message: { t: "rematch", v: PROTOCOL_VERSION } };

    case "return_to_lobby":
      return { ok: true, message: { t: "return_to_lobby", v: PROTOCOL_VERSION } };

    case "set_name": {
      const name = sanitizeName(parsed.name);
      if (!name) {
        return { ok: false, code: ERROR_CODES.INVALID_NAME, message: "Choose a name of 2–16 characters." };
      }
      return { ok: true, message: { t: "set_name", v: PROTOCOL_VERSION, name } };
    }

    default:
      return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: "Unknown message type." };
  }
}

export function serializeServerMessage(message: unknown): string {
  return JSON.stringify(message);
}
