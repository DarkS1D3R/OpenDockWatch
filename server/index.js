// quiet: true suppresses dotenv's own startup banner (an "injected env... tip:" line pointing at
// a promotional third-party URL) so it doesn't pollute the container's log output alongside the
// structured [opendockwatch] lines below.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const SqliteStore = require('better-sqlite3-session-store')(session);

const { requireAuth, requireAdmin, verifyLogin } = require('./auth');
const { loadHosts, getHost, saveHosts, isValidHostId, isValidDockerHostUrl, hasLocalHost } = require('./hosts');
const {
  checkHost,
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
} = require('./docker');
const db = require('./db');
const logger = require('./logger');
const alerts = require('./alerts');
const eventWatcher = require('./eventWatcher');
const metricsCollector = require('./metricsCollector');
const prometheus = require('./prometheus');
const { version: appVersion } = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3000;

const SSE_HEARTBEAT_MS = 30_000;

const HISTORY_RANGES = {
  '1h': { sinceMs: 3_600_000, bucketMs: 15_000 },
  '24h': { sinceMs: 86_400_000, bucketMs: 5 * 60_000 },
  '7d': { sinceMs: 7 * 86_400_000, bucketMs: 30 * 60_000 },
};

if (!process.env.SESSION_SECRET) {
  console.warn('[opendockwatch] SESSION_SECRET not set - using an insecure default. Set it in .env.');
}

// Behind a reverse proxy terminating TLS (nginx, etc.), this is required for
// `cookie.secure: 'auto'` below to correctly mark the session cookie Secure, and for
// req.ip/the login rate limiter to see the real client IP instead of the proxy's.
// Left off by default: if OpenDockWatch is reachable directly (no proxy in front), trusting
// X-Forwarded-For lets a client spoof req.ip on every request, which defeats the login rate
// limiter (a fresh "IP" per attempt) and forges the IP in auth.failure log lines.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

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

app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const account = await verifyLogin(username, password);
    if (!account) {
      logger.warn('auth.failure', { user: username, ip: req.ip });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    req.session.authenticated = true;
    req.session.username = account.username;
    req.session.role = account.role;
    logger.info('auth.success', { user: account.username, role: account.role, ip: req.ip });
    res.json({ ok: true, role: account.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prometheus scrapers can't do session-cookie auth, so /metrics lives outside the
// requireAuth-protected router and is gated by a separate shared-secret token instead.
app.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token;
    if (provided !== token) return res.status(401).send('unauthorized');
  }
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

api.get('/session', (req, res) => {
  res.json({ username: req.session.username, role: req.session.role, version: appVersion });
});

api.get('/hosts', async (req, res) => {
  const hosts = loadHosts();
  const results = await Promise.all(
    hosts.map(async (h) => {
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

api.get('/hosts/:hostId/containers', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  try {
    const containers = await listContainers(host);
    const sinceTs = Date.now() - 3_600_000;
    const restartCounts = db.getRestartCountsByContainer(req.params.hostId, sinceTs);
    for (const c of containers) {
      c.restartCount1h = restartCounts.get(c.id) || 0;
    }
    res.json(containers);
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/containers/:id/inspect', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  try {
    res.json(await getContainerInspect(host, req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/info', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  try {
    res.json(await getHostInfo(host));
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/stats', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  // Prefer metricsCollector's snapshot over a fresh `docker stats` call: it's the only place the
  // NET/DISK rx/tx and read/write rates (computed from consecutive polls) are available, and it's
  // already at most POLL_MS stale. Falls back to a live call when there's no snapshot yet - gated
  // on statsTs, not just reachable, since a freshly-added host (or one right after boot) has a
  // reachable snapshot with empty stats until its first poll's docker calls finish (same reason
  // getTopology below guards on snapshot.containers.length rather than just snapshot.reachable).
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  if (snapshot && snapshot.reachable && snapshot.statsTs) return res.json(snapshot.stats);
  try {
    res.json(await getStats(host));
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/topology', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  try {
    const snapshot = metricsCollector.getSnapshot(host.id);
    const topology = await getTopology(host, snapshot);
    const alertCounts = db.getOpenAlertCountsByContainer(host.id);
    for (const node of topology.nodes) node.openAlerts = alertCounts.get(node.id) || 0;
    res.json(topology);
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/disk-usage', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  if (snapshot && snapshot.diskUsage) return res.json(snapshot.diskUsage);
  try {
    res.json(await getDiskUsage(host));
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

// Separate from the route above (and not part of the regular disk-usage poll/snapshot) since -v
// is extra work to walk every image's shared/unique layer sizes - only fetched on demand, when
// the Images disclosure in the Disk tile is actually opened.
api.get('/hosts/:hostId/disk-usage/images', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  try {
    res.json(await getDiskUsageImages(host));
  } catch (err) {
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/metrics/history', (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  const range = HISTORY_RANGES[req.query.range] || HISTORY_RANGES['1h'];
  const sinceTs = Date.now() - range.sinceMs;
  const { containerId } = req.query;
  const rows = containerId
    ? db.getContainerMetricsHistory(req.params.hostId, containerId, sinceTs, range.bucketMs)
    : db.getHostMetricsHistory(req.params.hostId, sinceTs, range.bucketMs);
  res.json(rows);
});

api.get('/hosts/:hostId/events', (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  const since = req.query.since ? Number(req.query.since) : 0;
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const rows = db.getEvents(req.params.hostId, { sinceTs: since, limit });
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

api.get('/hosts/:hostId/events/stream', (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  const unsubscribe = eventWatcher.broadcaster.subscribe(res, req.params.hostId);
  req.on('close', unsubscribe);
});

api.get('/audit', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  res.json(db.getAuditLog(req.query.hostId || null, { limit }));
});

api.get('/alerts', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  res.json(db.getAlerts(req.query.hostId || null, { limit }));
});

api.post('/alerts/:id/ack', (req, res) => {
  db.ackAlert(Number(req.params.id));
  res.json({ ok: true });
});

api.post('/alerts/ack-all', (req, res) => {
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
// writes straight to config/hosts.json via saveHosts() and immediately starts/stops the
// corresponding background polling (metricsCollector) and event watching (eventWatcher) for that
// one host, so changes take effect without restarting the process.
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

api.post('/hosts/:hostId/containers/:id/:action', requireAdmin, async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  const container = (snapshot?.containers || []).find((c) => c.id === req.params.id);
  const logFields = { user: req.session.username, host: req.params.hostId, container: container ? container.name : req.params.id };

  // Written before containerAction runs, not after it resolves - the daemon emits the
  // die/start event the container action causes as soon as it happens, which can reach
  // eventWatcher before this CLI call returns (particularly a slow-to-stop container - see
  // docker.js's CONTAINER_ACTION_TIMEOUT_MS comment). alerts.js's manual-stop/crash-loop
  // suppression looks this row up by ts, so it needs to already exist at that moment rather
  // than only appearing afterward, or a fast event races it and a manual stop/restart
  // falsely reports as a crash.
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
    db.updateAuditLogResult(auditId, 'error', err.stderr || err.message);
    logger.error(`container.${req.params.action}`, { ...logFields, error: err.stderr || err.message });
    res.status(502).json({ error: err.stderr || err.message });
  }
});

api.get('/hosts/:hostId/containers/:id/logs', (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const child = streamLogs(host, req.params.id, { tail: req.query.tail || 200 });

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
  child.on('error', (err) => {
    res.write(`data: [opendockwatch] failed to stream logs: ${err.message}\n\n`);
  });

  // Behind nginx or any proxy with an idle timeout, a quiet log stream gets cut -
  // a periodic comment line keeps the connection alive.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    child.kill();
  });
});

api.get('/hosts/:hostId/containers/:id/logs/download', (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });

  const tail = req.query.tail || 5000;
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

const server = app.listen(PORT, () => {
  console.log(`[opendockwatch] listening on http://localhost:${PORT}`);
  eventWatcher.start();
  metricsCollector.start();
});

// Without this, `docker stop` sends SIGTERM and the default handler kills the
// process immediately - potentially mid-write to the sqlite db.
function shutdown(signal) {
  console.log(`[opendockwatch] received ${signal}, shutting down`);
  metricsCollector.stop();
  eventWatcher.stop();

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
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
