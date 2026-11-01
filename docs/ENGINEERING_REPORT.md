# NEON RIFT: ARENA — Engineering Report

**Version:** 1.0.0 (with the AFTERMATH 3D addendum)  
**Report date:** 1 November 2026  
**Author:** Engineering self-assessment  
**Environment:** Windows 11 (10.0.26300), 6 logical CPUs, Bun 1.4.4, Node 24.20.0 (Playwright runner only), Chromium 156

This report separates **what was verified on this machine** from **what was prepared but not executed**. It is a record of the actual build, test output, browser runs and load measurements — not a projection.

---

## 1. Summary

NEON RIFT: ARENA is a complete, playable 2–8 player browser arena shooter with a Bun authoritative server, a Phaser 3 client, and a typed WebSocket protocol. The repository includes the game, a production build, deployment assets (Docker, Railway, reverse proxy), CI, unit/integration tests, Playwright E2E tests, a load-test harness, and documentation.

**Verified locally:**

- Strict TypeScript compiles cleanly.
- 116 Bun tests pass (63 unit + 26 integration + 27 AFTERMATH), 469 assertions.
- The DOM contract audit passes: 112 ids in `index.html`, 98 referenced, 0 missing.
- The Playwright suite passes 7/7 in one run: four arena tests (including a two-browser invite/rematch flow and an emulated iPhone) and three AFTERMATH tests (full success loop, KIA loop, touch notice).
- The production bundle builds and serves from one Bun process over a single origin; `/healthz`, `/api/status`, `/`, `/play?room=…`, `/aftermath.html`, hashed assets and 404 behaviour were exercised over HTTP.
- Five real WebSocket load runs (2, 4, 8, 16 and 32 clients) were recorded with JSON reports.
- The AFTERMATH 3D vertical slice runs its full loop in Chromium: planning → deploy → terminal hack → extraction → results → redeploy, plus the KIA path. A headed real-GPU probe measured 27–28 fps at 1440×900 with 813 draw calls.

**Not verified locally:**

- A Docker image build — the local Docker daemon was unavailable.
- A real public-internet deployment — no domain, TLS certificate or hosting credentials were used.
- Physical phones/tablets — mobile was tested with Playwright's iPhone 13 emulation only.
- Real WAN conditions (latency, loss, jitter) — all load tests ran on loopback.
- AFTERMATH on GPUs/browsers other than this machine's Chromium — the performance numbers come from one GPU, and Firefox/WebKit were not run.

Those gaps are listed again in §8 and must not be read as completed work.

---

## 2. Delivered system

| Area | Implementation |
| --- | --- |
| Server | Bun `Bun.serve` with native WebSockets, one process, in-memory rooms |
| Simulation | Authoritative 30 Hz `Match.step()`; snapshots every 2 ticks (15 Hz) |
| Client | Phaser 3 + TypeScript + Vite; one production bundle served by Bun |
| AFTERMATH | Separate Three.js entry at `/aftermath.html`; client-side single-player extraction prototype (planning, AI, combat, HUD, results, `localStorage` meta) |
| Protocol | JSON text frames, `v: 1`, typed client/server messages, runtime validation |
| Arena | 2400 × 1600 world units, rectangular cover, circular obstacles, core |
| Players | 100 HP, 285 u/s movement, 940 u/s dash (150 ms, 2.4 s cooldown), 20 damage bolts |
| Pickups | 10 crystals across 8 spawn spots, +1 point, 7 s respawn |
| Scoring | +3 per kill, +1 per crystal; timer or score-limit finish; ties share rank 1 |
| Rooms | Six-character codes from an unambiguous alphabet, private/public, 2–8 players |
| Sessions | Opaque 32-byte tokens, 30 s reconnect grace, single-owner replay takeover |
| Controls | WASD + mouse + click/Space; dual-stick touch + FIRE/DASH |
| Deployment | Multi-stage Dockerfile, Compose, Railway config, CI workflow, deployment guide |

---

## 3. Architecture

### 3.1 Process and authority boundary

A single Bun process serves four things on the same origin:

1. The SPA shell (`index.html`, fonts, hashed assets).
2. Operational endpoints (`/healthz`, `/api/status`).
3. The test-only match-finish endpoint, disabled unless `ENABLE_TEST_ENDPOINTS=1`.
4. The WebSocket upgrade at `/ws`.

The browser never mutates authoritative state. It sends a bounded input packet at up to 30 Hz: sequence number, movement vector, aim angle, fire flag, dash flag. The server validates the packet, applies it to the `Match`, and returns snapshots, acknowledgements, room state and match results.

Because state is tick-driven rather than wall-clock-driven, `Match` is deterministic for a fixed input sequence, which is what makes the simulation testable without a browser or a socket.

### 3.2 Simulation loop

- One `setInterval`-style loop runs at 30 Hz and measures each tick.
- Each tick: apply queued inputs, advance projectiles with swept collision, resolve damage/deaths/respawns, resolve crystal pickups, update the timer and score limit, emit FX, then snapshot every second tick.
- Match phases are `countdown` (3 s), `playing` and `finished`.
- Disconnected players stop moving and firing immediately; their pilot remains for the reconnect grace period, then is removed with its projectiles.
- Room lifecycle is swept every 5 s: empty rooms expire after 60 s, finished rooms after 10 min, sessions after 10 min.

### 3.3 Client prediction and reconciliation

The client imports the same movement and collision helpers as the server. It predicts the local pilot, keeps a short input history, and reconciles against each authoritative snapshot. Mismatch is absorbed as a decaying visual offset rather than a snap. Remote players are rendered from an interpolation buffer at roughly 95 ms behind the newest snapshot, which trades a little latency for smoothness on 15 Hz data.

The HUD deliberately renders server values only — health, score, timer and dash charge are never derived from predicted state. Prediction affects rendering, not the numbers the player is told are true.

### 3.4 Rooms and matchmaking

- Private rooms are created by the host with a six-character code; the invite link embeds `?room=CODE`.
- The host controls max players, duration and score limit, and is the only member who can start a private match or return the room to the lobby.
- Quick Match reuses a public lobby with capacity, otherwise creates one. Public lobbies auto-start 8 s after the first player arrives.
- Any room member can request a rematch; the server starts a fresh match with a new `startedAt` value, which the client uses as a scene key.
- Session tokens live in `localStorage`. Reopening the page in the same browser resumes the session; a second socket presenting the same token takes ownership and closes the older socket. This is intentional replay protection, and it is why two tabs of one browser profile cannot be two players (see §7).

---

## 4. Protocol and validation

Every client frame passes through `parseClientMessage` before routing:

- Maximum frame size: **8 KiB**.
- Protocol version must equal **1**.
- Message type must be known.
- Numbers must be finite and in range; movement vectors are clamped; aim is normalized; booleans are type-checked.
- Room codes are normalized to the allowed alphabet before lookup.
- Callsigns are sanitized (control characters, zero-width and bidi characters, markup, length) before broadcast.
- Rate limit: token bucket at **120 messages/s sustained, 240 burst**.
- Eight invalid frames close the socket.
- Unknown/duplicate input sequence numbers are ignored; acknowledgements report the last accepted sequence.

Snapshots carry only what the client needs: phase, timer, per-player position/aim/HP/score/cooldown/connection, projectiles, crystals, FX, and match results. Server error messages use stable codes that the client maps to human copy.

---

## 5. Security controls and coverage

| Control | Where | Tested by |
| --- | --- | --- |
| Origin allow-list (production) | WebSocket upgrade | `security.test.ts`: cross-site, null, same-host, origin-less |
| Unidentified sockets cannot act | Gateway | `security.test.ts` |
| Malformed frame rejection + strike limit | `parseClientMessage` / gateway | `security.test.ts` |
| Binary frame rejection | Gateway | `security.test.ts` |
| Protocol version gate | Parser | Unit + integration |
| 8 KiB frame cap | Parser / Bun upgrade | Unit + integration |
| Callsign sanitization | `sanitizeName` | Unit + integration |
| Rate limiting | Token bucket | Unit + integration |
| Session token takeover semantics | Gateway | `security.test.ts` |
| Random token instead of guessable id | Gateway | `security.test.ts` |
| Security headers / CSP | HTTP layer | `security.test.ts` |
| Static path confinement | HTTP layer | Smoke: `/assets/../package.json` → 404 |
| SPA fallback only for HTML navigations | HTTP layer | `security.test.ts` |
| Test finish hook disabled by default | HTTP layer | `security.test.ts` |
| Test finish hook input validation | HTTP layer | `security.test.ts` |

The content security policy is strict: `default-src 'self'`, scripts only from self, objects disabled, framing denied, `base-uri 'none'`. Inline styles are permitted because the UI uses style attributes for live gauges; inline scripts are not.

The test finish endpoint is the only deliberate backdoor and exists solely so E2E can end a match deterministically. It returns 404 unless `ENABLE_TEST_ENDPOINTS=1`, and it validates the room code and payload when enabled.

---

## 6. Verification record

All commands were run from `C:\Users\Abdul Jabbar Metlo\neon-rift` with `C:\Users\Abdul Jabbar Metlo\.bun\bin\bun.exe` (Bun is not on `PATH` on this machine).

### 6.1 Static checks and tests

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `bun run typecheck` | exit 0, no diagnostics |
| Unit tests | `bun run test:unit` | **63 passed / 0 failed**, 198 assertions, 40 ms, 4 files |
| Integration tests | `bun run test:integration` | **26 passed / 0 failed**, 93 assertions, 9.76 s, 2 files |
| AFTERMATH tests | `bun test tests/aftermath.test.ts` | **27 passed / 0 failed**, 178 assertions |
| Full Bun suite | `bun test` (root scoped by `bunfig.toml`) | **116 passed / 0 failed**, 469 assertions, 10.65 s, 7 files |
| DOM contract | `bun run test:dom` | 112 ids in HTML, 98 referenced, **0 missing**; 14 unreferenced are structural/JS-toggled |
| E2E | `bun run test:e2e` | **7 passed / 0 failed** in one run (4 arena + 3 AFTERMATH) |

Unit breakdown: `physics.test.ts` 20, `match.test.ts` 20, `protocol.test.ts` 19, `rate-limit.test.ts` 4.  
Integration breakdown: `gameplay.test.ts` 9, `security.test.ts` 17.  
AFTERMATH breakdown: `aftermath.test.ts` 27 (ballistics, loadouts, mission clock, ranks, contract determinism).

The DOM audit's 14 unreferenced ids are expected: `app`, `game-root`, three `fx-*` layers, and the modal/section title ids that are toggled through shared modal logic rather than queried individually.

### 6.2 Playwright E2E

| Test | What it proves | Duration |
| --- | --- | --- |
| Solo flow | Boot → private room → live authoritative match → keyboard movement observed in snapshots → pause stack → forced finish → results → return to lobby | 15.5 s |
| Invite + rematch | Host creates a room; guest opens `/play?room=CODE`, joins by callsign; both see 2/8; host starts; both get 2-player results; guest rematches; both relaunch with a newer `startedAt` | 38.2 s |
| Phone touch controls | iPhone 13 emulation exposes both sticks, FIRE and DASH; DASH is tappable | 7.7 s |
| Callsign persistence | A callsign survives a reload | 5.1 s |
| AFTERMATH success | Real planning clicks (role/insertion), deploy, live WebGL draw calls, terminal hack, on-screen waypoint label, extraction, results, meta progression increment, redeploy | 21.0 s |
| AFTERMATH KIA | Deploy, operator death, failed-results modal, redeploy to planning | 27.5 s |
| AFTERMATH touch notice | Touch device sees the desktop-required notice instead of broken controls | 57.4 s |

Durations are from the dedicated `e2e/aftermath.spec.ts` run under SwiftShader and vary widely with software-rendering throughput — the same success flow has taken 21 s alone and up to ~3.6 minutes inside a full-suite run on this machine, while the 2D arena tests stayed near their normal times. The 2D tests keep the 120 s default; the 3D tests raise their own timeouts (360 s success, 300 s KIA) for exactly this reason. Playwright runs one worker with retries only on CI; traces and screenshots are retained on failure, and the runner starts the production server on `127.0.0.1:3100` in the same Bun process that performs the build.

### 6.3 Production smoke test

The production server was started on port 3302 with `NODE_ENV=production` after `bun run build`.

| Request | Result |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true,"status":"healthy",...}` |
| `GET /api/status` | 200, live tick/memory/room/metrics JSON |
| `GET /` | 200, 25,140 bytes |
| `GET /play?room=ABC123` with `Accept: text/html` | 200, SPA shell |
| `GET /aftermath.html` with `Accept: text/html` | 200, 3D entry |
| Hashed arena JS asset | 200, `text/javascript`, `Cache-Control: public, max-age=31536000, immutable` |
| Hashed Three.js asset (`three-*.js`) | 200, `text/javascript`, immutable cache |
| `GET /assets/nope.js` | 404 |
| `GET /assets/../package.json` | 404 (path confinement) |
| `POST /api/test/finish` with test endpoints off | 404 |
| Security headers | CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` present |

The SPA fallback intentionally requires `Accept: text/html`; a tool that requests `/play` with `Accept: */*` gets 404. Browsers send `text/html`, so invite links work, and assets with extensions never fall back.

### 6.4 Build output

`bun run build` (Vite 7.3.7) produces two entries: the arena page and the AFTERMATH page. Three.js is only pulled in by the 3D entry.

| Artifact | Raw | Gzip |
| --- | --- | --- |
| `index.html` | 25.14 kB | 5.96 kB |
| `arena.css` | 56.06 kB | 11.93 kB |
| `arena.js` | 86.75 kB | 25.64 kB |
| `phaser.js` | 1,208.05 kB | 332.16 kB |
| `aftermath.html` | 14.06 kB | 3.76 kB |
| `aftermath.css` | 31.05 kB | 6.98 kB |
| `aftermath.js` | 90.52 kB | 28.74 kB |
| `three.js` | 541.09 kB | 133.29 kB |

Phaser and Three.js dominate their entry bundles. Each engine is split into its own hashed chunk so app-only changes do not invalidate it, and the 3D engine chunk is never loaded by the 2D arena page. This is acceptable for a game client but is the main lever if first-load size becomes a requirement.

### 6.5 Load tests

Five runs were executed against a production server spawned by the load-test harness on loopback ports 3200–3204. Each ran for 10 measured seconds with no warm-up. All clients were synthetic WebSocket players sending real input packets.

| Clients / rooms | Snapshots/s/client | Ack p50 / p95 / p99 (ms) | Ack ratio | Tick avg / max (ms) | Server RSS (MB) |
| --- | --- | --- | --- | --- | --- |
| 2 / 1 | 14.9 | 33.26 / 61.90 / 66.99 | 99.5% | 0.654 / 3.419 | 37.8 |
| 4 / 1 | 15.0 | 34.27 / 65.32 / 68.12 | 100% | 0.789 / 6.504 | 38.3 |
| 8 / 1 | 15.0 | 35.38 / 65.91 / 69.38 | 99.7% | 1.122 / 12.923 | 38.9 |
| 16 / 2 | 14.9 | 37.38 / 66.63 / 78.64 | 99.6% | 2.438 / **130.777** | 40.5 |
| 32 / 4 | 15.0 | 37.43 / 67.73 / 71.33 | 99.7% | 3.008 / 10.383 | 44.3 |

Interpretation and caveats:

- **Acknowledgement latency is dominated by snapshot scheduling, not the network.** Acks are carried in the 15 Hz snapshots, so a sample can wait anywhere from 0 to ~66 ms for the next snapshot; the 33–37 ms p50 on loopback is that scheduling floor, not RTT.
- **15 snapshots/s/client was sustained at every size**, including 32 clients across 4 rooms.
- **32 clients used about 44 MB RSS** and 3.0 ms average tick time on this 6-core machine. That leaves headroom, but it is not a capacity guarantee.
- **The 16-client run's 130.8 ms maximum tick is a real outlier** and is reported rather than hidden. The average was 2.4 ms and the 32-client run's maximum was 10.4 ms, so the most likely cause is a one-off GC/JIT pause or host scheduling, not a systematic cost at 16 clients. It was not independently reproduced.
- **Loopback does not test the public internet.** No packet loss, jitter, NAT, TLS termination or consumer uplink was involved. WAN behaviour remains unmeasured.
- **Ten seconds is a smoke-scale measurement**, not a soak test. Long-run memory growth and room churn were not measured.
- Raw reports are stored under `loadtest-results/`.

### 6.6 Screenshots

`bun scripts/screenshots.ts` drives the real production build and writes:

`docs/screenshots/menu.png`, `lobby.png`, `arena.png`, `arena-action.png`, `results.png`, `mobile-menu.png`, `mobile-arena.png`.

Each simulated player uses a fresh browser context because session tokens are single-owner. Captures walk the pilot toward the arena centre so the frame is representative rather than showing a clamped corner spawn.

The AFTERMATH frames (`aftermath-planning.png`, `aftermath-mission.png`, `aftermath-terminal.png`, `aftermath-extraction.png`, `aftermath-results.png`) were captured separately against the production build using CDP `Page.captureScreenshot` (Playwright's `page.screenshot` stalls under SwiftShader). They were taken on both software rendering and a headed real GPU; the mission frames freeze or pause the simulation at the moment of interest rather than relying on a lucky capture.

---

## 7. Defects and false alarms found during hardening

Recording these because they explain design decisions and because an honest report should include the dead ends.

1. **Two tabs in one browser profile fought over one session.** The server treats token replay as takeover, which is correct for security but made a naive two-tab screenshot/E2E setup look like a connection bug. Fix: every simulated player gets an isolated browser context. Documented in the screenshot script and in the README limitations.
2. **A faint "NEON RIFT" ghost in one arena screenshot looked like a menu leak.** Probes showed `#screen-menu` was `hidden` with `display:none`, its logo rect was zero, and `elementsFromPoint` hit the canvas. The visible text is low-alpha floor typography baked into the arena texture (`RIFT`, `SECTOR // THE RIFT`). Not a bug; no code change.
3. **A player near an arena edge appeared off-centre.** The camera follows correctly but clamps at world bounds, so a corner spawn cannot be centred without showing out-of-world space. This is standard and was confirmed with camera diagnostics (`scrollX/Y`, zoom, world view). Screenshots now move toward the centre first.
4. **Mobile HUD overlaps.** The desktop dash orb was redundant in touch mode, the score strip sat in the left joystick zone, and the leaderboard was too small. Fix: hide the desktop ability block in touch mode, show dash charge on the touch DASH button, move the score strip below vitals, enlarge leaderboard rows and hide keyboard hints.
5. **`bun test` picked up the Playwright spec.** Bun's default matcher includes `*.spec.ts`, so `e2e/arena.spec.ts` was loaded by Bun and failed with "Playwright Test did not expect test() to be called here". Fix: `bunfig.toml` sets the test root to `./tests`; `bun test` now reports 116 tests and the E2E suites run only through Playwright.
6. **`/play` returned 404 to a raw HTTP client.** The SPA fallback requires `Accept: text/html` by design. The smoke test was corrected to send a browser-like header; assets with extensions never fall back.
7. **AFTERMATH mission timer and objectives crawled on slow GPUs.** The mission clock, extraction hold and hack progress were fed the physics `dt`, which is clamped to 0.05 s per frame; under SwiftShader (1–9 fps) a wall-clock minute took several minutes of real time. Fix: the loop now passes a separate wall-clock `dt` (capped at 1 s) to mission/objective updates while physics keeps its small clamp, and the FPS meter uses raw frame time instead of the clamped value.
8. **AFTERMATH E2E waypoint-label assertion was physically unsatisfiable.** The HUD only writes the waypoint label while the marker projects on-screen. After the terminal hack, the extraction pad is behind the player at the terminal, so the DOM kept the initial "OBJECTIVE" text while the player stood still. Fix: assert the label immediately after `teleportExtraction()`, when the pad marker is guaranteed on-screen, and assert the marker is visible. This made the test both deterministic and faster (21 s instead of 58 s).
9. **"White translucent quads" around the extraction pad looked like a rendering bug.** Scene enumeration (temporary debug helpers that listed every transparent material near the camera) showed the culprits were 7 enemy muzzle-flash planes and 1 player/ally flash from a live 14-hostile firefight, plus two 9×2.25 m building sign planes — all legitimate content. A control capture with the simulation paused before contact is clean. No rendering fix was needed; the investigation helpers were removed after the conclusion.

---

## 8. Not verified, and known limitations

### 8.1 Not executed here

- **Docker image build.** `Dockerfile`, `.dockerignore` and `docker-compose.yml` are provided and syntactically reviewed, but the local Docker daemon was unavailable, so no image was built or run. The deployment guide labels this path as prepared, not validated.
- **Public internet deployment.** No Railway/Fly/reverse-proxy deployment was performed. WSS, trusted certificates, proxy headers and public origin configuration are documented but unproven in a live environment.
- **Physical mobile devices.** Only Chromium iPhone 13 emulation was used. Real iOS Safari touch behaviour, safe-area handling and performance were not measured.
- **WAN networking.** No latency, loss, jitter, NAT rebinding or TLS termination testing.
- **Long soak / churn.** No multi-hour run, no repeated room create/destroy cycle measurement, no memory-leak conclusion.
- **Browser matrix.** Chromium only. Firefox and WebKit were not run.
- **AFTERMATH GPU/browser diversity.** The 3D performance probe used this machine's Chromium and GPU only; integrated GPUs, other drivers and non-Chromium engines are unmeasured. The 3D mode is also desktop-only by design, so it has no physical-mobile coverage.

### 8.2 Product limitations

- Single process, in-memory state. A restart ends all matches; there is no database, account system, ranking or progression.
- Quick Match fills the first open public room; there is no skill or region matching.
- No text or voice chat.
- Protocol is JSON text, not binary. Snapshots are compact but not optimal.
- All game audio is synthesized at runtime; there are no recorded assets.
- Session tokens in `localStorage` mean one active tab per browser profile.
- The arena is one handcrafted map, not a map rotation.

---

## 9. Reproducing the verification

```bash
# Install
bun install

# Static + tests
bun run typecheck
bun test                 # 116 Bun tests (root scoped by bunfig.toml)
bun test tests/aftermath.test.ts   # 27 AFTERMATH-only tests
bun run test:dom

# Production build and smoke
bun run build
NODE_ENV=production PORT=3000 bun run start
# then: curl /healthz, /api/status, /, /play?room=ABC123, /aftermath.html

# Browser E2E (builds, starts :3100, runs arena + AFTERMATH Playwright suites)
bun run test:e2e

# Load test with a spawned production server
bun run loadtest --spawn --port 3200 --clients 32 --rooms 4 --duration 10

# Documentation screenshots
bun run build
bun scripts/screenshots.ts
```

On Windows PowerShell, prefix the environment variables:

```powershell
$env:NODE_ENV="production"; $env:PORT="3000"; bun run start
```

---

## 10. AFTERMATH — 3D vertical slice (addendum)

### 10.1 Scope and honesty boundary

AFTERMATH is a **separate client-side entry point** (`/aftermath.html`) built with Three.js 0.187 and TypeScript. It exists to prove a second, differently-shaped game loop in the same repository without overstating it as a multiplayer product. Explicit non-claims:

- **No server authority, no WebSocket, no rooms.** The Bun server serves `aftermath.html` and its hashed chunks as static files; the player, AI, bullets and mission clock are simulated in one browser tab.
- **No backend persistence.** Callsign, XP, credits, rank and contract state live in `localStorage` (`neon-rift.aftermath.meta.v1`, plus a settings key).
- **No AAA production values.** Procedural geometry, canvas-generated neon textures and synthesized WebAudio, on one handcrafted rainy city block.
- **One mission type.** Extraction from the vault pad is the only objective; there is no save/resume for a run in progress.

### 10.2 What is implemented

- **Rendering**: `WebGLRenderer` with ACES tone mapping, exponential fog, rain, emissive window grids, neon signs, street lamps, puddles and shadow-casting key light. Effects are pooled and texture-free: tracers, additive spark sprites, muzzle-flash planes and a roaming muzzle light.
- **Planning**: three roles with distinct stats — VK-7 assault rifle, M-90 marksman rifle, AR-6 light machine gun (magazine, reserve, RPM, damage, armor, speed, stamina and ADS zoom differ); three insertions (North Gate, West Docks, East Market); a contract and mission modifiers generated per plan.
- **Mission loop**: breach the vault terminal (hold **E**) → the hack spawns 4 reinforcements and flips the directive to exfil → hold the extraction pad through a countdown → results. Death ends the run as KIA. Three AI allies (ECHO, KITE, VALE) fight alongside the player and can be revived.
- **Combat model**: hitscan-with-spread ballistics in a pure module (`ballistics.ts`) shared with tests; recoil, ADS spread, reload, sprint/stamina, crouch, headshot multiplier, armor absorption, hit markers, damage vignette and kill feed.
- **Progression**: per-run stats (time, kills, headshots, accuracy, damage, allies lost), XP/credits rewards, six ranks (Recruit → Riftwalker), contract completion and pilot meta persisted locally.
- **Presentation**: directive panel, squad HUD with health bars, minimap with contacts, world-space waypoint marker with distance, interaction prompt, toasts, pause stack, settings (sensitivity/volume), and clip/still export from the running canvas.
- **Debug API**: `window.__aftermath` (`deploy`, `teleportTerminal`, `teleportExtraction`, `forceHack`, `forceExtract`, `killPlayer`, `revealResults`, `setPaused`, `damagePlayer`, `getState`, `getMeta`) used by Playwright for deterministic objectives. It is inert unless called and grants nothing a normal player cannot reach.

### 10.3 Verification

| Check | Result |
| --- | --- |
| TypeScript | clean, including the 3D entry |
| AFTERMATH tests | **27 passed / 0 failed**, 178 assertions (`tests/aftermath.test.ts`) |
| Full Bun suite | **116 passed / 0 failed**, 469 assertions, 7 files |
| E2E success flow | real role/insertion clicks → deploy → live draw calls → terminal hack → objective flips to EXFIL → on-screen waypoint label → extraction → results (XP/rank/contract) → redeploy; 21.0 s |
| E2E KIA flow | deploy → operator death → failed-results modal → redeploy; 27.5 s |
| E2E touch notice | 390×844 touch device sees the desktop-required notice; 57.4 s |
| Production smoke | `/aftermath.html` 200, hashed 3D assets served with immutable caching, unknown asset 404 |
| Screenshots | planning, mission, terminal, extraction, results captured from the production build |

The E2E success test asserts real DOM state at every step (HUD visibility, selected role/insertion classes, results modal contents), not just API return values. Only mission objectives are forced, because walking 80 m through a firefight under SwiftShader would make the suite a timing lottery.

### 10.4 Performance

| Scenario | Measurement |
| --- | --- |
| Headed Chromium, real GPU, 1440×900, mid-mission | 27–28 fps, 813 draw calls |
| SwiftShader, planning screen | ~50 fps |
| SwiftShader, mid-mission | 1–9 fps (software rasterization of the full city block) |

Two engineering consequences came out of these numbers:

1. **Mission timing is wall-clock, not physics-clock.** Physics `dt` stays clamped at 0.05 s for stable movement, but mission/hack/extraction timers receive a separate wall-clock delta capped at 1 s. At 5 fps, a 60-second extraction clock still takes 60 real seconds instead of 5 minutes.
2. **The FPS meter is honest.** It reports raw frame time rather than the clamped simulation step, so software rendering visibly shows single-digit fps instead of a flattering number.

The draw-call count is dominated by per-window quads on the building facades. Instancing or texture-atlas merging those windows is the obvious next optimization; it was not required for the prototype's target of playable frame rates on a real GPU.

### 10.5 Limitations

- Single-player, local simulation only; no netcode, matchmaking or anti-cheat surface.
- Progression is device-local; clearing site data resets it.
- Desktop mouse/keyboard only; touch devices get an explicit notice.
- One map, one objective type, no save/resume.
- Performance scales with GPU/fill rate; integrated GPUs were not measured.
- The Three.js chunk (541 kB raw / 133 kB gzip) is only loaded by the 3D entry, but it is still a large first load for that page.

---

## 11. Conclusion

The game is real and playable end-to-end: an authoritative Bun server, a polished Phaser client, working rooms/invites/matchmaking, reconnection, desktop and touch controls, and a verified production serving path. The automated evidence is strong at the unit, integration and browser-flow levels, and the load numbers are measured rather than estimated.

On top of that, AFTERMATH adds a genuinely playable 3D extraction loop on a second entry point, verified by its own unit tests, browser E2E flows and real-GPU performance probe — while being documented as a client-side prototype rather than a multiplayer feature.

The honest gaps are deployment-environment validation and real-network/mobile coverage. Docker and public hosting are prepared and documented, not executed; WAN latency, physical devices, long soaks and non-Chromium/3D GPU diversity are unmeasured. Those are the first things to validate before calling this production-ready for a public audience.
