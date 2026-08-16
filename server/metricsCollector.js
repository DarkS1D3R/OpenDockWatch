const { loadHosts } = require('./hosts');
const {
  listContainers,
  getStats,
  getHostInfo,
  getDiskUsage,
  checkHost,
  parseMemUsedBytes,
  computeIoRates,
  forgetHost: forgetDockerHost,
} = require('./docker');
const hostUsage = require('./hostUsage');
const db = require('./db');
const alerts = require('./alerts');
const logger = require('./logger');

const POLL_MS = 5000;
const DISK_POLL_MS = 60_000;

// The disk poll is the one call whose cost is a property of the *host's storage* rather than of
// anything this app does - see DISK_USAGE_TIMEOUT_MS in docker.js. So its cadence is derived from
// what the last run actually cost instead of being a constant: the next run is at least
// DISK_DUTY_FACTOR times the last duration away, keeping it to a small slice of wall time on any
// host. On native Linux (sub-second) that floors at the plain 60s and nothing changes; on a WSL2
// host where it takes ~75s it becomes ~5 minutes, instead of a 75s call running every 60s and
// holding one of docker.js's 12 concurrency slots almost continuously.
const DISK_DUTY_FACTOR = 4;
// ...and a failing call backs off on top of that, rather than retrying every 60s forever with no
// notion that it has now failed several hundred times in a row.
const DISK_BACKOFF_STEPS = 6;
const DISK_BACKOFF_MAX_MS = 3_600_000;

const snapshots = new Map(); // hostId -> { containers, stats, hostInfo, diskUsage, reachable, ts }
const hostStates = new Map(); // hostId -> { pollState, diskState } - lets addHost/removeHost target one host
const localCpuTimesPrev = new Map(); // hostId -> previous hostUsage.sampleCpuTimes() sample, for computeCpuPercent's delta
const globalTimers = [];

// When the last poll of *any* host finished - the liveness signal watchdog reads. Deliberately
// about the loop, not Docker: pollHost completes normally even for an unreachable host, so this
// only goes stale if the loop itself stopped turning, never just because a daemon is down.
let lastPollCompletedTs = Date.now();

// How long a poll cycle may take before it's worth a line of its own. A healthy local cycle is
// ~2s of docker calls; the worst legitimate one is a remote host's checkHost (20s) plus the rest,
// so this only fires when the loop is genuinely falling behind rather than merely slow.
const SLOW_POLL_MS = Number(process.env.SLOW_POLL_MS) || 15_000;

// Sampled by index.js's vitals line. `maxMs` is since the last read, not since boot: a single bad
// poll hours ago shouldn't keep pinning the number every minute, and a rising floor across
// consecutive vitals lines is the thing that actually shows the collector degrading. Watchdog
// staleness only fires once the loop has stopped entirely - this is what precedes it.
let pollStats = { lastMs: 0, maxMs: 0, slow: 0 };

function recordPoll(hostId, tookMs) {
  pollStats.lastMs = tookMs;
  pollStats.maxMs = Math.max(pollStats.maxMs, tookMs);
  if (tookMs >= SLOW_POLL_MS) {
    pollStats.slow += 1;
    logger.warn('metrics.poll.slow', { host: hostId, tookMs, thresholdMs: SLOW_POLL_MS });
  }
}

function takePollStats() {
  const out = pollStats;
  pollStats = { lastMs: out.lastMs, maxMs: 0, slow: 0 };
  return out;
}

function getLastPollCompletedTs() {
  return lastPollCompletedTs;
}

function getHostCount() {
  return hostStates.size;
}

function getSnapshot(hostId) {
  return snapshots.get(hostId) || null;
}

function getAllSnapshots() {
  return snapshots;
}

// Real host-wide CPU/mem (not just this app's containers) - only possible for the local host,
// see hostUsage.js. Sampled every poll regardless of Docker reachability, since it doesn't touch
// Docker at all - the host itself can still be worth reporting on even if the daemon is down.
function sampleLocalSystemUsage(hostId) {
  const sample = hostUsage.sampleCpuTimes();
  const cpuPercent = hostUsage.computeCpuPercent(localCpuTimesPrev.get(hostId), sample);
  localCpuTimesPrev.set(hostId, sample);
  const mem = hostUsage.getMemUsage();
  return { cpuPercent, memUsedBytes: mem.usedBytes, memTotalBytes: mem.totalBytes };
}

async function pollHost(host) {
  const prev = snapshots.get(host.id);
  const reachable = await checkHost(host);
  alerts.handleHostReachability(host.id, host.name || host.id, reachable, prev ? prev.reachable : true);

  // Sampled here rather than inside the reachable/hostInfo block below since it doesn't touch
  // Docker at all - null for a remote host (hostUsage.js). Persisted into the same host_metrics
  // row as the Docker cpuPercent/memUsedBytes so one history fetch covers both, server-persisted.
  const localSystemUsage = host.dockerHost ? null : sampleLocalSystemUsage(host.id);

  // Keep serving the previous poll's containers/stats/hostInfo until fresh values are ready,
  // rather than clearing them up front - the docker calls below take a noticeable fraction of a
  // poll interval, and a request landing in that window would otherwise flash "-" for every row.
  const keepPrev = reachable && prev;
  const snapshot = {
    containers: keepPrev ? prev.containers : [],
    stats: keepPrev ? prev.stats : {},
    hostInfo: keepPrev ? prev.hostInfo : null,
    diskUsage: prev ? prev.diskUsage : null,
    statsTs: keepPrev ? prev.statsTs : undefined,
    reachable,
    ts: Date.now(),
  };
  snapshots.set(host.id, snapshot);
  if (!reachable) return;

  try {
    const [containers, stats, hostInfo] = await Promise.all([listContainers(host), getStats(host), getHostInfo(host)]);
    snapshot.containers = containers;
    snapshot.stats = stats;
    snapshot.hostInfo = hostInfo;

    const ts = Date.now();
    snapshot.statsTs = ts;
    const elapsedSec = prev && prev.statsTs ? (ts - prev.statsTs) / 1000 : null;
    let cpuSum = 0;
    let memSum = 0;
    // Collected first, then written in one transaction and only then alerted on. Inserting per
    // container cost a commit (and an fsync) each; alerting per container mid-loop would have put
    // its own db writes - and fire()'s async webhook - inside that transaction. See CLAUDE.md.
    const samples = [];
    const alertSamples = [];
    for (const c of containers) {
      if (c.state !== 'running') continue;
      const s = stats[c.id];
      if (!s) continue;
      const prevS = prev && prev.stats ? prev.stats[c.id] : null;
      Object.assign(s, computeIoRates(s, prevS, elapsedSec));
      const cpuPerc = parseFloat(s.cpuPerc) || 0;
      const memPerc = parseFloat(s.memPerc) || 0;
      cpuSum += cpuPerc;
      const memUsedBytes = Math.round(parseMemUsedBytes(s.memUsage));
      samples.push({
        hostId: host.id,
        containerId: c.id,
        ts,
        cpuPerc,
        memUsedBytes,
        memPerc,
        netRxBytes: Math.round(s.netRxBytes || 0),
        netTxBytes: Math.round(s.netTxBytes || 0),
        blockReadBytes: Math.round(s.blockReadBytes || 0),
        blockWriteBytes: Math.round(s.blockWriteBytes || 0),
      });
      memSum += memUsedBytes;
      alertSamples.push({
        hostId: host.id,
        containerId: c.id,
        containerName: c.name,
        cpuPerc,
        memPerc,
        ts,
        alertsDisabled: c.alertsDisabled,
        composeProject: c.composeProject,
      });
    }

    db.insertContainerMetrics(samples);
    // One settings+rules read for the whole poll rather than one per container - resolved lazily so
    // a host whose containers are all label-disabled still reads nothing. See alerts.alertContext.
    const anyAlerting = alertSamples.some((s) => !s.alertsDisabled);
    const alertCtx = anyAlerting ? alerts.alertContext() : null;
    for (const sample of alertSamples) alerts.handleSample(sample, alertCtx);

    // Containers that have gone away since the last poll can't dip back under threshold to
    // clear their own breach counters, so they're dropped here instead.
    alerts.retainContainers(
      host.id,
      containers.map((c) => c.id)
    );

    if (hostInfo && hostInfo.ncpu) {
      db.insertHostMetric({
        hostId: host.id,
        ts,
        cpuPercent: cpuSum / hostInfo.ncpu,
        memUsedBytes: memSum,
        systemCpuPercent: localSystemUsage ? localSystemUsage.cpuPercent : null,
        systemMemUsedBytes: localSystemUsage ? localSystemUsage.memUsedBytes : null,
        systemMemTotalBytes: localSystemUsage ? localSystemUsage.memTotalBytes : null,
      });
      alerts.handleHostSample({
        hostId: host.id,
        hostName: host.name || host.id,
        cpuPercent: cpuSum / hostInfo.ncpu,
        memPercent: hostInfo.memTotalBytes ? (memSum / hostInfo.memTotalBytes) * 100 : 0,
        ts,
      });
    }
  } catch (err) {
    logger.error('metrics.poll.failed', { host: host.id, error: err.stderr || err.message });
  }
}

// Whichever is longer: keeping the call a small fraction of wall time, or backing off a failing
// one. Both collapse back to the plain interval on a healthy, fast host, so nothing about this is
// visible on the setup it was originally tuned for.
function nextDiskDelay(diskState) {
  const duty = (diskState.lastDurationMs || 0) * DISK_DUTY_FACTOR;
  const backoff = diskState.failures > 0 ? DISK_POLL_MS * 2 ** Math.min(diskState.failures, DISK_BACKOFF_STEPS) : 0;
  return Math.min(DISK_BACKOFF_MAX_MS, Math.max(DISK_POLL_MS, duty, backoff));
}

async function pollDiskUsage(host, diskState) {
  const snapshot = snapshots.get(host.id);
  if (!snapshot || !snapshot.reachable) return;
  const startedAt = Date.now();
  try {
    snapshot.diskUsage = await getDiskUsage(host);
    snapshot.diskUsageError = null;
    diskState.lastDurationMs = Date.now() - startedAt;
    if (diskState.failures > 0) {
      logger.info('disk_usage.poll.recovered', {
        host: host.id,
        afterFailures: diskState.failures,
        tookMs: diskState.lastDurationMs,
      });
      diskState.failures = 0;
    }
    alerts.handleDiskUsage({ hostId: host.id, hostName: host.name || host.id, rows: snapshot.diskUsage });
  } catch (err) {
    diskState.lastDurationMs = Date.now() - startedAt;
    diskState.failures += 1;
    // Kept on the snapshot so the UI can say the measurement failed rather than render an empty
    // panel that reads as "nothing to show". Last known rows are deliberately left in place.
    snapshot.diskUsageError = err.message;
    // warn, not error, and carrying the run of failures: this call being impossible on a given
    // host is one fact about that host, not several hundred separate incidents.
    logger.warn('disk_usage.poll.failed', {
      host: host.id,
      error: err.stderr || err.message,
      failures: diskState.failures,
      tookMs: diskState.lastDurationMs,
      nextInSec: Math.round(nextDiskDelay(diskState) / 1000),
    });
  }
}

function scheduleHostPolling(host, pollState) {
  const tick = async () => {
    if (pollState.stopped) return;
    const startedAt = Date.now();
    try {
      await pollHost(host);
    } catch (err) {
      // pollHost catches its own docker failures, so reaching here means a db/alerts error threw.
      // Swallowing it here matters: an unhandled rejection out of a setTimeout callback is a
      // process-level crash, and one bad sample must not take monitoring down for every host.
      logger.error('metrics.tick.failed', { host: host.id, error: err.message });
    } finally {
      lastPollCompletedTs = Date.now();
      recordPoll(host.id, lastPollCompletedTs - startedAt);
      if (!pollState.stopped) pollState.timer = setTimeout(tick, POLL_MS);
    }
  };
  pollState.timer = setTimeout(tick, POLL_MS);
}

// Chained rather than a setInterval, and the gap is measured from when the last run finished:
// `docker system df` can take longer than the interval itself on some hosts, so a setInterval
// would fire the next sweep while the previous one was still running. The gap is also computed
// per run rather than fixed - see nextDiskDelay.
function scheduleDiskPolling(host, diskState) {
  const tick = async () => {
    if (diskState.stopped) return;
    try {
      await pollDiskUsage(host, diskState);
    } finally {
      if (!diskState.stopped) diskState.timer = setTimeout(tick, nextDiskDelay(diskState));
    }
  };
  diskState.timer = setTimeout(tick, DISK_POLL_MS);
}

// Starts polling a single host immediately - used both by start() at boot and by the
// settings/hosts routes when a host is added through the GUI, so a newly added (or edited, via
// removeHost+addHost) host is monitored right away instead of needing a process restart.
function addHost(host) {
  if (hostStates.has(host.id)) return;
  logger.info('metrics.host.watching', { host: host.id, dockerHost: host.dockerHost || 'local', pollMs: POLL_MS });
  const pollState = { stopped: false, timer: null };
  const diskState = { stopped: false, timer: null, failures: 0, lastDurationMs: 0 };
  hostStates.set(host.id, { pollState, diskState });
  // pollDiskUsage reads the snapshot pollHost writes (snapshot.reachable, set after checkHost
  // resolves) - firing both in parallel left diskUsage empty until the next 60s tick, since the
  // first call found no snapshot yet. pollHost never rejects, so this chain needs no .catch.
  pollHost(host)
    .then(() => pollDiskUsage(host, diskState))
    .catch((err) => logger.error('metrics.initial_poll.failed', { host: host.id, error: err.message }))
    .finally(() => {
      lastPollCompletedTs = Date.now();
    });
  scheduleHostPolling(host, pollState);
  scheduleDiskPolling(host, diskState);
}

function removeHost(hostId) {
  const state = hostStates.get(hostId);
  if (!state) return;
  state.pollState.stopped = true;
  state.diskState.stopped = true;
  clearTimeout(state.pollState.timer);
  clearTimeout(state.diskState.timer);
  hostStates.delete(hostId);
  snapshots.delete(hostId);
  localCpuTimesPrev.delete(hostId);
  alerts.forgetHost(hostId);
  forgetDockerHost(hostId);
  logger.info('metrics.host.stopped', { host: hostId });
}

function start() {
  for (const host of loadHosts()) addHost(host);

  const metricsRetentionMs = (Number(process.env.METRICS_RETENTION_DAYS) || 7) * 86_400_000;
  const eventsRetentionMs = (Number(process.env.EVENTS_RETENTION_DAYS) || 30) * 86_400_000;
  logger.info('metrics.retention', {
    metricsDays: metricsRetentionMs / 86_400_000,
    eventsDays: eventsRetentionMs / 86_400_000,
  });
  // Pruning is the only thing in the app that deletes data, and it ran completely silently -
  // "where did my history go?" had no answer, and neither did "is retention even applying?".
  const prune = () => {
    const deleted = db.pruneOld({ metricsRetentionMs, eventsRetentionMs, auditRetentionMs: eventsRetentionMs });
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total > 0) logger.info('db.pruned', { total, ...deleted });
  };
  // Once up front, not just on the hour: the interval's first tick is an hour away, so an
  // instance that gets restarted more often than that (or one whose retention window was just
  // shortened) would otherwise never prune anything at all.
  prune();
  globalTimers.push(setInterval(prune, 60 * 60 * 1000));
}

function stop() {
  for (const t of globalTimers) clearInterval(t);
  globalTimers.length = 0;
  for (const hostId of [...hostStates.keys()]) removeHost(hostId);
}

module.exports = {
  start,
  stop,
  addHost,
  removeHost,
  getSnapshot,
  getAllSnapshots,
  getLastPollCompletedTs,
  getHostCount,
  takePollStats,
  nextDiskDelay,
  POLL_MS,
  DISK_POLL_MS,
  DISK_DUTY_FACTOR,
  DISK_BACKOFF_MAX_MS,
};
