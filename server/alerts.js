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

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function slackText(alert) {
  return `*[opendockwatch] ${alert.severity.toUpperCase()}* ${alert.hostId}/${alert.containerName || alert.containerId || ''}: ${alert.message}`;
}

// Route ALERT_WEBHOOK_URL to the right destination and payload shape based on
// its scheme, apprise-style - one URL picks the service instead of a separate
// named format per integration:
//   discord://<webhook_id>/<webhook_token>
//   ntfy://<server>/<topic>      e.g. ntfy://ntfy.sh/mytopic, or a self-hosted host
//   gotify://<host>/<token>      (http)
//   gotifys://<host>/<token>     (https)
//   https://hooks.slack.com/...  (auto-detected)
//   any other http(s) URL        (generic JSON POST of the alert, or the Slack
//                                  {text} shape if ALERT_WEBHOOK_FORMAT=slack -
//                                  useful for Slack-compatible endpoints, e.g.
//                                  Mattermost, that don't live on hooks.slack.com)
function buildDelivery(rawUrl, alert) {
  const url = new URL(rawUrl);

  if (url.protocol === 'discord:') {
    const id = url.hostname;
    const token = url.pathname.replace(/^\//, '');
    return {
      url: `https://discord.com/api/webhooks/${id}/${token}`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: slackText(alert) }),
    };
  }

  if (url.protocol === 'ntfy:') {
    const topic = url.pathname.replace(/^\//, '');
    return {
      url: `https://${url.host}/${topic}`,
      headers: {
        Title: `opendockwatch: ${alert.severity}`,
        Priority: alert.severity === 'critical' ? 'urgent' : 'default',
      },
      body: alert.message,
    };
  }

  if (url.protocol === 'gotify:' || url.protocol === 'gotifys:') {
    const scheme = url.protocol === 'gotifys:' ? 'https' : 'http';
    const token = url.pathname.replace(/^\//, '');
    return {
      url: `${scheme}://${url.host}/message?token=${token}`,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: `opendockwatch: ${alert.severity}`,
        message: alert.message,
        priority: alert.severity === 'critical' ? 8 : 4,
      }),
    };
  }

  const isSlack = url.hostname === 'hooks.slack.com' || process.env.ALERT_WEBHOOK_FORMAT === 'slack';
  return {
    url: rawUrl,
    headers: JSON_HEADERS,
    body: JSON.stringify(isSlack ? { text: slackText(alert) } : alert),
  };
}

async function notify(alert) {
  const rawUrl = process.env.ALERT_WEBHOOK_URL;
  if (!rawUrl) return;

  let delivery;
  try {
    delivery = buildDelivery(rawUrl, alert);
  } catch (err) {
    console.error(`[opendockwatch] invalid ALERT_WEBHOOK_URL: ${err.message}`);
    return;
  }

  try {
    await fetch(delivery.url, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
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

module.exports = { handleEvent, handleHostReachability, buildDelivery };
