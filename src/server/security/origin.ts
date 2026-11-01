import type { AppConfig } from "../config";

export interface OriginCheck {
  allowed: boolean;
  reason: string;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

/**
 * WebSocket handshakes are validated against the request Host (plus
 * X-Forwarded-Host when behind a proxy) and any explicitly configured
 * origins. Requests without an Origin header (native clients, tests, load
 * tools) are allowed: only browsers attach Origin, and stripping it is not
 * possible from page JavaScript.
 */
export function checkWsOrigin(
  originHeader: string | null,
  hostHeader: string | null,
  forwardedHostHeader: string | null,
  config: Pick<AppConfig, "publicOrigin" | "allowedOrigins" | "isProduction">,
): OriginCheck {
  if (!originHeader) {
    return { allowed: true, reason: "no-origin-header" };
  }
  if (originHeader === "null") {
    return { allowed: false, reason: "null-origin" };
  }

  const origin = normalizeOrigin(originHeader);
  if (!origin) {
    return { allowed: false, reason: "malformed-origin" };
  }

  if (config.allowedOrigins.includes(origin)) {
    return { allowed: true, reason: "allow-list" };
  }

  if (config.publicOrigin) {
    const publicOrigin = normalizeOrigin(config.publicOrigin);
    if (publicOrigin && publicOrigin === origin) {
      return { allowed: true, reason: "public-origin" };
    }
  }

  const hosts = [hostHeader, forwardedHostHeader?.split(",")[0]?.trim()]
    .filter((host): host is string => typeof host === "string" && host.length > 0)
    .map((host) => host.toLowerCase());

  for (const host of hosts) {
    if (normalizeOrigin(`http://${host}`) === origin || normalizeOrigin(`https://${host}`) === origin) {
      return { allowed: true, reason: "same-host" };
    }
  }

  // Development convenience: Vite often proxies /ws while preserving Host,
  // but some proxies rewrite the port. Allow loopback/LAN origins outside
  // production as long as the origin host is a private/local address.
  if (!config.isProduction) {
    try {
      const originHost = new URL(origin).hostname;
      if (isLoopback(originHost) || isPrivateIpv4(originHost)) {
        return { allowed: true, reason: "development-lan" };
      }
    } catch {
      // Ignore — falls through to rejection.
    }
  }

  return { allowed: false, reason: "origin-mismatch" };
}
