const metricsCollector = require('./metricsCollector');
const db = require('./db');
const { parseMemUsedBytes } = require('./docker');

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function render() {
  const cpuLines = [];
  const memLines = [];
  const restartLines = [];
  const hostContainersLines = [];
  const alertsLines = [];

  for (const [hostId, snap] of metricsCollector.getAllSnapshots()) {
    for (const c of snap.containers || []) {
      const stat = snap.stats[c.id] || {};
      const labels = `host="${esc(hostId)}",container="${esc(c.name)}",compose_project="${esc(c.composeProject || '')}"`;
      cpuLines.push(`opendockwatch_container_cpu_percent{${labels}} ${parseFloat(stat.cpuPerc) || 0}`);
      memLines.push(`opendockwatch_container_mem_used_bytes{${labels}} ${Math.round(parseMemUsedBytes(stat.memUsage))}`);
      restartLines.push(`opendockwatch_container_restarts_1h{${labels}} ${db.countRestartsSince(hostId, c.id, Date.now() - 3_600_000)}`);
    }
    hostContainersLines.push(`opendockwatch_host_containers_running{host="${esc(hostId)}"} ${snap.hostInfo ? snap.hostInfo.containersRunning : 0}`);
    alertsLines.push(`opendockwatch_alerts_open{host="${esc(hostId)}"} ${db.countOpenAlerts(hostId)}`);
  }

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
      '# HELP opendockwatch_alerts_open Open (unacknowledged) alerts for host',
      '# TYPE opendockwatch_alerts_open gauge',
      ...alertsLines,
    ].join('\n') + '\n'
  );
}

module.exports = { render };
