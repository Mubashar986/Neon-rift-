export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

const SECRET_KEY = /token|secret|authorization|cookie|password|sessionid/i;

function redact(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_KEY.test(key)) {
      output[key] = "[redacted]";
    } else if (typeof value === "string" && value.length > 160) {
      output[key] = `${value.slice(0, 157)}…`;
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const emit = (kind: Exclude<LogLevel, "silent">, message: string, details?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[kind] < threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    const prefix = `[${time}] ${kind.toUpperCase().padEnd(5)} ${message}`;
    const safe = redact(details);
    if (safe && Object.keys(safe).length > 0) {
      console.log(prefix, safe);
    } else {
      console.log(prefix);
    }
  };

  return {
    debug: (message, details) => emit("debug", message, details),
    info: (message, details) => emit("info", message, details),
    warn: (message, details) => emit("warn", message, details),
    error: (message, details) => emit("error", message, details),
  };
}
