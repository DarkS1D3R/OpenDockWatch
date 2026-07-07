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
//                                  {text} shape if format is 'slack' - useful
//                                  for Slack-compatible endpoints, e.g.
//                                  Mattermost, that don't live on hooks.slack.com)
function buildDelivery(rawUrl, alert, format) {
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

  const isSlack = url.hostname === 'hooks.slack.com' || format === 'slack';
  return {
    url: rawUrl,
    headers: JSON_HEADERS,
    body: JSON.stringify(isSlack ? { text: slackText(alert) } : alert),
  };
}

const WEBHOOK_URL_KEY = 'alertWebhookUrl';
const WEBHOOK_FORMAT_KEY = 'alertWebhookFormat';

// The webhook can be set two ways: ALERT_WEBHOOK_URL/FORMAT in .env (requires
// a restart to change), or from the UI (Settings, admin-only), which persists
// to the settings table and takes effect immediately. A DB row - even one
// holding an empty string, e.g. to deliberately disable a webhook configured
// in .env - always wins once it exists; db.getSetting returns null only when
// no override has ever been saved.
function getWebhookConfig() {
  const dbUrl = db.getSetting(WEBHOOK_URL_KEY);
  const overridden = dbUrl !== null;
  const url = overridden ? dbUrl : process.env.ALERT_WEBHOOK_URL || '';
  const format = overridden ? db.getSetting(WEBHOOK_FORMAT_KEY) || '' : process.env.ALERT_WEBHOOK_FORMAT || '';
  return { url, format, overridden };
}

function setWebhookConfig({ url, format }) {
  db.setSetting(WEBHOOK_URL_KEY, url || '');
  db.setSetting(WEBHOOK_FORMAT_KEY, format || '');
  return getWebhookConfig();
}

function clearWebhookConfig() {
  db.deleteSetting(WEBHOOK_URL_KEY);
  db.deleteSetting(WEBHOOK_FORMAT_KEY);
  return getWebhookConfig();
}

async function deliverWebhook(rawUrl, alert, format) {
  const delivery = buildDelivery(rawUrl, alert, format);
  const res = await fetch(delivery.url, {
    method: 'POST',
    headers: delivery.headers,
    body: delivery.body,
  });
  if (!res.ok) {
    throw new Error(`webhook responded with HTTP ${res.status}`);
  }
}

async function notify(alert) {
  const { url: rawUrl, format } = getWebhookConfig();
  if (!rawUrl) return;

  try {
    await deliverWebhook(rawUrl, alert, format);
  } catch (err) {
    console.error(`[opendockwatch] alert webhook delivery failed: ${err.message}`);
  }
}

// Fires a synthetic alert through the current webhook config, bypassing
// insertAlert/cooldown - lets the Settings UI give immediate feedback instead
// of waiting for a real crash/unhealthy/etc. event.
async function sendTestAlert() {
  const { url: rawUrl, format } = getWebhookConfig();
  if (!rawUrl) {
    throw new Error('no webhook URL configured');
  }
  const testAlert = {
    id: 0,
    ts: Date.now(),
    hostId: 'test',
    containerId: null,
    containerName: 'test-container',
    rule: 'test',
    severity: 'warning',
    message: 'This is a test alert from OpenDockWatch.',
  };
  await deliverWebhook(rawUrl, testAlert, format);
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

module.exports = {
  handleEvent,
  handleHostReachability,
  buildDelivery,
  getWebhookConfig,
  setWebhookConfig,
  clearWebhookConfig,
  sendTestAlert,
};
