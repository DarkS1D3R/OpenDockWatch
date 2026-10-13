const metricsCollector = require('./metricsCollector');
const db = require('./db');
const { parseMemUsedBytes } = require('./docker');

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// lagMs comes from the watchdog, which index.js owns, so the caller passes it in.
function render({ lagMs = 0 } = {}) {
  const cpuLines = [];
  const memLines = [];
  const restartLines = [];
  const hostContainersLines = [];
  const alertsLines = [];
  const reachableLines = [];

  for (const [hostId, snap] of metricsCollector.getAllSnapshots()) {
    const restartCounts = db.getRestartCountsByContainer(hostId, Date.now() - 3_600_000);
    for (const c of snap.containers || []) {
      const stat = snap.stats[c.id] || {};
      const labels = `host="${esc(hostId)}",container="${esc(c.name)}",compose_project="${esc(c.composeProject || '')}"`;
      cpuLines.push(`opendockwatch_container_cpu_percent{${labels}} ${parseFloat(stat.cpuPerc) || 0}`);
      memLines.push(`opendockwatch_container_mem_used_bytes{${labels}} ${Math.round(parseMemUsedBytes(stat.memUsage))}`);
      restartLines.push(`opendockwatch_container_restarts_1h{${labels}} ${restartCounts.get(c.id) || 0}`);
    }
    hostContainersLines.push(
      `opendockwatch_host_containers_running{host="${esc(hostId)}"} ${snap.hostInfo ? snap.hostInfo.containersRunning : 0}`
    );
    reachableLines.push(`opendockwatch_host_reachable{host="${esc(hostId)}"} ${snap.reachable === false ? 0 : 1}`);
    alertsLines.push(`opendockwatch_alerts_open{host="${esc(hostId)}"} ${db.countOpenAlerts(hostId)}`);
  }

  const poll = metricsCollector.peekPollStats();

  return (
    [
      '# HELP opendockwatch_container_cpu_percent Container CPU usage percent',
      '# TYPE opendockwatch_container_cpu_percent gauge',
      ...cpuLines,
      '# HELP opendockwatch_container_mem_used_bytes Container memory usage in bytes',
      '# TYPE opendockwatch_container_mem_used_bytes gauge',
      ...memLines,
      '# HELP opendockwatch_container_restarts_1h Container restarts in the trailing hour',
      '# TYPE opendockwatch_container_restarts_1h gauge',
      ...restartLines,
      '# HELP opendockwatch_host_containers_running Running containers on host',
      '# TYPE opendockwatch_host_containers_running gauge',
      ...hostContainersLines,
      '# HELP opendockwatch_alerts_open Open (unacknowledged, unresolved) alerts for host',
      '# TYPE opendockwatch_alerts_open gauge',
      ...alertsLines,
      '# HELP opendockwatch_host_reachable Whether the host answered its last poll (1) or not (0)',
      '# TYPE opendockwatch_host_reachable gauge',
      ...reachableLines,
      '# HELP opendockwatch_poll_duration_seconds Duration of the most recent metrics poll',
      '# TYPE opendockwatch_poll_duration_seconds gauge',
      `opendockwatch_poll_duration_seconds ${poll.lastMs / 1000}`,
      '# HELP opendockwatch_event_loop_lag_seconds Most recent event-loop stall measured by the watchdog',
      '# TYPE opendockwatch_event_loop_lag_seconds gauge',
      `opendockwatch_event_loop_lag_seconds ${(Number(lagMs) || 0) / 1000}`,
    ].join('\n') + '\n'
  );
}

module.exports = { render };
