# Architecture

NEON RIFT is intentionally a small number of clear layers. The browser renders and predicts; the Bun process simulates and decides. There is no second source of truth.

```
┌──────────────────────────── browser ────────────────────────────┐
│ index.html + CSS                                                │
│ NeonRiftApp (menus, lobby, HUD, results, settings, audio)       │
│ NetClient ── JSON over WebSocket ──┐                            │
│ Phaser: Boot / Ambient / Arena     │                            │
│   ArenaScene: prediction, interpolation, input sampling (30 Hz)  │
└────────────────────────────────────┼────────────────────────────┘
                                     │ /ws
┌────────────────────────────────────▼────────────────────────────┐
│ Bun.serve                                                       │
│  app.ts: static SPA + /healthz + /api/status + WS upgrade       │
│  GameServer: connections → sessions → rooms → matches            │
│    · tick loop 30 Hz (accumulator, max 8 catch-up steps)         │
│    · snapshot every 2 ticks = 15 Hz per room                     │
│    · sweep every 5 s (reconnect grace, empty rooms, sessions)    │
│  Match: deterministic fixed-step simulation                      │
│  Room / RoomManager / Matchmaker: pure in-memory state           │
└──────────────────────────────────────────────────────────────────┘
```

## Runtime topology

One Bun process owns everything:

- HTTP `GET /` and extension-less HTML paths serve the SPA shell.
- `GET /aftermath.html` serves the separate 3D entry; its assets are hashed under `/assets/*` like the arena bundle.
- Hashed assets under `/assets/*` are immutable for one year; all other files are `no-cache`.
- `GET /healthz` returns a minimal health document for orchestrators.
- `GET /api/status` exposes live metrics without names, tokens or room codes.
- WebSocket upgrades happen at `/ws`; any other upgrade path is rejected.

The production build is `dist/client`, produced by Vite with Phaser and Three.js split into their own long-lived chunks. The server starts without the build but then reports that the frontend is unavailable, so `bun run build` is part of the production flow.

## Simulation model

`Match` is a fixed-step, deterministic state machine. It never reads the wall clock: one call to `step()` advances exactly one 1/30 s tick. Room timing (auto-start, reconnect grace, sweep) is wall-clock based and lives in `GameServer`/`Room`.

Match phases:

1. `countdown` — 3 s; movement is locked, spawn protection arms when live.
2. `playing` — timer and scoring run. Ends on `durationSec`, on reaching `scoreLimit` (0 disables), or on an abort.
3. `finished` — immutable results are computed once; the room retains the match for rematch/results.

Per tick the simulation:

1. Applies each player's last input if it is younger than the activity window; otherwise decays to idle.
2. Normalizes the move vector (`length ≤ 1`), applies walk speed or dash speed.
3. Sweeps movement with circle-vs-rectangle and circle-vs-circle resolution against obstacles and arena bounds.
4. Fires on request when the weapon cooldown allows, spawning projectiles at the muzzle offset.
5. Sweeps projectiles against obstacles, then players; applies damage, kills, score, respawn timers and spawn protection.
6. Resolves crystal pickups and respawn schedule.
7. Advances the timer and finishes on time or score limit.
8. Collects FX events (`shot`, `hit`, `kill`, `wall`, `crystal`, `dash`, `respawn`, `match_live`) for the next snapshot.

Spawns are picked from eight authored points with randomized order. The RNG is injectable, which keeps tests deterministic.

`buildSnapshot(tick)` emits a compact world view: round player positions, hp, score, kills, deaths, crystals, alive/connected flags, dash cooldown fraction, spawn-protection remainder, projectiles, crystals, FX and per-player input acknowledgements.

## Input, prediction and reconciliation

The client samples input at 30 Hz. Each frame carries a monotonically increasing `seq`, a normalized move vector, a finite aim angle, and `fire`/`dash` booleans. The server rejects non-integer/negative sequences and out-of-range values, ignores `seq ≤ lastSeq`, and records the ack in snapshots.

`ArenaScene` runs the same shared movement and collision functions locally:

- Local movement is applied immediately for responsiveness.
- Every input frame is stored in a short history along with its sequence.
- When a snapshot arrives, the scene restores the authoritative position and replays unacknowledged inputs.
- Resulting error is rendered as a decaying visual offset rather than a snap.
- Remote pilots are interpolated with a 95 ms delay and extrapolated briefly if a snapshot is late.

Dash and spawn protection visual states are derived from authoritative fields (`dashReadyAt`, `protectedUntil` in server state, `spawnProtMs` in snapshots), so prediction cannot grant an extra dash.

## Networking protocol

All frames are JSON text. Shared types in `src/shared/types.ts` describe every message; `src/shared/protocol.ts` is the only parser.

Client → server:

| Type | Purpose |
| --- | --- |
| `identify` | Optional session token + sanitized callsign |
| `set_name` | Rename while connected |
| `create_room` | Private/public room + partial settings |
| `quick_match` | Join the first open public room or create one |
| `join_room` | Six-character code |
| `leave_room` | Voluntary exit |
| `set_ready` | Lobby readiness |
| `update_settings` | Host-only full settings object |
| `start_match` | Host-only |
| `input` | Movement/aim/fire/dash with sequence number |
| `ping` | RTT probe with client clock |
| `rematch` | Any room member |
| `return_to_lobby` | Host-only after a match |

Server → client:

| Type | Purpose |
| --- | --- |
| `welcome` | Identity, session token, optional room/match/results resume |
| `room_state` | Roster, host, phase, settings, auto-start deadline |
| `match_start` | Roster, arena, duration, score limit, countdown |
| `snapshot` | World state + FX + input acks |
| `match_end` | Results with rankings, winners, reason |
| `pong` | RTT response |
| `error` | Stable code + human message + fatal flag |
| `notice` | Non-fatal server announcements |
| `left_room` | Room exit confirmation |

`v` is required on every client message and must equal the shared `PROTOCOL_VERSION` (currently 1). Unknown types, wrong versions and malformed shapes are rejected with typed error codes.

## Rooms, matchmaking and lifecycle

- `RoomManager` generates six-character codes from a confusion-free alphabet and caps the process at 250 rooms.
- Private rooms wait for the host. Public rooms schedule an 8 s auto-start, broadcast the deadline and reset it if the lobby empties.
- Quick Match reuses a public lobby with capacity before creating a new one.
- Settings: `maxPlayers` 2–8, `durationSec` 30–300 (presets 60/120/180/300), `scoreLimit` 0/15/30/50 (0 = off). Only the host can edit them.
- A match needs at least one connected player. `start_match` snapshots the connected roster.
- On disconnect the player stays in the room as `connected: false`, stops simulating (no drift, no firing) and keeps a 30 s grace window. Reconnecting with the session token flips them back on. After the window, the player is removed from the match/roster.
- Empty rooms are removed immediately on voluntary leave; disconnected-only rooms are swept after the grace/TTL rules.
- A finished room keeps results for rematch or return-to-lobby; abandoned finished rooms are swept after 10 minutes.

## Security boundaries

| Boundary | Control |
| --- | --- |
| Transport | Same-origin production serving; WSS when the site is HTTPS |
| Upgrade | Origin allow-list + Host/`X-Forwarded-Host` matching; `null` origin rejected |
| Message size | Bun `maxPayloadLength` 8 KiB + explicit length check |
| Rate | One token bucket per socket (120/s, burst 240); 12 rate strikes close |
| Abuse | 8 invalid frames close the socket; binary frames rejected |
| Identity | 32-byte random session token; replay takes over the session and closes the old socket |
| Names | Unicode-aware sanitization, 2–16 visible characters, control/bidi/zero-width stripped |
| Static files | Decoded path validation, NUL/backslash rejection, resolved-path confinement, no directory serving |
| Headers | CSP, `nosniff`, `DENY` framing, no-referrer, restrictive permissions policy |
| Test surface | `/api/test/finish` only when `ENABLE_TEST_ENDPOINTS=1` |

Rate limiting is intentionally per connection, not per IP: one abusive socket cannot exhaust another player's budget. A shared-NAT crowd still gets one bucket per socket.

## Observability

`/api/status` exposes uptime, live rooms/players, connection totals, message totals, invalid/rate-limited counts, match totals, a rolling 300-sample tick window (avg/max/last/age), RSS/heap and error count. The logger redacts tokens and session identifiers and supports `debug|info|warn|error|silent`.

## Scaling boundary

The design is a single authoritative process by choice. Horizontal scaling would require shared room ownership or sticky routing and a shared session store; neither exists. For the intended 2–8 player rooms, the measured cost is low (32 clients / 4 rooms averaged ~3 ms of tick work on this machine). A production multi-instance deployment should shard rooms by code and route WebSocket upgrades consistently.

## AFTERMATH 3D client

AFTERMATH is a second, independent Vite entry (`aftermath.html` → `src/aftermath/main.ts`) served by the same Bun process. It deliberately sits outside the authoritative model above:

- **No server authority.** There is no WebSocket, room or match state for this mode. The browser simulates the player, 10 initial hostiles, 4 hack-triggered reinforcements, 3 AI allies, bullets, effects and the mission clock in a single tab.
- **Pure core modules.** Ballistics, loadouts, mission timing, rank and contract math live in Three.js-free modules (`ballistics.ts`, `roles.ts`, `mission.ts`, `meta.ts` and friends) so `tests/aftermath.test.ts` can exercise them without a GPU or DOM.
- **Rendering boundary.** `world.ts` builds the static city block, `actor.ts`/`player.ts`/`ai.ts` animate actors, `effects.ts` pools tracers/sparks/flashes, and `hud.ts`/`planning.ts` own DOM overlays. Three.js is code-split into its own chunk and never loaded by the arena page.
- **Deterministic test hooks.** `window.__aftermath` exposes deploy/teleport/objective controls used by Playwright; normal gameplay does not depend on them.
- **Persistence.** Pilot meta (callsign, XP, credits, rank, contract state) lives in `localStorage`; nothing is sent to the server.

