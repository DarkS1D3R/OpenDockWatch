// One row per host for GET /overview, built only from what the server already holds: the collector's
// snapshot, the open-alert count and the last reachability transition. No docker call, so a host
// that is down costs nothing to report. See docs/architecture/server.md.

// The name /hosts shows: the configured one, else a local daemon's own hostname, else the id.
function hostDisplayName(host, snapshot) {
  return host.name || (!host.dockerHost && snapshot && snapshot.hostInfo ? snapshot.hostInfo.hostname : null) || host.id;
}

function countContainers(containers) {
  const out = { total: 0, running: 0, unhealthy: 0, restarting: 0 };
  for (const c of containers || []) {
    out.total += 1;
    if (c.state === 'running') out.running += 1;
    if (c.state === 'restarting') out.restarting += 1;
    if (c.health === 'unhealthy') out.unhealthy += 1;
  }
  return out;
}

// 'pending' until the first poll lands, 'down' while unreachable, 'warning' when something on the
// host wants a look (an open alert, an unhealthy or restarting container), otherwise 'ok'.
function hostStatus({ polled, reachable, openAlerts, containers }) {
  if (!polled) return 'pending';
  if (!reachable) return 'down';
  if (openAlerts > 0 || (containers && (containers.unhealthy > 0 || containers.restarting > 0))) return 'warning';
  return 'ok';
}

function hostOverview({ host, snapshot, openAlerts = 0, lastReachability = null, imageUpdates = 0 }) {
  const polled = !!(snapshot && snapshot.ts);
  const reachable = polled ? snapshot.reachable !== false : null;
  // Counted only once a poll has delivered a container list: before that, or while down, zero
  // containers would read as "this host runs nothing" rather than "unknown".
  const containers = reachable && snapshot.statsTs ? countContainers(snapshot.containers) : null;
  const usage = reachable ? snapshot.usage : null;
  const hostInfo = reachable ? snapshot.hostInfo : null;
  const row = {
    id: host.id,
    name: hostDisplayName(host, snapshot),
    remote: !!host.dockerHost && host.dockerHost.startsWith('ssh://'),
    // Last known, kept while down - the engine doesn't change because the host went away.
    engine: (snapshot && snapshot.hostInfo && snapshot.hostInfo.engine) || null,
    polled,
    reachable,
    downSince: reachable === false && lastReachability && !lastReachability.reachable ? lastReachability.ts : null,
    containers,
    cpuPercent: usage ? usage.cpuPercent : null,
    memUsedBytes: usage ? usage.memUsedBytes : null,
    memTotalBytes: hostInfo ? hostInfo.memTotalBytes || null : null,
    openAlerts,
    // Not part of status: a newer image is something to plan for, not something wrong.
    imageUpdates: reachable ? imageUpdates : 0,
  };
  row.status = hostStatus(row);
  return row;
}

module.exports = { hostDisplayName, countContainers, hostStatus, hostOverview };
