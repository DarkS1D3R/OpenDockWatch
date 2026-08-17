// quiet: true suppresses dotenv's own startup banner (an "injected env... tip:" line pointing at
// a promotional third-party URL) so it doesn't pollute the container's log output alongside the
// structured [opendockwatch] lines below.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const SqliteStore = require('better-sqlite3-session-store')(session);

const { requireAuth, requireAdmin, verifyLogin } = require('./auth');
const { loadHosts, getHost, saveHosts, isValidHostId, isValidDockerHostUrl, hasLocalHost } = require('./hosts');
const {
  checkHost,
  testHostConnection,
  listContainers,
  containerAction,
  streamLogs,
  downloadLogs,
  getStats,
  getTopology,
  getHostInfo,
  getDiskUsage,
  getDiskUsageImages,
  getContainerInspect,
  maskEnvValues,
  poolStats,
  CONTAINER_ACTION_TIMEOUT_MS,
  DISK_USAGE_TIMEOUT_MS,
} = require('./docker');
const db = require('./db');
const logger = require('./logger');
const alerts = require('./alerts');
const eventWatcher = require('./eventWatcher');
const metricsCollector = require('./metricsCollector');
const statsWatcher = require('./statsWatcher');
const prometheus = require('./prometheus');
const { createWatchdog } = require('./watchdog');
const { version: appVersion } = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3000;

const watchdog = createWatchdog({
  getLastPollCompletedTs: metricsCollector.getLastPollCompletedTs,
  getHostCount: metricsCollector.getHostCount,
});

const SSE_HEARTBEAT_MS = 30_000;

// Longer than any docker call this can be waiting on (CONTAINER_ACTION_TIMEOUT_MS, the longest,
// is 30s) plus the queue wait in docker.js's run(), so a request only hits this once the call
// behind it has stopped being merely slow.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 50_000;

const HISTORY_RANGES = {
  '1h': { sinceMs: 3_600_000, bucketMs: 15_000 },
  '24h': { sinceMs: 86_400_000, bucketMs: 5 * 60_000 },
  '7d': { sinceMs: 7 * 86_400_000, bucketMs: 30 * 60_000 },
};

const MAX_ROW_LIMIT = 1000;

// Number('abc') is NaN, and better-sqlite3 rejects NaN outright ("datatype mismatch") rather
// than treating it as absent - so a garbled ?limit=/?since= would 500 instead of falling back.
// Clamping the upper bound too keeps a hand-written ?limit=10000000 from pulling the whole table.
function intParam(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

// `docker logs --tail` takes a line count or the literal "all" (the log viewer's "All lines"
// option), so this can't just be intParam - but everything else has to be a plain positive
// integer before it's handed to the CLI.
function tailParam(raw, fallback) {
  if (raw === 'all') return 'all';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Container ids/names go into the docker CLI's argv (execFile/spawn with an array, never a
// shell), so this isn't about injection - it's that an id starting with "-" would be read by
// docker as a flag rather than a container, better refused here than handed over misparsed.
const CONTAINER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function requireContainerId(req, res, next) {
  if (!CONTAINER_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid container id' });
  next();
}

// Resolves :hostId to a configured host so route handlers don't each repeat the getHost()/404
// pair. The property is `odwHost` and must not be `host`: express defines req.host as a getter-only
// property (the Host header), so assigning it silently no-ops and handlers get a string. See CLAUDE.md.
function requireHost(req, res, next) {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  req.odwHost = host;
  next();
}

// A browser allows ~6 connections per origin over HTTP/1.1, some held open indefinitely by
// design (SSE streams) - a request that never answers holds a slot until the tab can't issue
// any request at all. So: answer, always, even 504. SSE routes are exempt by path suffix.
const STREAMING_PATH_RE = /\/(logs|logs\/download|events\/stream)$/;

function requestTimeout(ms) {
  return (req, res, next) => {
    if (STREAMING_PATH_RE.test(req.path)) return next();

    let timedOut = false;

    // The handler is still running when the 504 goes out and will eventually send its own real
    // response, which would throw ERR_HTTP_HEADERS_SENT and destroy an already-answered
    // connection - dropping the late write is the fix. The 504 goes out through the captured original.
    const sendJson = res.json.bind(res);
    res.json = (body) => (timedOut ? res : sendJson(body));

    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      timedOut = true;
      logger.warn('request.timeout', { method: req.method, path: req.originalUrl, ms });
      res.status(504);
      sendJson({ error: 'timed out waiting for the docker daemon' });
    }, ms);

    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

// A heartbeat, and that is most of the point: when this app went unresponsive for 220s the log
// held *nothing at all* between the two sides of it, and the outage was only provable afterwards
// by finding the matching gap in the metrics table. A line on a fixed interval turns the absence
// of logs into evidence - you can see the beats stop, see how long for, and read the vitals going
// in and coming back out. Everything on it is a live counter that no other line reports: the
// open/close pairs elsewhere describe one stream each, and "how many are held right now" is not
// something you can replay from them while the UI is hung. Set VITALS_INTERVAL_MS=0 to silence.
const VITALS_INTERVAL_MS = Number(process.env.VITALS_INTERVAL_MS ?? 60_000);

// Live count of held `docker logs -f` children, each also holding one of the browser's ~6
// per-origin connections. Running out of either is the app's main self-inflicted hang.
let openLogStreams = 0;

function logVitals() {
  const mem = process.memoryUsage();
  const pool = poolStats();
  const poll = metricsCollector.takePollStats();
  // dbMaxMs alongside lagMs is the pairing that matters: better-sqlite3 is synchronous, so if the
  // loop stalled and the worst write of that same window was long, the storage is the cause. If
  // lag is high and dbMaxMs is not, it was something else - which is equally worth knowing.
  const write = db.takeWriteStats();
  logger.info('app.vitals', {
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    lagMs: Math.round(watchdog.status().lagMs || 0),
    pollLastMs: poll.lastMs,
    pollMaxMs: poll.maxMs,
    pollSlow: poll.slow,
    dbLastMs: write.lastMs,
    dbMaxMs: write.maxMs,
    dbSlow: write.slow,
    dockerActive: pool.active,
    dockerQueued: pool.queued,
    logStreams: openLogStreams,
    sseClients: eventWatcher.broadcaster.subscriberCount(),
    events: eventWatcher.takeIngestCount(),
    hosts: metricsCollector.getHostCount(),
    // Read against `hosts`: below it, some host's stats stream is down and that host is paying
    // for the 1.3-2.0s one-shot `docker stats` on every 5s poll. The stream's own restart lines
    // say so as it happens; this is what says it is *still* happening an hour later.
    statsLive: statsWatcher.liveCount(),
  });
}

// Taking over `clientError` means taking over the response, and the status is NOT always 400:
// headersTimeout and requestTimeout both surface here as ERR_HTTP_REQUEST_TIMEOUT, which Node's
// own default answers 408. Answering those 400 tells a merely slow client it sent garbage, and
// behind a reverse proxy 408 is the expected, retryable keep-alive outcome where 400 reads as a
// client bug. Pure and exported so the mapping is unit-tested rather than only exercised by a
// malformed socket - the handler itself lives in the require.main block and can't be.
function clientErrorStatus(code) {
  return code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request';
}

// docker.js's run() attaches the CLI's real stderr to err.stderr; anything else only has
// err.message. Every docker-backed route reports failure the same way, so this fallback is
// spelled out once here instead of copy-pasted into every catch block.
function dockerError(res, err, status = 502) {
  res.status(status).json({ error: err.stderr || err.message });
}

if (!process.env.SESSION_SECRET) {
  logger.warn('config.session_secret.missing', { hint: 'using an insecure default - set SESSION_SECRET in .env' });
}

// Behind a reverse proxy terminating TLS, needed for `cookie.secure: 'auto'` and req.ip/the
// login rate limiter to see the real client IP. Left off by default: without a proxy, trusting
// X-Forwarded-For lets a client spoof req.ip, defeating the rate limiter and forging log lines.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// No helmet dependency for five fixed headers. CSP is the load-bearing one: container log output
// reaches the DOM through v-html, and the absence of 'unsafe-inline' below is what stops a crafted
// log line's <img onerror=…> from running. See CLAUDE.md for what each escape hatch costs.
const CSP = [
  "default-src 'self'",
  // 'unsafe-eval' is not optional: with no build step, Vue compiles every component's `template`
  // string in the browser through the Function constructor, and without it the app renders blank.
  // It does not re-enable inline scripts or event handlers, which is the part v-html needs.
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
});

// Covers every route, not just /api - requestTimeout below is api-only, so this is the only
// thing that would ever say anything about a slow `/`, `/login` or static asset request. Fires
// on completion only (res.on('finish')), so it can't fire twice and can't fire for a request that
// never finishes at all - a request stuck past the socket-level server.requestTimeout still logs
// nothing of its own, which is a real gap, but Node gives no hook to log a request the raw socket
// itself is about to kill.
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 5000;

// Some routes are legitimately slow and warning about them is noise, not signal: a container
// start/stop/restart shells out with CONTAINER_ACTION_TIMEOUT_MS (30s) and a `docker stop` waiting
// out SIGTERM routinely takes ten-plus seconds while behaving exactly as designed, and the disk
// route can shell out to `docker system df`, measured at 40-75s cold on WSL2. Those get the
// timeout they're actually bounded by as their threshold, so the line still fires when they exceed
// even that - it just stops firing for working normally.
const SLOW_ROUTE_OVERRIDES = [
  { re: /\/containers\/[^/]+\/(start|stop|restart)$/, ms: CONTAINER_ACTION_TIMEOUT_MS },
  { re: /\/disk-usage(\/images)?$/, ms: DISK_USAGE_TIMEOUT_MS },
];

function slowThresholdFor(path) {
  const override = SLOW_ROUTE_OVERRIDES.find((o) => o.re.test(path));
  return override ? override.ms : SLOW_REQUEST_MS;
}

app.use((req, res, next) => {
  // SSE routes are held open by design (see the connection-budget section of CLAUDE.md) - logging
  // one every time a log/event stream finally closes after minutes or hours would be noise, not
  // signal, and those already get their own open/close pair with heldSec.
  if (STREAMING_PATH_RE.test(req.path)) return next();
  const startedAt = Date.now();
  const threshold = slowThresholdFor(req.path);
  res.on('finish', () => {
    const tookMs = Date.now() - startedAt;
    if (tookMs >= threshold) {
      logger.warn('request.slow', { method: req.method, path: req.originalUrl, status: res.statusCode, tookMs, thresholdMs: threshold });
    }
  });
  next();
});

app.use(express.json());
app.use(
  session({
    store: new SqliteStore({
      client: db.client,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 },
  })
);

const PUBLIC_DIR = path.join(__dirname, '../public');

// There is no build step, so a page load is ~44 separate requests: 35 ES modules, 7 vendor
// scripts, the stylesheet and the logo. express.static's defaults gave every one of them an ETag
// and no max-age, which means 44 conditional round trips on every navigation - all answering 304,
// all still costing a turn of the browser's ~6-connection budget, on the same origin whose SSE
// streams are already holding some of it open.
//
// So assets are mounted twice. The version-pinned prefix can be cached forever because the URL
// itself changes on every release - and crucially that works for the *whole module graph* without
// touching a single import: a relative `import './format.js'` resolves against the importing
// module's own URL, so pointing index.html at /assets/v<version>/js/app.js pulls all 35 in under
// the same prefix. A query string (?v=) could not do that - the imports would not carry it.
const ASSET_PREFIX = `/assets/v${appVersion}`;
app.use(ASSET_PREFIX, express.static(PUBLIC_DIR, { index: false, immutable: true, maxAge: '365d' }));

// The bare mount stays for two reasons: anything referencing /assets/… directly rather than
// through the HTML (app.js's template has the logo), and a browser still holding a cached
// index.html from the previous release, which must keep working rather than 404 its way to a
// blank page. Its max-age is short - enough to stop re-validating on every navigation within a
// session, short enough that a deploy is picked up without a hard refresh.
app.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: '5m' }));

// The HTML is the pointer to everything above, so it is the one thing that must never be cached:
// serve a stale copy and the browser keeps loading the previous release's assets from its own
// cache, indefinitely and invisibly. Read per request rather than at boot so `npm run dev` still
// picks up edits - it is two small files, once per navigation, against the 44 requests this saves.
function sendPage(res, file) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html.replaceAll('/assets/', `${ASSET_PREFIX}/`));
}

app.get('/login', (req, res) => {
  sendPage(res, 'login.html');
});

// Bcrypt login with no attempt limit is the main exposed surface - cap failed
// attempts per IP instead of allowing unlimited guesses.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
  // Without a handler this blocks silently, and the silence is the problem: once the limiter
  // trips, requests stop reaching verifyLogin, so `auth.failure` stops being logged too. A
  // sustained brute-force attempt therefore reads in the log as though it stopped, exactly when
  // it's most active. This is the only line that says otherwise.
  handler: (req, res, next, options) => {
    logger.warn('auth.rate_limited', { ip: req.ip, user: (req.body && req.body.username) || null, limit: options.limit });
    res.status(options.statusCode).json(options.message);
  },
});

// Anything the pre-auth session held keeps its id through a login without this, so a session id
// planted before sign-in would still be valid after it. saveUninitialized:false means there's
// rarely a session to fixate here, but the guarantee should come from the login, not from that.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const account = await verifyLogin(username, password);
    if (!account) {
      logger.warn('auth.failure', { user: username, ip: req.ip });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await regenerateSession(req);
    req.session.authenticated = true;
    req.session.username = account.username;
    req.session.role = account.role;
    logger.info('auth.success', { user: account.username, role: account.role, ip: req.ip });
    res.json({ ok: true, role: account.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backs the Dockerfile's HEALTHCHECK - reachable with no credentials, deliberately narrow: a
// trivial sqlite round-trip, not a docker CLI call. Only local sqlite gates health; a remote SSH
// host being unreachable shouldn't restart the whole app and take down every other host's monitoring.
app.get('/healthz', (req, res) => {
  try {
    db.ping();
  } catch (err) {
    logger.error('healthz.failed', { error: err.message });
    return res.status(503).type('text/plain').send('unhealthy: sqlite');
  }
  // Liveness of the poll loop, not of any Docker host - see watchdog.js. An unreachable daemon
  // still completes its poll, so this can only fail if the loop itself has stopped, which is
  // exactly the "still serving, but every number is frozen" state a restart is the fix for.
  const health = watchdog.status();
  if (!health.ok) {
    return res.status(503).type('text/plain').send(`unhealthy: ${health.reason}`);
  }
  res.type('text/plain').send('ok');
});

// Compares equal-length strings in constant time; a length mismatch is answered without one,
// which leaks only the token's length. Plain !== leaks a prefix match through its return time,
// which is worth avoiding on the one credential that travels in a URL.
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Prometheus scrapers can't do session-cookie auth, so /metrics lives outside the
// requireAuth-protected router and is gated by a separate shared-secret token instead. With no
// token set the endpoint isn't published at all - see the 404 below.
app.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  // Unset fails closed. This response carries every container name, compose project and usage
  // figure across every host, so "no token configured" has to mean "not exposed" rather than
  // "exposed to anyone who can reach the port" - a scraper sets METRICS_TOKEN, nobody else needs it.
  if (!token) return res.status(404).type('text/plain').send('not found');
  const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token;
  if (!tokenMatches(provided, token)) return res.status(401).type('text/plain').send('unauthorized');
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(prometheus.render());
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/', requireAuth, (req, res) => {
  sendPage(res, 'index.html');
});

const api = express.Router();
api.use(requireAuth);
api.use(requestTimeout(REQUEST_TIMEOUT_MS));

// Never trust a length from the client, and never let one log line become a megabyte: a stack
// trace is unbounded and this value is entirely attacker-influenced. Newlines need no special
// handling - logger.js's formatFields JSON.stringifies any value containing whitespace, so they
// come out escaped and can't forge a second log line.
function clip(value, max) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max) || null;
}

// Generous enough that a real burst of distinct errors still gets through, tight enough that a
// client which somehow defeats its own per-page cap can't flood the log. The client's cap is the
// real defence (see app.js) because the connection cost is paid browser-side; this is the backstop
// for a client that isn't ours.
const clientErrorLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: 'too many client error reports' },
});

// The frontend compiles its Vue templates in the browser, so a broken render is a blank page with
// a completely healthy server log - "the site is broken" and "the server is fine" both true, and
// nothing reconciling them without someone opening devtools. This puts client failures in the same
// log as everything else. 204 with no body: the client is fire-and-forget and must not care about
// the answer, so there's nothing for it to parse and nothing for it to fail on.
api.post('/client-error', clientErrorLimiter, (req, res) => {
  const { kind, message, source, line } = req.body || {};
  logger.warn('client.error', {
    user: req.session.username,
    kind: clip(kind, 40),
    message: clip(message, 300),
    source: clip(source, 200),
    line: Number.isFinite(Number(line)) ? Number(line) : null,
  });
  res.status(204).end();
});

api.get('/session', (req, res) => {
  res.json({ username: req.session.username, role: req.session.role, version: appVersion, defaultView: getDefaultView() });
});

// The collector already establishes reachability and hostname for every host every POLL_MS -
// probing again per request meant a CLI spawn (and up to a 20s SSH timeout) per browser poll for
// an answer already sitting in memory. Live probes are kept only before a host's first poll lands.
api.get('/hosts', async (req, res) => {
  const hosts = loadHosts();
  const results = await Promise.all(
    hosts.map(async (h) => {
      const snapshot = metricsCollector.getSnapshot(h.id);
      if (snapshot && snapshot.ts) {
        const name = h.name || (!h.dockerHost && snapshot.hostInfo ? snapshot.hostInfo.hostname : null) || h.id;
        return { id: h.id, name, reachable: snapshot.reachable };
      }
      const reachable = await checkHost(h);
      let name = h.name;
      // Local (non-SSH) hosts don't need a manually configured name - fall back to the
      // machine's real hostname from `docker info` so hosts.json can omit it entirely.
      if (!name && !h.dockerHost && reachable) {
        try {
          name = (await getHostInfo(h)).hostname;
        } catch {
          /* best-effort */
        }
      }
      return { id: h.id, name: name || h.id, reachable };
    })
  );
  res.json(results);
});

// The four builders below each back both their own route and one field of the /dashboard bundle.
// They exist as functions for exactly that reason: the bundle is the same data the separate routes
// return, and two copies of "what a container row carries" would be free to drift apart silently.

// Served from the collector's snapshot, same reason as statsFor: at most POLL_MS stale (the
// browser's own poll interval anyway), avoiding a live `docker ps` per tab per 5s. fresh forces a
// live call right after a start/stop/restart, where staleness reads as "didn't work".
async function containersFor(host, { fresh = false } = {}) {
  const snapshot = metricsCollector.getSnapshot(host.id);
  const useSnapshot = !fresh && snapshot && snapshot.reachable && snapshot.statsTs;
  const containers = useSnapshot ? snapshot.containers : await listContainers(host);
  const restartCounts = db.getRestartCountsByContainer(host.id, Date.now() - 3_600_000);
  // The snapshot's container objects are the collector's own and get read on every poll - copy
  // rather than annotating them in place with a field only this response wants.
  return containers.map((c) => ({ ...c, restartCount1h: restartCounts.get(c.id) || 0 }));
}

// Prefer metricsCollector's snapshot: it's the only place NET/DISK rate data lives, and it's at
// most POLL_MS stale. Falls back to a live call when there's no snapshot yet - gated on statsTs,
// not just reachable, since a freshly-added host has empty stats until its first poll.
async function statsFor(host) {
  const snapshot = metricsCollector.getSnapshot(host.id);
  if (snapshot && snapshot.reachable && snapshot.statsTs) return snapshot.stats;
  return getStats(host);
}

function hostHistoryFor(hostId, rangeKey) {
  const range = HISTORY_RANGES[rangeKey] || HISTORY_RANGES['1h'];
  return db.getHostMetricsHistory(hostId, Date.now() - range.sinceMs, range.bucketMs);
}

async function topologyFor(host) {
  const topology = await getTopology(host, metricsCollector.getSnapshot(host.id));
  const alertCounts = db.getOpenAlertCountsByContainer(host.id);
  for (const node of topology.nodes) node.openAlerts = alertCounts.get(node.id) || 0;
  return topology;
}

// The poll loop's cycle in one request. It used to be four serial ones - containers, stats,
// history, alerts - each awaiting the one before it, so a cycle cost four round trips, four
// session-store lookups and four turns of the browser's ~6-connection budget, per open tab, every
// POLL_MS. None of it needs a docker call (it is all snapshot and sqlite), so there was never a
// reason for them to be separate requests rather than separate fields.
//
// **Topology is deliberately not one of them**, even though the poll fetches it too in Flow view.
// It is the one part that can still shell out - its label/mount metadata is cached against the
// container-id set, which a container being recreated invalidates - so folding it in would put a
// docker call behind every field here and make the whole response only as reliable as the
// slowest one. It stays its own route, and the client simply stops awaiting the two in series.
// The individual routes stay too: `?fresh=1` on /containers still has its own caller, and the
// history/alerts routes serve ranges and limits this bundle deliberately does not.
const DASHBOARD_ALERT_LIMIT = 100;

api.get('/hosts/:hostId/dashboard', requireHost, async (req, res) => {
  const host = req.odwHost;
  try {
    const [containers, stats] = await Promise.all([containersFor(host), statsFor(host)]);
    res.json({
      containers,
      stats,
      metricsHistory: hostHistoryFor(host.id, '1h'),
      alerts: db.getAlerts(host.id, { limit: DASHBOARD_ALERT_LIMIT }),
    });
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/containers', requireHost, async (req, res) => {
  try {
    res.json(await containersFor(req.odwHost, { fresh: req.query.fresh === '1' }));
  } catch (err) {
    dockerError(res, err);
  }
});

// The viewer role means "can't change anything", not "can read every secret on every host" - and
// Config.Env is where DB passwords and API keys live. Viewers get variable names with the values
// masked, flagged by envMasked so the UI can say so rather than look like the values are blank.
api.get('/hosts/:hostId/containers/:id/inspect', requireHost, requireContainerId, async (req, res) => {
  const host = req.odwHost;
  try {
    const inspect = await getContainerInspect(host, req.params.id);
    if (req.session.role === 'admin') return res.json(inspect);
    res.json({ ...inspect, env: maskEnvValues(inspect.env), envMasked: true });
  } catch (err) {
    dockerError(res, err);
  }
});

// Served from the collector's snapshot, same reason as /containers and /stats: it already has a
// current `docker info` for every host, and this route is hit on every host switch by every
// viewer. The snapshot's copy is also the better answer - its container counts are recomputed
// from the poll's `docker ps` rather than left at whatever the cached info call last reported.
api.get('/hosts/:hostId/info', requireHost, async (req, res) => {
  const host = req.odwHost;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  if (snapshot && snapshot.reachable && snapshot.hostInfo) return res.json(snapshot.hostInfo);
  try {
    res.json(await getHostInfo(host));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/stats', requireHost, async (req, res) => {
  try {
    res.json(await statsFor(req.odwHost));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/topology', requireHost, async (req, res) => {
  try {
    res.json(await topologyFor(req.odwHost));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/disk-usage', requireHost, async (req, res) => {
  const host = req.odwHost;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  // `{rows, error}` rather than a bare array, so a host where `docker system df` can't complete
  // says so instead of returning `[]` - indistinguishable from "nothing on disk" to the client,
  // which then rendered no panel at all. Last known rows are still served alongside the error.
  if (snapshot && (snapshot.diskUsage || snapshot.diskUsageError)) {
    return res.json({ rows: snapshot.diskUsage || [], error: snapshot.diskUsageError || null });
  }
  try {
    res.json({ rows: await getDiskUsage(host), error: null });
  } catch (err) {
    dockerError(res, err);
  }
});

// Separate from the route above (and not part of the regular disk-usage poll/snapshot) since -v
// is extra work to walk every image's shared/unique layer sizes - only fetched on demand, when
// the Images disclosure in the Disk tile is actually opened.
api.get('/hosts/:hostId/disk-usage/images', requireHost, async (req, res) => {
  const host = req.odwHost;
  try {
    res.json(await getDiskUsageImages(host));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/metrics/history', requireHost, (req, res) => {
  const { containerId } = req.query;
  if (!containerId) return res.json(hostHistoryFor(req.params.hostId, req.query.range));
  const range = HISTORY_RANGES[req.query.range] || HISTORY_RANGES['1h'];
  res.json(db.getContainerMetricsHistory(req.params.hostId, containerId, Date.now() - range.sinceMs, range.bucketMs));
});

api.get('/hosts/:hostId/events', requireHost, (req, res) => {
  const sinceTs = intParam(req.query.since, 0);
  const limit = intParam(req.query.limit, 200, MAX_ROW_LIMIT);
  const rows = db.getEvents(req.params.hostId, { sinceTs, limit });
  res.json(
    rows.map((r) => ({
      hostId: r.host_id,
      containerId: r.container_id,
      containerName: r.container_name,
      action: r.action,
      ts: r.ts,
    }))
  );
});

// Logged on both ends: these hold one of the browser's ~6 per-origin connections for as long as
// the Activity tab is open, so "which streams are actually open right now" is worth being able to
// reconstruct from the log when the UI goes unresponsive. See CLAUDE.md's connection budget.
api.get('/hosts/:hostId/events/stream', requireHost, (req, res) => {
  const unsubscribe = eventWatcher.broadcaster.subscribe(res, req.params.hostId);
  const openedAt = Date.now();
  logger.info('events.stream.subscribed', { host: req.params.hostId, user: req.session.username });
  req.on('close', () => {
    unsubscribe();
    logger.info('events.stream.unsubscribed', {
      host: req.params.hostId,
      user: req.session.username,
      heldSec: Math.round((Date.now() - openedAt) / 1000),
    });
  });
});

api.get('/audit', (req, res) => {
  const limit = intParam(req.query.limit, 200, MAX_ROW_LIMIT);
  res.json(db.getAuditLog(req.query.hostId || null, { limit }));
});

api.get('/alerts', (req, res) => {
  const limit = intParam(req.query.limit, 200, MAX_ROW_LIMIT);
  res.json(db.getAlerts(req.query.hostId || null, { limit }));
});

api.post('/alerts/:id/ack', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid alert id' });
  db.ackAlert(id);
  res.json({ ok: true });
});

api.post('/alerts/ack-all', requireAdmin, (req, res) => {
  const hostId = req.query.hostId;
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  const count = db.ackAllAlerts(hostId);
  res.json({ ok: true, count });
});

// The tab the app lands on after login - env-default + DB-override, same shape as the alert
// settings below, but general enough (no secrets, affects every role) that the read isn't
// admin-gated: /session already hands it to every authenticated user regardless of role, since a
// viewer's landing tab should match the configured default too, not just an admin's.
const VALID_VIEWS = new Set(['list', 'flow', 'logs', 'activity']);
const DEFAULT_VIEW_KEY = 'defaultView';
const FALLBACK_VIEW = 'list';

// Resolved once at load, not per call: getDefaultView runs on every /session, and a misspelt .env
// value is worth saying out loud once at boot rather than silently every login. Same shape as the
// SESSION_SECRET warning above.
const ENV_DEFAULT_VIEW = (() => {
  const raw = process.env.DEFAULT_VIEW;
  if (!raw) return FALLBACK_VIEW;
  if (VALID_VIEWS.has(raw)) return raw;
  logger.warn('config.default_view.invalid', { value: raw, using: FALLBACK_VIEW });
  return FALLBACK_VIEW;
})();

// Validated on the way out, not just on the way in. PUT already rejects a bad value, but a
// hand-edited settings row - or one written by a release that still had a view this one dropped -
// would otherwise reach the client and land it on a tab nothing renders for: List/Flow are v-show
// and Logs/Activity v-if, so an unknown view is a blank page with no tab active. Treating an
// unusable row as absent also keeps `overridden` honest - it reports the override in effect, not
// merely the presence of a row.
function dbDefaultView() {
  const val = db.getSetting(DEFAULT_VIEW_KEY);
  return val !== null && VALID_VIEWS.has(val) ? val : null;
}

function getDefaultView() {
  return dbDefaultView() || ENV_DEFAULT_VIEW;
}

api.get('/settings/default-view', requireAdmin, (req, res) => {
  res.json({ defaultView: getDefaultView(), overridden: dbDefaultView() !== null });
});

api.put('/settings/default-view', requireAdmin, (req, res) => {
  const { defaultView } = req.body || {};
  if (!VALID_VIEWS.has(defaultView)) {
    return res.status(400).json({ error: 'defaultView must be one of list, flow, logs, activity' });
  }
  db.setSetting(DEFAULT_VIEW_KEY, defaultView);
  logger.info('settings.default_view.update', { user: req.session.username, defaultView });
  res.json({ defaultView, overridden: true });
});

api.delete('/settings/default-view', requireAdmin, (req, res) => {
  db.deleteSetting(DEFAULT_VIEW_KEY);
  logger.info('settings.default_view.clear', { user: req.session.username });
  res.json({ defaultView: ENV_DEFAULT_VIEW, overridden: false });
});

// Webhook URLs carry auth tokens (Discord/Gotify) - admin-only, same as
// container control.
const ALLOWED_WEBHOOK_SCHEMES = new Set(['http:', 'https:', 'discord:', 'ntfy:', 'gotify:', 'gotifys:']);

api.get('/settings/webhook', requireAdmin, (req, res) => {
  res.json(alerts.getWebhookConfig());
});

api.put('/settings/webhook', requireAdmin, (req, res) => {
  const { url = '', format = '' } = req.body || {};
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'invalid webhook URL' });
    }
    if (!ALLOWED_WEBHOOK_SCHEMES.has(parsed.protocol)) {
      return res.status(400).json({ error: `unsupported scheme "${parsed.protocol}" - use http(s), discord, ntfy, gotify, or gotifys` });
    }
  }
  if (format && format !== 'slack') {
    return res.status(400).json({ error: 'format must be empty or "slack"' });
  }
  // Scheme only, never the full URL - webhook URLs embed secrets (Discord token, Slack path, ntfy
  // topic) that have no business in the container's log output. Shared helper, same reason.
  logger.info('settings.webhook.update', {
    user: req.session.username,
    url: url ? alerts.webhookScheme(url) : '(cleared)',
    format: format || 'auto',
  });
  res.json(alerts.setWebhookConfig({ url, format }));
});

api.delete('/settings/webhook', requireAdmin, (req, res) => {
  logger.info('settings.webhook.clear', { user: req.session.username });
  res.json(alerts.clearWebhookConfig());
});

api.post('/settings/webhook/test', requireAdmin, async (req, res) => {
  try {
    await alerts.sendTestAlert();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Resource-threshold rules (container/host CPU & mem, Docker disk footprint) -
// same env-default + DB-override + admin-only shape as the webhook settings above.
const THRESHOLD_FIELDS = ['cpuThreshold', 'memThreshold', 'sustainMinutes', 'diskThresholdGb'];

api.get('/settings/thresholds', requireAdmin, (req, res) => {
  res.json(alerts.getThresholdConfig());
});

api.put('/settings/thresholds', requireAdmin, (req, res) => {
  const body = req.body || {};
  const values = {};
  for (const field of THRESHOLD_FIELDS) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      values[field] = 0;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${field} must be a non-negative number` });
    }
    values[field] = n;
  }
  logger.info('settings.thresholds.update', { user: req.session.username, ...values });
  res.json(alerts.setThresholdConfig(values));
});

api.delete('/settings/thresholds', requireAdmin, (req, res) => {
  logger.info('settings.thresholds.clear', { user: req.session.username });
  res.json(alerts.clearThresholdConfig());
});

// Host management (add/edit/remove monitored Docker hosts, including SSH-based remote ones) -
// writes to config/hosts.json via saveHosts() and immediately starts/stops the corresponding
// metricsCollector polling and eventWatcher watching, so changes take effect without a restart.
api.get('/settings/hosts', requireAdmin, (req, res) => {
  res.json(loadHosts());
});

api.post('/settings/hosts', requireAdmin, (req, res) => {
  const { id, name, dockerHost } = req.body || {};
  if (!isValidHostId(id)) {
    return res.status(400).json({ error: 'id is required and may only contain letters, numbers, - and _' });
  }
  const hosts = loadHosts();
  if (hosts.some((h) => h.id === id)) {
    return res.status(400).json({ error: `a host with id "${id}" already exists` });
  }
  if (!isValidDockerHostUrl(dockerHost)) {
    return res.status(400).json({ error: 'dockerHost must be a valid ssh:// URL, or blank for the local socket' });
  }
  if (!dockerHost && hasLocalHost(hosts)) {
    return res.status(400).json({ error: 'a host already uses the local socket - only one local connection is allowed' });
  }
  const host = { id, name: name || undefined, dockerHost: dockerHost || null, edges: [] };
  const updated = [...hosts, host];
  saveHosts(updated);
  metricsCollector.addHost(host);
  eventWatcher.addHost(host);
  logger.info('settings.hosts.add', { user: req.session.username, host: id, dockerHost: dockerHost || 'local' });
  res.json(updated);
});

api.put('/settings/hosts/:id', requireAdmin, (req, res) => {
  const hosts = loadHosts();
  const idx = hosts.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'unknown host' });
  const { name, dockerHost } = req.body || {};
  if (!isValidDockerHostUrl(dockerHost)) {
    return res.status(400).json({ error: 'dockerHost must be a valid ssh:// URL, or blank for the local socket' });
  }
  if (!dockerHost && hasLocalHost(hosts, req.params.id)) {
    return res.status(400).json({ error: 'a host already uses the local socket - only one local connection is allowed' });
  }
  const updatedHost = { ...hosts[idx], name: name || undefined, dockerHost: dockerHost || null };
  const updated = [...hosts];
  updated[idx] = updatedHost;
  saveHosts(updated);
  // Reconnect with the new config rather than trying to figure out exactly what changed.
  metricsCollector.removeHost(updatedHost.id);
  eventWatcher.removeHost(updatedHost.id);
  metricsCollector.addHost(updatedHost);
  eventWatcher.addHost(updatedHost);
  logger.info('settings.hosts.update', { user: req.session.username, host: updatedHost.id, dockerHost: dockerHost || 'local' });
  res.json(updated);
});

api.delete('/settings/hosts/:id', requireAdmin, (req, res) => {
  const hosts = loadHosts();
  if (!hosts.some((h) => h.id === req.params.id)) return res.status(404).json({ error: 'unknown host' });
  const updated = hosts.filter((h) => h.id !== req.params.id);
  saveHosts(updated);
  metricsCollector.removeHost(req.params.id);
  eventWatcher.removeHost(req.params.id);
  logger.info('settings.hosts.remove', { user: req.session.username, host: req.params.id });
  res.json(updated);
});

// Runs the same probe as the reachability poll, but surfaces the real docker/ssh stderr instead
// of collapsing it to a boolean - "Host key verification failed" or "Permission denied
// (publickey)" tells the user exactly what to fix, "unreachable" in the host card doesn't.
api.post('/settings/hosts/:hostId/test', requireAdmin, requireHost, async (req, res) => {
  const host = req.odwHost;
  try {
    await testHostConnection(host);
    res.json({ ok: true });
  } catch (err) {
    dockerError(res, err);
  }
});

// Per-container/name/compose-project alert overrides - first-match-wins ordered list, same
// admin-only shape as the webhook/threshold/host settings above. See alerts.js's resolveContainerConfig.
const EVENT_RULE_NAMES = new Set(['container_crashed', 'crash_loop', 'unhealthy']);
const MATCH_TYPES = new Set(['name', 'composeProject']);

// Same reasoning as intParam/requireContainerId: nothing off the URL reaches sqlite unchecked.
// Returns null for anything that isn't a positive integer rowid, so the route can 400 rather than
// bind a NaN that quietly matches no row and reports success.
function ruleIdParam(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validateContainerRuleBody(body, hosts) {
  const { hostId, matchType, matchValue, cpuThreshold, memThreshold, sustainMinutes, mutedRules } = body;
  if (hostId && !hosts.some((h) => h.id === hostId)) return 'unknown hostId';
  if (!MATCH_TYPES.has(matchType)) return 'matchType must be "name" or "composeProject"';
  if (!matchValue || typeof matchValue !== 'string' || !matchValue.trim()) return 'matchValue is required';
  for (const [field, val] of [
    ['cpuThreshold', cpuThreshold],
    ['memThreshold', memThreshold],
    ['sustainMinutes', sustainMinutes],
  ]) {
    if (val !== null && val !== undefined && val !== '' && (!Number.isFinite(Number(val)) || Number(val) < 0)) {
      return `${field} must be a non-negative number, or blank to inherit the global default`;
    }
  }
  if (mutedRules !== undefined && (!Array.isArray(mutedRules) || mutedRules.some((r) => !EVENT_RULE_NAMES.has(r)))) {
    return 'mutedRules must be an array of container_crashed/crash_loop/unhealthy';
  }
  return null;
}

function normalizeContainerRuleBody(body) {
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    hostId: body.hostId || null,
    matchType: body.matchType,
    matchValue: body.matchValue.trim(),
    cpuThreshold: num(body.cpuThreshold),
    memThreshold: num(body.memThreshold),
    sustainMinutes: num(body.sustainMinutes),
    mutedRules: body.mutedRules || [],
  };
}

api.get('/settings/container-rules', requireAdmin, (req, res) => {
  res.json(db.getContainerAlertRules());
});

// Registered before the /:id routes below - :id would otherwise match the literal string
// "reorder" too, since Express matches route patterns in registration order.
api.put('/settings/container-rules/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body || {};
  const existing = db.getContainerAlertRules();
  const existingIds = new Set(existing.map((r) => r.id));
  const valid =
    Array.isArray(orderedIds) &&
    orderedIds.length === existing.length &&
    orderedIds.every((id) => existingIds.has(id)) &&
    new Set(orderedIds).size === orderedIds.length;
  if (!valid) return res.status(400).json({ error: 'orderedIds must list every existing rule id exactly once' });
  db.reorderContainerAlertRules(orderedIds);
  logger.info('settings.container_rules.reorder', { user: req.session.username });
  res.json(db.getContainerAlertRules());
});

api.post('/settings/container-rules', requireAdmin, (req, res) => {
  const body = req.body || {};
  const err = validateContainerRuleBody(body, loadHosts());
  if (err) return res.status(400).json({ error: err });
  db.insertContainerAlertRule(normalizeContainerRuleBody(body));
  logger.info('settings.container_rules.add', { user: req.session.username, matchType: body.matchType, matchValue: body.matchValue });
  res.json(db.getContainerAlertRules());
});

api.put('/settings/container-rules/:id', requireAdmin, (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid rule id' });
  const body = req.body || {};
  const err = validateContainerRuleBody(body, loadHosts());
  if (err) return res.status(400).json({ error: err });
  if (!db.updateContainerAlertRule(id, normalizeContainerRuleBody(body))) {
    return res.status(404).json({ error: 'no such rule' });
  }
  logger.info('settings.container_rules.update', { user: req.session.username, id });
  res.json(db.getContainerAlertRules());
});

api.delete('/settings/container-rules/:id', requireAdmin, (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid rule id' });
  if (!db.deleteContainerAlertRule(id)) return res.status(404).json({ error: 'no such rule' });
  logger.info('settings.container_rules.remove', { user: req.session.username, id });
  res.json(db.getContainerAlertRules());
});

api.post('/hosts/:hostId/containers/:id/:action', requireAdmin, requireHost, requireContainerId, async (req, res) => {
  const host = req.odwHost;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  const container = (snapshot?.containers || []).find((c) => c.id === req.params.id);
  const logFields = { user: req.session.username, host: req.params.hostId, container: container ? container.name : req.params.id };
  const startedAt = Date.now();

  // Written before containerAction runs, not after it resolves - the daemon can emit the
  // die/start event before this CLI call returns (a slow-to-stop container). alerts.js's
  // manual-stop suppression looks this row up by ts, so it must already exist or a fast event races it.
  const auditId = db.insertAuditLog({
    ts: Date.now(),
    username: req.session.username || null,
    hostId: req.params.hostId,
    containerId: req.params.id,
    containerName: container ? container.name : null,
    action: req.params.action,
    result: 'pending',
    error: null,
  });

  // Paired with the completion line below rather than logging only on success: `docker stop` can
  // sit through its full 10s SIGTERM grace (longer against a wedged daemon), and until it returned
  // a pressed button left nothing in the log at all - only a 'pending' audit row.
  logger.info(`container.${req.params.action}.requested`, logFields);

  try {
    await containerAction(host, req.params.id, req.params.action);
    db.updateAuditLogResult(auditId, 'ok', null);
    logger.info(`container.${req.params.action}`, { ...logFields, tookMs: Date.now() - startedAt });
    res.json({ ok: true });
  } catch (err) {
    const detail = err.stderr || err.message;
    db.updateAuditLogResult(auditId, 'error', detail);
    logger.error(`container.${req.params.action}`, { ...logFields, tookMs: Date.now() - startedAt, error: detail });
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/containers/:id/logs', requireHost, requireContainerId, (req, res) => {
  const host = req.odwHost;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const tail = tailParam(req.query.tail, 200);
  const child = streamLogs(host, req.params.id, { tail });
  // Each of these is a `docker logs -f` child on the host *and* a held browser connection, and
  // the pair is the app's main way of running out of either. closedBy says which side ended it:
  // 'client' is a normal pane close or tab suspend, 'child' is docker exiting under us.
  const openedAt = Date.now();
  openLogStreams += 1;
  logger.info('logs.stream.open', { host: host.id, container: req.params.id, tail, user: req.session.username, open: openLogStreams });
  // Decremented here rather than in cleanup() so it can't be missed by a future early return -
  // cleanup is the single place that calls this, and it self-guards against running twice.
  const logClose = (closedBy) => {
    openLogStreams = Math.max(0, openLogStreams - 1);
    logger.info('logs.stream.close', {
      host: host.id,
      container: req.params.id,
      closedBy,
      heldSec: Math.round((Date.now() - openedAt) / 1000),
      open: openLogStreams,
    });
  };

  // Buffer partial lines per-stream (stdout/stderr arrive as independent byte
  // streams) so a line split across chunk boundaries isn't emitted as two SSE
  // events, which breaks timestamps and the frontend's level detection.
  const makeSender = () => {
    let buffer = '';
    return (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.length) res.write(`data: ${line}\n\n`);
      }
    };
  };

  child.stdout.on('data', makeSender());
  child.stderr.on('data', makeSender());

  // Behind nginx or any proxy with an idle timeout, a quiet log stream gets cut -
  // a periodic comment line keeps the connection alive.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

  // Either side can end this first: client disconnect, or `docker logs -f` itself exiting (a
  // removed container, a restarted daemon) - without ending the response on the latter, the
  // heartbeat kept it looking alive forever. Ending it lets EventSource's reconnect take over.
  let closed = false;
  const cleanup = (closedBy) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    child.kill();
    res.end();
    logClose(closedBy);
  };

  child.on('error', (err) => {
    // Only the browser pane used to see this - a stream that never starts left nothing server-side.
    logger.error('logs.stream.failed', { host: host.id, container: req.params.id, error: err.message });
    res.write(`data: [opendockwatch] failed to stream logs: ${err.message}\n\n`);
    cleanup('error');
  });
  // Both wrapped rather than passed directly: 'close' hands its listener an exit code, which would
  // otherwise land in cleanup's closedBy.
  child.on('close', () => cleanup('child'));
  req.on('close', () => cleanup('client'));
});

api.get('/hosts/:hostId/containers/:id/logs/download', requireHost, requireContainerId, (req, res) => {
  const host = req.odwHost;

  const tail = tailParam(req.query.tail, 5000);
  // Container logs routinely carry secrets and customer data, so who exported them and when is
  // audit material, not just diagnostics - the same reason container.start/stop is logged.
  logger.info('logs.download', { host: host.id, container: req.params.id, tail, user: req.session.username });
  const child = downloadLogs(host, req.params.id, { tail });

  const safeName = (s) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safeName(req.params.hostId)}-${safeName(req.params.id)}-logs.txt"`,
  });

  // Two independent stdio streams feeding one response - don't let either one's
  // end() race the other; end the response once, when the process itself closes.
  child.stdout.pipe(res, { end: false });
  child.stderr.pipe(res, { end: false });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    res.end();
  };
  child.on('close', finish);
  child.on('error', (err) => {
    if (!res.headersSent) res.status(502);
    res.write(`[opendockwatch] failed to fetch logs: ${err.message}\n`);
    finish();
  });

  req.on('close', () => child.kill());
});

app.use('/api', api);

// Anything a route throws that it doesn't handle lands here - express's default handler would
// otherwise leak the stack trace unless NODE_ENV=production. Four arguments mark this as an
// error handler; `next` is used for the already-streaming (SSE) case where express must destroy it.
app.use((err, req, res, next) => {
  logger.error('request.failed', { method: req.method, path: req.originalUrl, error: err.message });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message });
});

// Only listens and starts background pollers when run directly (npm start/dev, the Dockerfile) -
// not when require()'d, which is how test/index.test.js loads `app` for supertest. Without this
// guard, importing the module for its routes would also open a port and start polling.
if (require.main === module) {
  let vitalsTimer = null;
  const server = app.listen(PORT, () => {
    // Through logger.js, not console: the Log Viewer filters on the [LEVEL] tag, so a banner on
    // plain console is invisible in the app's own log view - which is where someone checking
    // "did it actually come up, and as what version?" is looking.
    logger.banner(appVersion, `http://localhost:${PORT}`);
    logger.info('app.started', {
      version: appVersion,
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
      hosts: loadHosts().length,
      pid: process.pid,
    });
    alerts.loadBreachState();
    alerts.start();
    eventWatcher.start();
    metricsCollector.start();
    watchdog.start();
    if (VITALS_INTERVAL_MS) {
      // Never the reason the process stays alive - the HTTP server is. Same as watchdog's timer.
      vitalsTimer = setInterval(logVitals, VITALS_INTERVAL_MS);
      if (vitalsTimer.unref) vitalsTimer.unref();
    }
  });

  // Node defaults to 300s here - five minutes of a held connection slot for a request that's
  // never answering (see requestTimeout above). This is the socket-level backstop for anything
  // middleware doesn't cover; keepAliveTimeout stays under it so idle sockets get recycled.
  server.requestTimeout = REQUEST_TIMEOUT_MS + 10_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 20_000;

  // Nothing here reaches Express, so no middleware above (request.slow included) can ever see it -
  // a malformed request, or a client that stalls mid-headers, is otherwise destroyed by Node with
  // no application-level trace. ECONNRESET is the common, boring case (a client closing early) and
  // stays quiet; anything else is the interesting one, e.g. a corrupt request line from a proxy.
  //
  // See clientErrorStatus for why the response isn't a flat 400.
  server.on('clientError', (err, socket) => {
    if (err.code !== 'ECONNRESET') {
      logger.warn('http.client_error', { code: err.code, message: err.message });
    }
    // Node's default declines to write once the socket is gone or a response has already begun;
    // not matching that turns socket.end() into a silent no-op that reads like a reply was sent,
    // or corrupts a partly-written one.
    if (!socket.writable || socket.bytesWritten > 0) return socket.destroy();
    socket.end(`HTTP/1.1 ${clientErrorStatus(err.code)}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });

  // There is deliberately no server.on('timeout') listener and no server.timeout. It defaults to 0
  // (disabled) in Node >= 13, so a listener alone can never fire - and merely attaching one
  // suppresses Node's default socket destruction, so turning server.timeout on to "fix" that would
  // leak every timed-out socket unless the handler destroyed them itself. It also can't be turned
  // on safely here regardless: server.timeout is whole-socket inactivity, and this app's SSE log
  // and event streams are idle by design between 30s heartbeats. requestTimeout/headersTimeout
  // above are the bounded, per-request equivalents, and they don't touch a streaming response.

  // Most unhandled rejections here are one failed docker call or db write - losing a poll is
  // recoverable, losing the process isn't - so they're logged and swallowed. An uncaught
  // exception is different: the stack is untrustworthy, so the honest move is to exit and restart.
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { error: (reason && reason.message) || String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  // Without this, `docker stop` sends SIGTERM and the default handler kills the
  // process immediately - potentially mid-write to the sqlite db.
  const shutdown = (signal) => {
    // Same reasoning as app.started: a clean SIGTERM shutdown and a watchdog self-exit look
    // identical in `docker logs` unless the graceful path says so itself.
    logger.info('app.shutdown', { signal, uptimeSec: Math.round(process.uptime()) });
    watchdog.stop();
    if (vitalsTimer) clearInterval(vitalsTimer);
    metricsCollector.stop();
    eventWatcher.stop();
    alerts.stop();

    const startedAt = Date.now();
    let closed = false;
    // Which of the two paths got here is worth knowing and was previously invisible: 'drained'
    // means every connection ended on its own, 'timeout' means streams were still held after 5s
    // and are being dropped. A shutdown that always reports 'timeout' is the connection-budget
    // problem showing up at the one moment it's easy to observe.
    const finish = (endedBy) => {
      if (closed) return;
      closed = true;
      logger.info('app.shutdown.complete', { endedBy, tookMs: Date.now() - startedAt, logStreams: openLogStreams });
      db.close();
      process.exit(0);
    };

    // server.close() waits for open connections to end, but log/event SSE streams
    // are intentionally long-lived - don't let them block shutdown indefinitely.
    server.close(() => finish('drained'));
    setTimeout(() => finish('timeout'), 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, api, requestTimeout, requireHost, clientErrorStatus, slowThresholdFor };
