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

const { requireAuth, verifyLogin } = require('./auth');
const { loadHosts } = require('./hosts');
const { poolStats, CONTAINER_ACTION_TIMEOUT_MS, DISK_USAGE_TIMEOUT_MS } = require('./docker');
const db = require('./db');
const logger = require('./logger');
const alerts = require('./alerts');
const eventWatcher = require('./eventWatcher');
const metricsCollector = require('./metricsCollector');
const statsWatcher = require('./statsWatcher');
const prometheus = require('./prometheus');
const { createWatchdog } = require('./watchdog');
const { REQUEST_TIMEOUT_MS, STREAMING_PATH_RE, requestTimeout, requireHost } = require('./routes/middleware');
const { getOpenLogStreams, router: containerRoutes } = require('./routes/containers');
const { router: settingsRoutes } = require('./routes/settings');
const sessionRoutes = require('./routes/session');
const hostDataRoutes = require('./routes/hostData');
const activityRoutes = require('./routes/activity');
const { version: appVersion } = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3000;

const watchdog = createWatchdog({
  getLastPollCompletedTs: metricsCollector.getLastPollCompletedTs,
  getHostCount: metricsCollector.getHostCount,
});

// A heartbeat, and that is most of the point: when this app went unresponsive for 220s the log
// held *nothing at all* between the two sides of it, and the outage was only provable afterwards
// by finding the matching gap in the metrics table. A line on a fixed interval turns the absence
// of logs into evidence - you can see the beats stop, see how long for, and read the vitals going
// in and coming back out. Everything on it is a live counter that no other line reports: the
// open/close pairs elsewhere describe one stream each, and "how many are held right now" is not
// something you can replay from them while the UI is hung. Set VITALS_INTERVAL_MS=0 to silence.
const VITALS_INTERVAL_MS = Number(process.env.VITALS_INTERVAL_MS ?? 60_000);

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
    logStreams: getOpenLogStreams(),
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
// log line's <img onerror=…> from running. See server/CLAUDE.md for what each escape hatch costs.
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
  // SSE routes are held open by design (see the connection-budget section of server/CLAUDE.md) - logging
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
//
// The prefix carries a content hash as well as the version: a from-source rebuild between releases
// keeps the version, and with it alone the browser served the previous build's CSS for a year.
function hashPublicDir() {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(PUBLIC_DIR, full)).update(fs.readFileSync(full));
    }
  };
  walk(PUBLIC_DIR);
  return hash.digest('hex').slice(0, 10);
}

// Fixed at boot in production (the image's files can't change). Elsewhere sendPage re-hashes per
// page load, since `npm run dev` doesn't restart on a public/ edit and a stale tag would pin it.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
let assetTag = `v${appVersion}-${hashPublicDir()}`;
const pinnedAssets = express.static(PUBLIC_DIR, { index: false, immutable: true, maxAge: '365d' });
app.use('/assets/:tag', (req, res, next) => (req.params.tag === assetTag ? pinnedAssets(req, res, next) : next()));

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
  if (!IS_PRODUCTION) assetTag = `v${appVersion}-${hashPublicDir()}`;
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html.replaceAll('/assets/', `/assets/${assetTag}/`));
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

api.use(sessionRoutes);
api.use(hostDataRoutes);
api.use(activityRoutes);
api.use(settingsRoutes);
api.use(containerRoutes);

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
      logger.info('app.shutdown.complete', { endedBy, tookMs: Date.now() - startedAt, logStreams: getOpenLogStreams() });
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
