const db = require('./db');

const COOLDOWN_MS = 10 * 60 * 1000;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LOOP_THRESHOLD = 3;
const MANUAL_STOP_GRACE_MS = 5000;

function shouldFire(hostId, containerId, rule) {
  const last = db.getLastAlertFireTs(hostId, containerId, rule);
  if (!last) return true;
  return Date.now() - last > COOLDOWN_MS;
}

async function notify(alert) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const format = process.env.ALERT_WEBHOOK_FORMAT || 'generic';
  const body =
    format === 'slack'
      ? { text: `*[opendockwatch] ${alert.severity.toUpperCase()}* ${alert.hostId}/${alert.containerName || alert.containerId || ''}: ${alert.message}` }
      : alert;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[opendockwatch] alert webhook delivery failed: ${err.message}`);
  }
}

function fire({ hostId, containerId, containerName, rule, severity, message }) {
  if (!shouldFire(hostId, containerId, rule)) return;
  const ts = Date.now();
  const id = db.insertAlert({ ts, hostId, containerId, containerName, rule, severity, message });
  notify({ id, ts, hostId, containerId, containerName, rule, severity, message });
}

function handleEvent(event) {
  const { hostId, containerId, containerName, action, ts, raw } = event;

  if (action === 'die') {
    const exitCode = raw && raw.Actor && raw.Actor.Attributes ? raw.Actor.Attributes.exitCode : undefined;
    const code = exitCode !== undefined ? parseInt(exitCode, 10) : 0;
    if (code !== 0) {
      const recentManualStop = db.countManualStopsSince(hostId, containerId, ts - MANUAL_STOP_GRACE_MS) > 0;
      if (!recentManualStop) {
        fire({
          hostId,
          containerId,
          containerName,
          rule: 'container_crashed',
          severity: 'critical',
          message: `Container ${containerName || containerId} exited with code ${code}`,
        });
      }
    }
  }

  if (action === 'start' || action === 'restart') {
    const sinceTs = ts - CRASH_LOOP_WINDOW_MS;
    const count = db.countRestartsSince(hostId, containerId, sinceTs);
    // Exclude restarts the user triggered themselves (e.g. clicking Restart a few
    // times) so a burst of manual actions doesn't read as a crash loop.
    const manualCount = db.countManualStartsSince(hostId, containerId, sinceTs);
    if (count - manualCount >= CRASH_LOOP_THRESHOLD) {
      fire({
        hostId,
        containerId,
        containerName,
        rule: 'crash_loop',
        severity: 'critical',
        message: `Container ${containerName || containerId} restarted ${count} times in the last 5 minutes`,
      });
    }
  }

  if (action === 'health_status: unhealthy') {
    fire({
      hostId,
      containerId,
      containerName,
      rule: 'unhealthy',
      severity: 'warning',
      message: `Container ${containerName || containerId} is unhealthy`,
    });
  }
}

function handleHostReachability(hostId, hostName, reachable, wasReachable) {
  if (wasReachable && !reachable) {
    fire({
      hostId,
      containerId: null,
      containerName: null,
      rule: 'host_unreachable',
      severity: 'critical',
      message: `Host ${hostName || hostId} became unreachable`,
    });
  }
}

module.exports = { handleEvent, handleHostReachability };
