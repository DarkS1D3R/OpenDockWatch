const { loadHosts } = require('./hosts');
// Everything pollHost shells out with goes through the module object rather than a destructured
// binding, so test/metricsCollector.test.js can swap it for a stub and drive the reachability
// branches - which now depend on which of these calls fail - without a docker daemon. The pure
// helpers below have nothing to mock and stay destructured.
const docker = require('./docker');
const { getDiskUsage, parseMemUsedBytes, computeIoRates, containerCounts, forgetHost: forgetDockerHost } = require('./docker');
const statsWatcher = require('./statsWatcher');
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
// now ~80ms of docker calls (it was ~2s before statsWatcher took `docker stats` off this path);
// the worst legitimate one is still a remote host's checkHost (20s) plus the rest, so the
// threshold stays where it is - it only fires when the loop is falling behind, not merely slow.
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

// Everything a poll has to do once it knows the host is down, in one place because it has three
// callers and the alert must fire exactly once per poll. The previous poll's containers/stats are
// cleared here rather than kept: unlike a slow poll, an unreachable host has nothing on the way.
function markUnreachable(snapshot, host, wasReachable) {
  snapshot.reachable = false;
  snapshot.containers = [];
  snapshot.stats = {};
  snapshot.hostInfo = null;
  snapshot.statsTs = undefined;
  // On the transition only, never per poll: the alert says "became unreachable" and stops there,
  // but "timed out after 20000ms" and "Permission denied (publickey)" call for entirely different
  // responses. The reason is kept behind the boolean in docker.js - see lastCheckError.
  if (wasReachable) {
    logger.warn('host.unreachable', { host: host.id, error: docker.lastCheckError(host.id) || 'no error reported' });
  }
  alerts.handleHostReachability(host.id, host.name || host.id, false, wasReachable);
}

async function pollHost(host) {
  const prev = snapshots.get(host.id);
  const wasReachable = prev ? prev.reachable : true;

  // Sampled here rather than inside the reachable/hostInfo block below since it doesn't touch
  // Docker at all - null for a remote host (hostUsage.js). Persisted into the same host_metrics
  // row as the Docker cpuPercent/memUsedBytes so one history fetch covers both, server-persisted.
  const localSystemUsage = host.dockerHost ? null : sampleLocalSystemUsage(host.id);

  // Keep serving the previous poll's containers/stats/hostInfo until fresh values are ready,
  // rather than clearing them up front - the docker calls below take a noticeable fraction of a
  // poll interval, and a request landing in that window would otherwise flash "-" for every row.
  const snapshot = {
    containers: prev ? prev.containers : [],
    stats: prev ? prev.stats : {},
    hostInfo: prev ? prev.hostInfo : null,
    diskUsage: prev ? prev.diskUsage : null,
    statsTs: prev ? prev.statsTs : undefined,
    reachable: wasReachable,
    ts: Date.now(),
  };
  snapshots.set(host.id, snapshot);

  // The probe runs only for a host already believed to be down. A host that is up establishes its
  // own reachability through the calls below - it was making them anyway - and `docker version`
  // sitting serially in front of them cost ~190ms of every 5s poll to re-answer a question they
  // answer for free. The asymmetry is the point: against a host that *is* down, one probe failing
  // fast is cheaper than three calls each waiting out their own timeout, so the probe stays for
  // exactly that case and a host stuck offline never advances past this line.
  if (!wasReachable && !(await docker.checkHost(host))) {
    markUnreachable(snapshot, host, wasReachable);
    return;
  }

  // Both read before the await so they reflect this poll's start, and both kept in the settle list
  // so a fallback still runs in parallel rather than after the others. Two of the three calls are
  // routinely answered without touching the daemon at all: stats from statsWatcher's long-lived
  // stream (`docker stats --no-stream` measured at 1.3-2.0s against a two-container daemon), and
  // info from its TTL cache (almost everything it reports is fixed for a daemon's lifetime).
  const streamed = statsWatcher.getSamples(host.id);
  const cachedInfo = docker.cachedHostInfo(host.id);
  // allSettled, not all: reachability is derived from these, and "one of the three failed" is not
  // the same fact as "the daemon is gone". Anything short of every live call failing is a failed
  // poll on a host that is demonstrably still answering, and firing host_unreachable for that
  // would be a worse answer than the probe this replaced used to give.
  const results = await Promise.allSettled([
    docker.listContainers(host),
    streamed || docker.getStats(host),
    cachedInfo || docker.getHostInfo(host),
  ]);
  const failure = results.find((r) => r.status === 'rejected');

  // Only the calls that actually reached the daemon count towards reachability. A value served
  // from a stream buffer or a cache says nothing about whether the host is still there, so
  // counting one would leave a dead host looking reachable for as long as those stayed warm -
  // up to STALE_SAMPLES_MS or HOST_INFO_TTL_MS of a dashboard reporting a host that is gone.
  // listContainers is always live, so this is never empty.
  const wentToDaemon = [true, !streamed, !cachedInfo];
  const liveResults = results.filter((_, i) => wentToDaemon[i]);

  if (liveResults.every((r) => r.status === 'rejected')) {
    docker.noteHostFailure(host.id, failure.reason);
    markUnreachable(snapshot, host, wasReachable);
    return;
  }
  docker.noteHostReachable(host.id);
  snapshot.reachable = true;
  alerts.handleHostReachability(host.id, host.name || host.id, true, wasReachable);

  // A partial failure leaves the snapshot on the previous poll's values, exactly as the single
  // try/catch around all three used to: a half-updated poll would diff this poll's stats against
  // themselves and write an instant of history that never happened.
  if (failure) {
    logger.error('metrics.poll.failed', { host: host.id, error: failure.reason.stderr || failure.reason.message });
    return;
  }

  try {
    const [containers, stats, info] = results.map((r) => r.value);
    snapshot.containers = containers;
    snapshot.stats = stats;
    // The container counts are the only part of `docker info` that moves between polls, and the
    // list just fetched carries the same facts - so they are recomputed rather than being a reason
    // to refetch. Spread onto a copy: `info` is the object every poll inside the TTL shares.
    const hostInfo = { ...info, ...containerCounts(containers) };
    snapshot.hostInfo = hostInfo;

    const ts = Date.now();
    snapshot.statsTs = ts;
    const elapsedSec = prev && prev.statsTs ? (ts - prev.statsTs) / 1000 : null;
    let cpuSum = 0;
    let memSum = 0;
    // Collected first, then written in one transaction and only then alerted on. Inserting per
    // container cost a commit each; alerting per container mid-loop would have put
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

    // Built here rather than after the write, so it can go into the same transaction as the
    // container samples instead of taking a commit of its own straight afterwards. The
    // alerting it feeds still happens after, below - handleHostSample does its own db writes and
    // fire() is an async webhook, neither of which may be inside a synchronous transaction.
    const hostSample =
      hostInfo && hostInfo.ncpu
        ? {
            hostId: host.id,
            ts,
            cpuPercent: cpuSum / hostInfo.ncpu,
            memUsedBytes: memSum,
            systemCpuPercent: localSystemUsage ? localSystemUsage.cpuPercent : null,
            systemMemUsedBytes: localSystemUsage ? localSystemUsage.memUsedBytes : null,
            systemMemTotalBytes: localSystemUsage ? localSystemUsage.memTotalBytes : null,
          }
        : null;

    db.insertMetrics(samples, hostSample);
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
    // Same idea for the stats stream, but against the *running* set: `docker stats` only ever
    // reports running containers, so this is what keeps a stopped one's last sample from
    // outliving it and a churning host from accumulating an entry per id it has ever seen.
    statsWatcher.retainContainers(
      host.id,
      containers.filter((c) => c.state === 'running').map((c) => c.id)
    );

    if (hostSample) {
      alerts.handleHostSample({
        hostId: host.id,
        hostName: host.name || host.id,
        cpuPercent: hostSample.cpuPercent,
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
  // Driven from here rather than from index.js alongside eventWatcher: the stats stream exists
  // only to feed this collector, so its lifecycle is this collector's, and the settings/hosts
  // routes get it for free through the addHost/removeHost pair they already call.
  statsWatcher.addHost(host);
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
  statsWatcher.removeHost(hostId);
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
  // removeHost already tore down each watched host's stream; this catches any left over from a
  // host that was added to the stream but never reached hostStates.
  statsWatcher.stop();
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
  // Exported for test/metricsCollector.test.js only: reachability is now derived from which of
  // the poll's own calls fail, and the branches that follow from that (the probe gate, the
  // exactly-once alert, what the snapshot keeps) are worth asserting directly.
  pollHost,
  nextDiskDelay,
  POLL_MS,
  DISK_POLL_MS,
  DISK_DUTY_FACTOR,
  DISK_BACKOFF_MAX_MS,
};
