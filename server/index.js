require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const { requireAuth, verifyLogin } = require('./auth');
const { loadHosts, getHost } = require('./hosts');
const { checkHost, listContainers, containerAction, streamLogs, getStats, getTopology, getHostInfo, getDiskUsage } = require('./docker');
const db = require('./db');
const eventWatcher = require('./eventWatcher');
const metricsCollector = require('./metricsCollector');
const prometheus = require('./prometheus');

const app = express();
const PORT = process.env.PORT || 3000;

const HISTORY_RANGES = {
  '1h': { sinceMs: 3_600_000, bucketMs: 15_000 },
  '24h': { sinceMs: 86_400_000, bucketMs: 5 * 60_000 },
  '7d': { sinceMs: 7 * 86_400_000, bucketMs: 30 * 60_000 },
};

if (!process.env.SESSION_SECRET) {
  console.warn('[opendockwatch] SESSION_SECRET not set - using an insecure default. Set it in .env.');
}

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  })
);

app.use('/assets', express.static(path.join(__dirname, '../public'), { index: false }));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const ok = await verifyLogin(username, password);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ ok: true });
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
    for (const c of containers) {
      c.restartCount1h = db.countRestartsSince(req.params.hostId, c.id, sinceTs);
    }
    res.json(containers);
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
    res.json(await getTopology(host));
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

api.post('/hosts/:hostId/containers/:id/:action', async (req, res) => {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  const container = (snapshot?.containers || []).find((c) => c.id === req.params.id);
  try {
    await containerAction(host, req.params.id, req.params.action);
    db.insertAuditLog({
      ts: Date.now(),
      username: req.session.username || null,
      hostId: req.params.hostId,
      containerId: req.params.id,
      containerName: container ? container.name : null,
      action: req.params.action,
      result: 'ok',
      error: null,
    });
    res.json({ ok: true });
  } catch (err) {
    db.insertAuditLog({
      ts: Date.now(),
      username: req.session.username || null,
      hostId: req.params.hostId,
      containerId: req.params.id,
      containerName: container ? container.name : null,
      action: req.params.action,
      result: 'error',
      error: err.stderr || err.message,
    });
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

  const send = (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length) res.write(`data: ${line}\n\n`);
    }
  };

  child.stdout.on('data', send);
  child.stderr.on('data', send);
  child.on('error', (err) => {
    res.write(`data: [opendockwatch] failed to stream logs: ${err.message}\n\n`);
  });

  req.on('close', () => {
    child.kill();
  });
});

app.use('/api', api);

app.listen(PORT, () => {
  console.log(`[opendockwatch] listening on http://localhost:${PORT}`);
  eventWatcher.start();
  metricsCollector.start();
});
