/**
 * Global constants shared by the browser client and the Bun server.
 * Nothing in this file may depend on a runtime-specific API.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Authoritative simulation frequency. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

/** Snapshots are produced every second simulation tick → 15 Hz. */
export const SNAPSHOT_INTERVAL_TICKS = 2;
export const SNAPSHOT_RATE = TICK_RATE / SNAPSHOT_INTERVAL_TICKS;

/** Networking limits. */
export const MAX_MESSAGE_BYTES = 8 * 1024;
export const MAX_MESSAGES_PER_SECOND = 120;
export const RATE_LIMIT_BURST = 240;
export const PING_INTERVAL_MS = 2_000;

/** Rooms. */
export const MAX_PLAYERS_PER_ROOM = 8;
export const MIN_PLAYERS_PER_ROOM = 1;
export const ROOM_CODE_LENGTH = 6;
/** Confusable characters (0/O, 1/I) deliberately removed. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RECONNECT_GRACE_MS = 30_000;
export const EMPTY_ROOM_TTL_MS = 60_000;
export const FINISHED_ROOM_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 10 * 60_000;
export const AUTO_START_DELAY_MS = 8_000;
export const MAX_ROOMS = 250;

/** Identity. */
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 16;

/** Client input submission rate. */
export const INPUT_HZ = 30;
export const INPUT_INTERVAL_MS = 1000 / INPUT_HZ;

/** Server housekeeping cadence. */
export const SWEEP_INTERVAL_MS = 5_000;

export const DEFAULT_SERVER_PORT = 3000;
