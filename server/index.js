// quiet: true suppresses dotenv's own startup banner (an "injected env... tip:" line pointing at
// a promotional third-party URL) so it doesn't pollute the container's log output alongside the
// structured [opendockwatch] lines below.
require('dotenv').config({ quiet: true });
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
} = require('./docker');
const db = require('./db');
const logger = require('./logger');
const alerts = require('./alerts');
const eventWatcher = require('./eventWatcher');
const metricsCollector = require('./metricsCollector');
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

// Resolves :hostId to a configured host, attaching it as req.host so route handlers don't each
// repeat the getHost()/404 pair - it was copy-pasted verbatim across every /hosts/:hostId route.
function requireHost(req, res, next) {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  req.host = host;
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

app.use('/assets', express.static(path.join(__dirname, '../public'), { index: false }));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
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
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const api = express.Router();
api.use(requireAuth);
api.use(requestTimeout(REQUEST_TIMEOUT_MS));

api.get('/session', (req, res) => {
  res.json({ username: req.session.username, role: req.session.role, version: appVersion });
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

// Served from the collector's snapshot, same reason as /stats: at most POLL_MS stale (the
// browser's own poll interval anyway), avoiding a live `docker ps` per tab per 5s. ?fresh=1
// forces a live call right after a start/stop/restart, where staleness reads as "didn't work".
api.get('/hosts/:hostId/containers', requireHost, async (req, res) => {
  const host = req.host;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  const useSnapshot = req.query.fresh !== '1' && snapshot && snapshot.reachable && snapshot.statsTs;
  try {
    const containers = useSnapshot ? snapshot.containers : await listContainers(host);
    const sinceTs = Date.now() - 3_600_000;
    const restartCounts = db.getRestartCountsByContainer(req.params.hostId, sinceTs);
    // The snapshot's container objects are the collector's own and get read on every poll -
    // copy rather than annotating them in place with a field only this response wants.
    res.json(containers.map((c) => ({ ...c, restartCount1h: restartCounts.get(c.id) || 0 })));
  } catch (err) {
    dockerError(res, err);
  }
});

// The viewer role means "can't change anything", not "can read every secret on every host" - and
// Config.Env is where DB passwords and API keys live. Viewers get variable names with the values
// masked, flagged by envMasked so the UI can say so rather than look like the values are blank.
api.get('/hosts/:hostId/containers/:id/inspect', requireHost, requireContainerId, async (req, res) => {
  const host = req.host;
  try {
    const inspect = await getContainerInspect(host, req.params.id);
    if (req.session.role === 'admin') return res.json(inspect);
    res.json({ ...inspect, env: maskEnvValues(inspect.env), envMasked: true });
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/info', requireHost, async (req, res) => {
  const host = req.host;
  try {
    res.json(await getHostInfo(host));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/stats', requireHost, async (req, res) => {
  const host = req.host;
  // Prefer metricsCollector's snapshot: it's the only place NET/DISK rate data lives, and it's
  // at most POLL_MS stale. Falls back to a live call when there's no snapshot yet - gated on
  // statsTs, not just reachable, since a freshly-added host has empty stats until its first poll.
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  if (snapshot && snapshot.reachable && snapshot.statsTs) return res.json(snapshot.stats);
  try {
    res.json(await getStats(host));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/topology', requireHost, async (req, res) => {
  const host = req.host;
  try {
    const snapshot = metricsCollector.getSnapshot(host.id);
    const topology = await getTopology(host, snapshot);
    const alertCounts = db.getOpenAlertCountsByContainer(host.id);
    for (const node of topology.nodes) node.openAlerts = alertCounts.get(node.id) || 0;
    res.json(topology);
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/disk-usage', requireHost, async (req, res) => {
  const host = req.host;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  if (snapshot && snapshot.diskUsage) return res.json(snapshot.diskUsage);
  try {
    res.json(await getDiskUsage(host));
  } catch (err) {
    dockerError(res, err);
  }
});

// Separate from the route above (and not part of the regular disk-usage poll/snapshot) since -v
// is extra work to walk every image's shared/unique layer sizes - only fetched on demand, when
// the Images disclosure in the Disk tile is actually opened.
api.get('/hosts/:hostId/disk-usage/images', requireHost, async (req, res) => {
  const host = req.host;
  try {
    res.json(await getDiskUsageImages(host));
  } catch (err) {
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/metrics/history', requireHost, (req, res) => {
  const range = HISTORY_RANGES[req.query.range] || HISTORY_RANGES['1h'];
  const sinceTs = Date.now() - range.sinceMs;
  const { containerId } = req.query;
  const rows = containerId
    ? db.getContainerMetricsHistory(req.params.hostId, containerId, sinceTs, range.bucketMs)
    : db.getHostMetricsHistory(req.params.hostId, sinceTs, range.bucketMs);
  res.json(rows);
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

api.get('/hosts/:hostId/events/stream', requireHost, (req, res) => {
  const unsubscribe = eventWatcher.broadcaster.subscribe(res, req.params.hostId);
  req.on('close', unsubscribe);
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
  // Log only the scheme, never the full URL - webhook URLs embed secrets (Discord token, Slack
  // path, ntfy topic) that have no business sitting in the container's log output.
  logger.info('settings.webhook.update', {
    user: req.session.username,
    url: url ? new URL(url).protocol + '//…' : '(cleared)',
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
  const host = req.host;
  try {
    await testHostConnection(host);
    res.json({ ok: true });
  } catch (err) {
    dockerError(res, err);
  }
});

api.post('/hosts/:hostId/containers/:id/:action', requireAdmin, requireHost, requireContainerId, async (req, res) => {
  const host = req.host;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  const container = (snapshot?.containers || []).find((c) => c.id === req.params.id);
  const logFields = { user: req.session.username, host: req.params.hostId, container: container ? container.name : req.params.id };

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

  try {
    await containerAction(host, req.params.id, req.params.action);
    db.updateAuditLogResult(auditId, 'ok', null);
    logger.info(`container.${req.params.action}`, logFields);
    res.json({ ok: true });
  } catch (err) {
    const detail = err.stderr || err.message;
    db.updateAuditLogResult(auditId, 'error', detail);
    logger.error(`container.${req.params.action}`, { ...logFields, error: detail });
    dockerError(res, err);
  }
});

api.get('/hosts/:hostId/containers/:id/logs', requireHost, requireContainerId, (req, res) => {
  const host = req.host;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const child = streamLogs(host, req.params.id, { tail: tailParam(req.query.tail, 200) });

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
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    child.kill();
    res.end();
  };

  child.on('error', (err) => {
    res.write(`data: [opendockwatch] failed to stream logs: ${err.message}\n\n`);
    cleanup();
  });
  child.on('close', cleanup);

  req.on('close', cleanup);
});

api.get('/hosts/:hostId/containers/:id/logs/download', requireHost, requireContainerId, (req, res) => {
  const host = req.host;

  const child = downloadLogs(host, req.params.id, { tail: tailParam(req.query.tail, 5000) });

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
  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console -- plain startup banner, not a structured logger.js event
    console.log(`[opendockwatch] listening on http://localhost:${PORT}`);
    alerts.loadBreachState();
    alerts.start();
    eventWatcher.start();
    metricsCollector.start();
    watchdog.start();
  });

  // Node defaults to 300s here - five minutes of a held connection slot for a request that's
  // never answering (see requestTimeout above). This is the socket-level backstop for anything
  // middleware doesn't cover; keepAliveTimeout stays under it so idle sockets get recycled.
  server.requestTimeout = REQUEST_TIMEOUT_MS + 10_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 20_000;

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
    // eslint-disable-next-line no-console -- plain shutdown banner, not a structured logger.js event
    console.log(`[opendockwatch] received ${signal}, shutting down`);
    watchdog.stop();
    metricsCollector.stop();
    eventWatcher.stop();
    alerts.stop();

    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      db.close();
      process.exit(0);
    };

    // server.close() waits for open connections to end, but log/event SSE streams
    // are intentionally long-lived - don't let them block shutdown indefinitely.
    server.close(finish);
    setTimeout(finish, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, api, requestTimeout };
