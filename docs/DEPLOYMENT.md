# Deployment

NEON RIFT ships as one Bun process that serves the built client and the WebSocket endpoint on the same origin. There is no separate frontend host and no database to provision.

- HTTP: `/`, `/assets/*`, `/healthz`, `/api/status`
- WebSocket: `/ws` on the same host and port
- State: in memory, single process (see [scaling](#scaling))

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. Railway/Fly inject this automatically. |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a local reverse proxy if desired. |
| `NODE_ENV` | `development` | Set to `production` for strict origin checks and production behavior. |
| `PUBLIC_ORIGIN` | unset | Exact public origin, e.g. `https://neon-rift.up.railway.app`. Recommended behind proxies that rewrite Host. |
| `ALLOWED_ORIGINS` | unset | Comma-separated extra origins allowed to open `/ws`. |
| `ENABLE_TEST_ENDPOINTS` | `0` | **Never enable in production.** Exposes `POST /api/test/finish` for browser tests. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

`PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` only affect WebSocket origin validation. If the reverse proxy preserves the original `Host` (or sets `X-Forwarded-Host`), same-host origin checks already succeed. When in doubt, set `PUBLIC_ORIGIN`.

## Option A — Docker

The repository includes a multi-stage `Dockerfile`:

- Stage 1 installs locked dependencies and runs `vite build`.
- Stage 2 contains only Bun, the server/shared sources, `package.json` and `dist/client`; no `node_modules` at runtime.
- Runs as the non-root `bun` user with a `/healthz` health check.

```bash
docker build -t neon-rift-arena .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  neon-rift-arena
```

Open `http://localhost:3000`.

Or with Compose:

```bash
cp .env.example .env
# edit PUBLIC_ORIGIN if you are not using http://localhost:3000
docker compose up --build
```

> **Verification note:** the Dockerfile and Compose file are provided, but the Docker daemon was not running on the development machine, so the image build was **not executed locally**. The CI workflow contains a `docker build` job, which will exercise it on GitHub Actions. Do not treat the Docker path as locally verified.

## Option B — Railway

`railway.json` selects the Dockerfile and `/healthz` as the health check.

1. Push this repository to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, choose the repository.
3. Railway builds the Dockerfile and injects `PORT`. Set the service variables:
   - `NODE_ENV=production`
   - `PUBLIC_ORIGIN=https://<your-domain>` (use the Railway-generated domain or your custom domain)
   - `LOG_LEVEL=info`
   - Leave `ENABLE_TEST_ENDPOINTS` unset/`0`.
4. In **Settings → Networking**, click **Generate Domain** (or add a custom domain).
5. Open the HTTPS URL. The browser upgrades to `wss://<domain>/ws` automatically because the page is HTTPS.

Railway terminates TLS at its edge and forwards HTTP/WebSocket upgrades to the container. No extra WebSocket configuration is required. Health checks hit `/healthz`; live metrics are at `/api/status`.

### Custom domain

Add the domain in Railway, point DNS as instructed, then update `PUBLIC_ORIGIN` to the exact `https://` origin and redeploy. If you also serve the app from a second hostname, add it to `ALLOWED_ORIGINS` (comma-separated).

## Option C — Any VPS with a reverse proxy

Run the production build under a process manager:

```bash
bun install --frozen-lockfile
bun run build
NODE_ENV=production PORT=3000 PUBLIC_ORIGIN=https://neon.example.com bun run start
```

### Caddy

Caddy obtains certificates automatically and proxies WebSockets without extra directives:

```caddyfile
neon.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

### Nginx

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl http2;
  server_name neon.example.com;

  ssl_certificate     /etc/letsencrypt/live/neon.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/neon.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 120s;
  }
}
```

`proxy_read_timeout` should exceed the server's 120 s WebSocket idle timeout. Set `PUBLIC_ORIGIN=https://neon.example.com` if Host rewriting is possible.

## LAN play

The server binds `0.0.0.0` by default. Share `http://<host-lan-ip>:3000` with devices on the same network. Browsers accept `ws://` on LAN IPs, so no TLS is needed. Ensure the host firewall allows TCP 3000.

For internet play from a home network, prefer a tunnel or reverse proxy with TLS (Caddy, Cloudflare Tunnel, Tailscale Funnel) rather than exposing plain HTTP. Browsers on HTTPS pages cannot open `ws://` sockets (mixed content).

## Operations

### Health and metrics

```bash
curl -fsS https://<host>/healthz
curl -fsS https://<host>/api/status
```

`/healthz` is intentionally small. `/api/status` returns room/player counts, message totals, invalid/rate-limited totals, match counters, rolling tick timings, RSS/heap and error count. It never returns room codes, player names or tokens.

### Logs

Logs are structured single-line JSON-ish records with levels. `LOG_LEVEL=debug` adds per-socket detail; `warn` is a good production default. Session tokens are redacted.

### Restarts

Rooms, sessions and matches are in memory. A deploy/restart disconnects everyone and destroys active matches. Clients reconnect automatically but the server has no room to restore, so they land back on the menu. Plan updates between matches or accept the interruption.

### Test endpoint

`POST /api/test/finish` is used by Playwright to end a match deterministically. It returns 404 unless `ENABLE_TEST_ENDPOINTS=1`. It must never be enabled on a public deployment.

## Scaling

The process is the room authority. To run more than one instance you need one of:

- **Sticky routing** by room code so every member of a room reaches the same instance, with no shared state; or
- A shared room/session store and a room-ownership protocol (not implemented).

Quick Match also scans local rooms only, so multiple instances can create separate public lobbies that are invisible to each other. For the target scale (2–8 players per room), a single instance measured 32 clients across 4 rooms at ~3 ms average tick cost on a 6-core Windows machine. Capacity planning should include snapshot bandwidth (~75 KB/s per full 8-player room, measured) and the 250-room process cap.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Page loads but never connects, console shows WS 403 | `PUBLIC_ORIGIN`/Host mismatch or an unknown proxy origin. Set `PUBLIC_ORIGIN` to the exact browser origin. |
| WS works on HTTP but not HTTPS | Proxy is not forwarding the `Upgrade`/`Connection` headers, or the page uses `ws://` from HTTPS. |
| 404 on `/` or “frontend not built” | `dist/client` is missing. Run `bun run build` before starting, or use the Docker image. |
| “The rift network is at capacity” | 250 live rooms in this process. Wait for rooms to close or scale out. |
| Everyone reconnects to the menu after a deploy | Expected: in-memory state does not survive restarts. |
| E2E server will not start | Port 3100 is occupied, or `dist/client` is stale. `bun run test:e2e` rebuilds and uses loopback only. |
