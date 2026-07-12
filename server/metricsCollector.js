const { loadHosts } = require('./hosts');
const { listContainers, getStats, getHostInfo, getDiskUsage, checkHost, parseMemUsedBytes, computeIoRates } = require('./docker');
const db = require('./db');
const alerts = require('./alerts');

const POLL_MS = 5000;
const DISK_POLL_MS = 60_000;

const snapshots = new Map(); // hostId -> { containers, stats, hostInfo, diskUsage, reachable, ts }
const hostStates = new Map(); // hostId -> { pollState, diskTimer } - lets addHost/removeHost target one host
const globalTimers = [];

function getSnapshot(hostId) {
  return snapshots.get(hostId) || null;
}

function getAllSnapshots() {
  return snapshots;
}

async function pollHost(host) {
  const prev = snapshots.get(host.id);
  const reachable = await checkHost(host);
  alerts.handleHostReachability(host.id, host.name || host.id, reachable, prev ? prev.reachable : true);

  // Keep serving the previous poll's containers/stats/hostInfo until the fresh values below are
  // ready, rather than clearing them up front - the docker calls below can take a noticeable
  // fraction of a poll interval, and a GET /stats landing in that window would otherwise see an
  // empty stats map for every container (rendered client-side as a flash of "-" on every refresh).
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
      db.insertContainerMetric({
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
      alerts.handleSample({
        hostId: host.id,
        containerId: c.id,
        containerName: c.name,
        cpuPerc,
        memPerc,
        ts,
        alertsDisabled: c.alertsDisabled,
      });
    }

    if (hostInfo && hostInfo.ncpu) {
      db.insertHostMetric({
        hostId: host.id,
        ts,
        cpuPercent: cpuSum / hostInfo.ncpu,
        memUsedBytes: memSum,
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
    console.error(`[opendockwatch] metrics poll failed for host ${host.id}: ${err.message}`);
  }
}

async function pollDiskUsage(host) {
  const snapshot = snapshots.get(host.id);
  if (!snapshot || !snapshot.reachable) return;
  try {
    snapshot.diskUsage = await getDiskUsage(host);
    alerts.handleDiskUsage({ hostId: host.id, hostName: host.name || host.id, rows: snapshot.diskUsage });
  } catch (err) {
    console.error(`[opendockwatch] disk usage poll failed for host ${host.id}: ${err.message}`);
  }
}

function scheduleHostPolling(host, pollState) {
  const tick = async () => {
    if (pollState.stopped) return;
    try {
      await pollHost(host);
    } finally {
      if (!pollState.stopped) pollState.timer = setTimeout(tick, POLL_MS);
    }
  };
  pollState.timer = setTimeout(tick, POLL_MS);
}

// Starts polling a single host immediately - used both by start() at boot and by the
// settings/hosts routes when a host is added through the GUI, so a newly added (or edited, via
// removeHost+addHost) host is monitored right away instead of needing a process restart.
function addHost(host) {
  if (hostStates.has(host.id)) return;
  const pollState = { stopped: false, timer: null };
  const diskTimer = setInterval(() => pollDiskUsage(host), DISK_POLL_MS);
  hostStates.set(host.id, { pollState, diskTimer });
  pollHost(host);
  pollDiskUsage(host);
  scheduleHostPolling(host, pollState);
}

function removeHost(hostId) {
  const state = hostStates.get(hostId);
  if (!state) return;
  state.pollState.stopped = true;
  clearTimeout(state.pollState.timer);
  clearInterval(state.diskTimer);
  hostStates.delete(hostId);
  snapshots.delete(hostId);
}

function start() {
  for (const host of loadHosts()) addHost(host);

  const metricsRetentionMs = (Number(process.env.METRICS_RETENTION_DAYS) || 7) * 86_400_000;
  const eventsRetentionMs = (Number(process.env.EVENTS_RETENTION_DAYS) || 30) * 86_400_000;
  globalTimers.push(
    setInterval(() => db.pruneOld({ metricsRetentionMs, eventsRetentionMs, auditRetentionMs: eventsRetentionMs }), 60 * 60 * 1000)
  );
}

function stop() {
  for (const t of globalTimers) clearInterval(t);
  globalTimers.length = 0;
  for (const hostId of [...hostStates.keys()]) removeHost(hostId);
}

module.exports = { start, stop, addHost, removeHost, getSnapshot, getAllSnapshots, POLL_MS };
