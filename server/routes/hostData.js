const express = require('express');
const { loadHosts } = require('../hosts');
const { requireAdmin } = require('../auth');
const { checkHost, getHostInfo, getDiskUsage, getDiskUsageImages, getContainerInspect, maskEnvValues } = require('../docker');
// The module object for getContainerTop, so test/index.test.js can stub it without a daemon.
const docker = require('../docker');
const db = require('../db');
const { computeContainerUptime, computeHostUptime } = require('../uptime');
const { HISTORY_RANGES } = require('../historyRanges');
const metricsCollector = require('../metricsCollector');
const { requireHost, requireContainerId, intParam, dockerError } = require('./middleware');
const { containersFor, statsFor, hostHistoryFor, topologyFor, dashboardExtrasFor } = require('./dashboardData');

const router = express.Router();

// The collector already establishes reachability and hostname for every host every POLL_MS -
// probing again per request meant a CLI spawn (and up to a 20s SSH timeout) per browser poll for
// an answer already sitting in memory. Live probes are kept only before a host's first poll lands.
router.get('/hosts', async (req, res) => {
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

router.get('/hosts/:hostId/dashboard', requireHost, async (req, res) => {
  const host = req.odwHost;
  try {
    const [containers, stats] = await Promise.all([containersFor(host), statsFor(host)]);
    const snapshot = metricsCollector.getSnapshot(host.id);
    const extras = dashboardExtrasFor(host, snapshot && snapshot.statsTs);
    res.json({
      containers,
      stats,
      metricsHistory: extras.metricsHistory,
      alerts: extras.alerts,
    });
  } catch (err) {
    dockerError(res, err);
  }
});

router.get('/hosts/:hostId/containers', requireHost, async (req, res) => {
  try {
    res.json(await containersFor(req.odwHost, { fresh: req.query.fresh === '1' }));
  } catch (err) {
    dockerError(res, err);
  }
});

// The viewer role means "can't change anything", not "can read every secret on every host" - and
// Config.Env is where DB passwords and API keys live. Viewers get variable names with the values
// masked, flagged by envMasked so the UI can say so rather than look like the values are blank.
router.get('/hosts/:hostId/containers/:id/inspect', requireHost, requireContainerId, async (req, res) => {
  const host = req.odwHost;
  try {
    const inspect = await getContainerInspect(host, req.params.id);
    if (req.session.role === 'admin') return res.json(inspect);
    res.json({ ...inspect, env: maskEnvValues(inspect.env), envMasked: true });
  } catch (err) {
    dockerError(res, err);
  }
});

// Admin-only like /audit, and for the same reason env is masked for a viewer: a command line is
// where --password=... and tokens end up. Read-only does not mean "may read every secret".
router.get('/hosts/:hostId/containers/:id/top', requireAdmin, requireHost, requireContainerId, async (req, res) => {
  try {
    res.json(await docker.getContainerTop(req.odwHost, req.params.id));
  } catch (err) {
    // docker's own refusal for a stopped container is a state, not a gateway failure.
    if (/is not running/i.test(err.stderr || err.message)) return res.status(409).json({ error: 'container is not running' });
    dockerError(res, err);
  }
});

// Served from the collector's snapshot like /containers and /stats - hit on every host switch by
// every viewer, and its container counts are recomputed from the poll's `docker ps`.
router.get('/hosts/:hostId/info', requireHost, async (req, res) => {
  const host = req.odwHost;
  const snapshot = metricsCollector.getSnapshot(req.params.hostId);
  if (snapshot && snapshot.reachable && snapshot.hostInfo) return res.json(snapshot.hostInfo);
  try {
    res.json(await getHostInfo(host));
  } catch (err) {
    dockerError(res, err);
  }
});

router.get('/hosts/:hostId/stats', requireHost, async (req, res) => {
  try {
    res.json(await statsFor(req.odwHost));
  } catch (err) {
    dockerError(res, err);
  }
});

router.get('/hosts/:hostId/topology', requireHost, async (req, res) => {
  try {
    res.json(await topologyFor(req.odwHost));
  } catch (err) {
    dockerError(res, err);
  }
});

router.get('/hosts/:hostId/disk-usage', requireHost, async (req, res) => {
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
router.get('/hosts/:hostId/disk-usage/images', requireHost, async (req, res) => {
  const host = req.odwHost;
  try {
    res.json(await getDiskUsageImages(host));
  } catch (err) {
    dockerError(res, err);
  }
});

router.get('/hosts/:hostId/metrics/history', requireHost, (req, res) => {
  const { containerId } = req.query;
  if (!containerId) return res.json(hostHistoryFor(req.params.hostId, req.query.range));
  const range = HISTORY_RANGES[req.query.range] || HISTORY_RANGES['1h'];
  res.json(db.getContainerMetricsHistory(req.params.hostId, containerId, Date.now() - range.sinceMs, range.bucketMs));
});

const UPTIME_DAYS_DEFAULT = 30;
const UPTIME_DAYS_MAX = 90;

// Reconstructed from history already retained for events and host_reachability - no new sampling,
// no docker call, so no try/catch. See server/uptime.js and server/CLAUDE.md.
router.get('/hosts/:hostId/uptime', requireHost, (req, res) => {
  const hostId = req.params.hostId;
  const days = intParam(req.query.days, UPTIME_DAYS_DEFAULT, UPTIME_DAYS_MAX) || UPTIME_DAYS_DEFAULT;
  const until = Date.now();
  const since = until - days * 86_400_000;

  const snapshot = metricsCollector.getSnapshot(hostId);
  const host = computeHostUptime({
    transitions: db.getHostReachabilityTransitions(hostId, since),
    since,
    until,
    seedReachable: db.getHostReachabilitySeed(hostId, since),
    liveReachable: snapshot ? snapshot.reachable : null,
  });

  // Union of what's live right now and whatever had a lifecycle event in the window - a container
  // that crashed badly enough to get replaced under a new id is exactly the one worth surfacing,
  // and it would otherwise silently drop out the moment it stops existing.
  const liveById = new Map(((snapshot && snapshot.containers) || []).map((c) => [c.id, c]));
  const containerIds = new Map(liveById);
  for (const row of db.getContainersWithLifecycleEvents(hostId, since)) {
    if (!containerIds.has(row.containerId)) containerIds.set(row.containerId, { id: row.containerId, name: row.containerName });
  }

  const restartCounts = db.getRestartCountsByContainer(hostId, since);
  const containers = [...containerIds.values()].map((c) => {
    const live = liveById.get(c.id);
    const uptime = computeContainerUptime({
      events: db.getContainerLifecycleEvents(hostId, c.id, since),
      since,
      until,
      seedAction: db.getContainerLifecycleSeed(hostId, c.id, since),
      liveState: live ? { running: live.state === 'running', health: live.health } : null,
    });
    return {
      id: c.id,
      name: c.name,
      composeProject: live ? live.composeProject : null,
      removed: !live,
      restartCount: restartCounts.get(c.id) || 0,
      ...uptime,
    };
  });

  res.json({ days, since, until, host, containers });
});

module.exports = router;
