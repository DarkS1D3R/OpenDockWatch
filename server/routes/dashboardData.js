const db = require('../db');
const metricsCollector = require('../metricsCollector');
const { listContainers, getStats, getTopology } = require('../docker');
// The module object too, for iconHintFor - same reasoning as containers.js's docker require.
const docker = require('../docker');
const { HISTORY_RANGES } = require('../historyRanges');

// The four builders below each back both their own route and one field of the /dashboard bundle.
// They exist as functions for exactly that reason: the bundle is the same data the separate routes
// return, and two copies of "what a container row carries" would be free to drift apart silently.

// Keyed off the collector's own statsTs, not a wall-clock timer, so this reruns once per poll
// tick rather than once per request. See server/CLAUDE.md.
const restartCountsCache = new Map(); // hostId -> { statsTs, counts }

// Mirrors docker.js's/alerts.js's own forgetHost: without this, a host deleted (or edited, which
// is remove+re-add under a fresh connection) leaves a stale entry keyed by an id Settings may
// later reuse for an unrelated daemon.
function forgetDashboardCaches(hostId) {
  restartCountsCache.delete(hostId);
  dashboardExtrasCache.delete(hostId);
}

function restartCountsFor(hostId, statsTs) {
  const cached = restartCountsCache.get(hostId);
  if (statsTs && cached && cached.statsTs === statsTs) return cached.counts;
  const counts = db.getRestartCountsByContainer(hostId, Date.now() - 3_600_000);
  restartCountsCache.set(hostId, { statsTs, counts });
  return counts;
}

// Served from the collector's snapshot, same reason as statsFor: at most POLL_MS stale (the
// browser's own poll interval anyway), avoiding a live `docker ps` per tab per 5s. fresh forces a
// live call right after a start/stop/restart, where staleness reads as "didn't work".
async function containersFor(host, { fresh = false } = {}) {
  const snapshot = metricsCollector.getSnapshot(host.id);
  const useSnapshot = !fresh && snapshot && snapshot.reachable && snapshot.statsTs;
  const containers = useSnapshot ? snapshot.containers : await listContainers(host);
  // fresh means "a start/stop/restart just happened, staleness reads as didn't work" - that
  // applies to restartCount1h too, so it bypasses the cache here the same way the container list
  // itself bypasses the snapshot above, rather than serving a count from before the action.
  const restartCounts = restartCountsFor(host.id, fresh ? null : snapshot && snapshot.statsTs);
  // The snapshot's container objects are the collector's own and get read on every poll - copy
  // rather than annotating them in place with a field only this response wants.
  return containers.map((c) => ({
    ...c,
    restartCount1h: restartCounts.get(c.id) || 0,
    iconHint: docker.iconHintFor(host.id, c.id),
  }));
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

// The /dashboard bundle: one request instead of four serial ones, all snapshot/sqlite with no
// docker call. Topology is deliberately excluded (it can still shell out). See server/CLAUDE.md.
const DASHBOARD_ALERT_LIMIT = 100;

// Same reasoning as restartCountsFor, for the bundle's other two DB-only fields. Scoped to this
// route's own fixed args rather than folded into hostHistoryFor/db.getAlerts, whose other callers
// use args this cache doesn't cover. See server/CLAUDE.md.
const dashboardExtrasCache = new Map(); // hostId -> { statsTs, metricsHistory, alerts }

function dashboardExtrasFor(host, statsTs) {
  const cached = dashboardExtrasCache.get(host.id);
  if (statsTs && cached && cached.statsTs === statsTs) return cached;
  const extras = {
    statsTs,
    metricsHistory: hostHistoryFor(host.id, '1h'),
    alerts: db.getAlerts(host.id, { limit: DASHBOARD_ALERT_LIMIT }),
  };
  dashboardExtrasCache.set(host.id, extras);
  return extras;
}

module.exports = { containersFor, statsFor, hostHistoryFor, topologyFor, dashboardExtrasFor, forgetDashboardCaches };
