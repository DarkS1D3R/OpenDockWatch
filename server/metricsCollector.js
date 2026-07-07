const { loadHosts } = require('./hosts');
const { listContainers, getStats, getHostInfo, getDiskUsage, checkHost, parseMemUsedBytes } = require('./docker');
const db = require('./db');
const alerts = require('./alerts');

const POLL_MS = 5000;
const DISK_POLL_MS = 60_000;

const snapshots = new Map(); // hostId -> { containers, stats, hostInfo, diskUsage, reachable, ts }
const timers = [];

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

  const snapshot = { containers: [], stats: {}, hostInfo: null, diskUsage: prev ? prev.diskUsage : null, reachable, ts: Date.now() };
  snapshots.set(host.id, snapshot);
  if (!reachable) return;

  try {
    const [containers, stats, hostInfo] = await Promise.all([listContainers(host), getStats(host), getHostInfo(host)]);
    snapshot.containers = containers;
    snapshot.stats = stats;
    snapshot.hostInfo = hostInfo;

    const ts = Date.now();
    let cpuSum = 0;
    let memSum = 0;
    for (const c of containers) {
      if (c.state !== 'running') continue;
      const s = stats[c.id];
      if (!s) continue;
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
    }

    if (hostInfo && hostInfo.ncpu) {
      db.insertHostMetric({
        hostId: host.id,
        ts,
        cpuPercent: cpuSum / hostInfo.ncpu,
        memUsedBytes: memSum,
      });
    }
  } catch (err) {
    console.error(`[dockwatch] metrics poll failed for host ${host.id}: ${err.message}`);
  }
}

async function pollDiskUsage(host) {
  const snapshot = snapshots.get(host.id);
  if (!snapshot || !snapshot.reachable) return;
  try {
    snapshot.diskUsage = await getDiskUsage(host);
  } catch (err) {
    console.error(`[dockwatch] disk usage poll failed for host ${host.id}: ${err.message}`);
  }
}

function start() {
  const hosts = loadHosts();
  for (const host of hosts) {
    pollHost(host);
    pollDiskUsage(host);
    timers.push(setInterval(() => pollHost(host), POLL_MS));
    timers.push(setInterval(() => pollDiskUsage(host), DISK_POLL_MS));
  }

  const metricsRetentionMs = (Number(process.env.METRICS_RETENTION_DAYS) || 7) * 86_400_000;
  const eventsRetentionMs = (Number(process.env.EVENTS_RETENTION_DAYS) || 30) * 86_400_000;
  timers.push(
    setInterval(
      () => db.pruneOld({ metricsRetentionMs, eventsRetentionMs, auditRetentionMs: eventsRetentionMs }),
      60 * 60 * 1000
    )
  );
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { start, stop, getSnapshot, getAllSnapshots, POLL_MS };
