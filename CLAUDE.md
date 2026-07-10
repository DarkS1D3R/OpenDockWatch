# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenDockWatch is a small self-hosted Docker monitoring dashboard: container list/start/stop/restart, live log tailing, a topology ("Flow") graph, and an alerts/events feed. It watches the local Docker daemon and any number of remote hosts over SSH. See `README.md` for the full feature list and `CONTRIBUTING.md` for the release process.

## Commands

```
npm install                                 # deps
cp .env.example .env                        # then fill in AUTH_USER/AUTH_PASS_HASH/SESSION_SECRET
cp config/hosts.example.json config/hosts.json
npm run hash-password -- "your-password"    # generates a bcrypt hash for .env's AUTH_PASS_HASH

npm run dev                                  # node --watch server/index.js, http://localhost:3000
npm start                                    # plain node server/index.js

npm test                                     # syntax-check every server/public-js/scripts file, then node --test
node --test test/docker.test.js              # run a single test file
node --test --test-name-pattern="parseByteString" test/docker.test.js   # run one test by name

npm run lint                                 # eslint .
npm run format                               # prettier --write .
npm run format:check                         # prettier --check .  (what CI runs)

docker compose up -d --build                 # run OpenDockWatch itself in a container
```

CI (`.github/workflows/ci.yml`) runs `npm run lint && npm run format:check && npm test`, then a plain `docker build`. Always run the same three before considering a change done.

There is no build step for the frontend — `public/js/*.js` is served as-is via native ES modules (`<script type="module">` in `public/index.html`), and `npm test`'s syntax-check step is the only thing that touches it (nothing executes/unit-tests it; the `test/` suite only covers `server/`).

## Architecture

**The server shells out to the `docker` CLI** (`server/docker.js`, via `child_process.execFile`/`spawn`) rather than talking to the Engine API or a Docker SDK. Every function takes a `host` object and prefixes its args with `-H <dockerHost>` when set (`hostArgs()`); a `null`/absent `dockerHost` means the local socket. This is _why_ remote hosts work at all: `-H ssh://user@host` is resolved by the Docker CLI itself using normal SSH key/config, so there's no separate tunneling code to maintain. Hosts are defined in `config/hosts.json` (gitignored, copy from `hosts.example.json`), each with an optional `edges: [{from,to,label}]` list for relationships Docker itself can't see.

**Pure parsing/graph-building functions are exported from `server/docker.js`** (`parseByteString`, `parseLabels`, `parseHealth`, `networkEdges`, `dependsOnEdges`, …) specifically so `test/*.test.js` can unit-test them directly without mocking `child_process`. When adding docker-CLI-output parsing, keep the parsing pure and separate from the function that actually shells out, and export it.

**Two long-running background jobs, started in `server/index.js` on boot:**

- `eventWatcher.js` — one persistent `docker events` process per host (auto-restarts with exponential backoff on exit/error, capped at 30s). Each parsed event line fans out to three places: `db.insertEvent` (persistence), `broadcaster.publish` (live SSE push to the Activity tab), and `alerts.handleEvent` (rule engine). This is the single ingestion point for all event-driven alerts (`container_crashed`, `crash_loop`, `unhealthy`).
- `metricsCollector.js` — polls every host every `POLL_MS` (5s) for containers/stats/info, plus disk usage every 60s; keeps an in-memory snapshot per host (`getSnapshot(hostId)`, used e.g. to avoid an extra docker call just for a container's name in audit logging) and writes samples to sqlite for history charts. Also feeds the threshold-based alerts (`container_cpu`/`container_mem`/`host_cpu`/`host_mem`/`docker_disk`, `handleSample`/`handleHostSample`/`handleDiskUsage` in `alerts.js`).

**`alerts.js`** is the rule engine plus webhook delivery. Every alert setting (webhook URL/format, CPU/mem/disk thresholds) follows the same pattern: an `.env` default, overridable from the DB via the admin Settings UI (`PUT /api/settings/...`), with the DB value always winning when present — even an explicit empty/0 to deliberately disable something `.env` configured. See the README's Alerts section for the full rule table and webhook URL-scheme routing.

**`server/db.js`** is a single `better-sqlite3` database (`data/opendockwatch.db`) holding metrics history, events, audit log, alerts, settings overrides, and doubles as the express-session store. No migration framework — schema is a set of `CREATE TABLE IF NOT EXISTS` statements run at startup; add new tables/columns the same way.

**Auth (`server/auth.js`)** is cookie-session based with two roles: admin (full control) and an optional read-only viewer (`VIEWER_USER`/`VIEWER_PASS_HASH`). Role enforcement is server-side (`requireAdmin` middleware on every mutating route) — the viewer role hides buttons in the UI too, but a request forged around the UI still gets a 403 from the server.

**Frontend is a single Vue 3 (Options API) component** in `public/js/app.js` — one big component with one large template string, no SFCs/build step. Supporting modules: `api.js` (the only place `fetch` is called, wraps 401→redirect-to-login and JSON/error handling), `format.js` (pure display formatting: ANSI-to-HTML for colored logs, byte/timestamp formatting, log-level detection, badge/icon lookups), `constants.js` (poll intervals, history lengths), `graph.js` (all Cytoscape.js flow-view logic: layout via dagre, edge/node styling, and `localStorage`-backed persistence of dragged node positions + camera zoom/pan, keyed per host so a reload doesn't reset your arrangement). Vendor libraries (Vue, Cytoscape, dagre) are checked into `public/vendor/` and loaded as global `<script>` tags, not npm/bundled — `eslint.config.js` declares them as browser globals for that reason.

**Live updates use Server-Sent Events**, not WebSockets: container logs (`GET /api/hosts/:id/containers/:id/logs`, `docker logs -f --timestamps`) and the container event feed (`GET /api/hosts/:id/events/stream`, via `eventWatcher`'s `Broadcaster` in `server/sse.js`) are both one-way SSE streams the frontend consumes with `EventSource`.

**Two eslint environments** (`eslint.config.js`): `server/**`, `scripts/**`, `test/**` are CommonJS/Node; `public/js/**` is an ES module/browser environment. Keep new files in the right bucket.
