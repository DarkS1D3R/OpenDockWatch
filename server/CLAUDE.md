# CLAUDE.md — server/

Rules for changing `server/**`. Each rule below is a must-keep, and most are test-enforced. The reasons behind them, with measurements, are in [`docs/architecture/server.md`](../docs/architecture/server.md). Read the matching section there before you change a subsystem, and before you "simplify" anything that looks odd. For commands and repo-wide conventions, see the [root CLAUDE.md](../CLAUDE.md).

## Map

- `index.js`: app setup only (security headers, session, static assets, `/login`, `/healthz`, `/metrics`, vitals, boot/shutdown).
- `routes/`: one router per area, mounted at `/` on `api`: `session`, `hostData`, `activity`, `settings`, `containers`. `middleware.js` holds the param guards and timeouts. `dashboardData.js` holds the dashboard-bundle builders and their caches.
- `docker.js`: every docker CLI call (`execFile`/`spawn`, `-H <dockerHost>` per host via `hostArgs()`), plus the exported pure parsers.
- Background jobs: `eventWatcher.js` (`docker events`), `metricsCollector.js` (5s poll plus the derived-interval disk poll), `statsWatcher.js` (`docker stats` stream). The first two share their lifecycle code through `restartingWatcher.js`.
- `alerts.js`: the rule engine and webhook delivery. `db.js`: one better-sqlite3 database. `auth.js`: sessions and the admin/viewer roles. `watchdog.js`: stall detection and self-exit. `logger.js`: all log output.
- Feature modules: `uptime.js`, `overview.js`, `inventory.js`, `imageUpdates.js`/`registry.js`/`imageRef.js`, `composeGroup.js`, `prometheus.js`, `sse.js`, `hosts.js`, `views.js`.

## Staying responsive (the core constraint)

- **Answer every request.** Every route sits under `requestTimeout`; only SSE routes are exempt. A route that can legitimately run long sizes its own budget (`armResponseTimeout`) and gets a `SLOW_ROUTE_OVERRIDES` entry. A slow docker call answers at once and refreshes in the background (see `inventory.js` and the image-update check, which returns 202).
- **Don't multiply work per viewer.** Routes serve from the collector snapshot, not a fresh shell-out. `GET /hosts/:id/dashboard` must stay memory and sqlite only. Its parity tests need seeded rows to mean anything.
- **Share `run()`'s 12 slots.** Batch work goes through `mapLimit` at a small concurrency. Background refreshes allow one in flight per host (the `inFlight` pattern). After `forgetHost`, re-check the state object's identity before writing a late result.
- **Code in a child's stdout handler never throws.** One example is `ingestEvent`'s per-event try/catch, because a throw there exits the process. Restart watchers on `'close'`, never `'exit'`.
- **Never `await` inside a better-sqlite3 transaction.** A poll collects, writes everything in one `insertMetrics` transaction, and only then runs alerting.
- Anything that changes alerts or hosts calls `forgetDashboardCaches(hostId)`.

## Logging

- No `console.*` outside `logger.js` (enforced by `test/logger.test.js`).
- Log state transitions and discrete operations, never per-poll steady state. Aggregate a sustained condition into one line; don't log each occurrence.
- Never log secrets. A webhook URL is logged only through `alerts.webhookScheme()`. Search queries go through `loggableUrl`. Env values never leave `docker.js`.
- Log container actions as a pair: `.requested` before the call, and the result with `tookMs` after.

## Security

- Every non-GET route needs `requireAdmin` (a structural test walks the router). A privileged **GET** (audit, `top`) needs its own viewer-403 test, because the walk can't see it. Exemptions go in `ADMIN_EXEMPT` with a reason.
- A viewer gets masked data: env values through `maskEnvValues`, the healthcheck command through `maskInspectForViewer`.
- URL input goes through the `routes/middleware.js` guards (`intParam`, `tailParam`, `requireContainerId`, `requireContainerAction`) before it reaches sqlite or argv. An id starting with `-` would be read as a docker flag.
- Store the resolved host on `req.odwHost`, never `req.host`. Express's `req.host` is getter-only, so writing to it silently does nothing and the call falls back to the local socket.
- CSP: `script-src` must never gain `'unsafe-inline'`, and it must keep `'unsafe-eval'` (Vue compiles templates in the browser).
- `/metrics` returns 404 when `METRICS_TOKEN` is unset, and compares tokens with `timingSafeEqual`.

## Database (`db.js`)

- Prepare statements once, in the `stmts` map.
- Clearing `alerts`/`events` is a soft delete. Every query against them filters `cleared_at IS NULL` unless it answers "what actually happened". Exceptions go in `CLEARED_AT_EXEMPT` with a reason (enforced by `test/db.test.js`).
- There is no migration framework. Add tables and indexes as `CREATE ... IF NOT EXISTS` in the schema block. A new column goes in **both** the `CREATE TABLE` and a `try { ALTER TABLE ... ADD COLUMN }` after the schema block. An index on a new column is created **after** the `ALTER` block.
- Keep `BUCKET_EXPR` as `ts - (ts % @bucketMs)`. Division is float, so it groups nothing. Prune by rowid range, not `WHERE ts <`.
- Choose indexes for the whole query, including its `ORDER BY`. `USE TEMP B-TREE` in `EXPLAIN QUERY PLAN` is the warning sign.

## Testability and structure

- Keep docker-output parsing pure and separate from the shell-out, and export it for `test/*.test.js`.
- Call docker through the module object (`docker.listContainers(...)`), not a destructured binding, so tests can stub it.
- A host edit is `removeHost` + `addHost`, never an in-place update.
- Container actions, single or compose-group, go through `performContainerAction`. Its `audit_log` row is what stops the app's own stops from looking like crashes.
- An alert setting resolves `.env` default < DB value. The DB value wins even when it's empty or 0.
- Constants the client mirrors (`ALERT_RULES`, `VALID_VIEWS` in `views.js`, the history ranges) are checked by `test/sharedConstants.test.js`. Change both sides together.
- Claims about Docker/Podman behaviour in this codebase were verified against a real daemon. Verify new ones the same way, not from memory.
