const db = require('./db');
const logger = require('./logger');
const { parseByteString } = require('./docker');

const COOLDOWN_MS = 10 * 60 * 1000;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LOOP_THRESHOLD = 3;
// docker stop/restart's own SIGTERM grace period is 10s (see docker.js's
// CONTAINER_ACTION_TIMEOUT_MS comment) before it SIGKILLs and the die event fires - this has to
// comfortably exceed that, or a container that takes the full grace period to die falls outside
// the lookback window from the die event's ts back to the audit row written when the stop/restart
// was requested, even though the row is now written before the action runs (see index.js).
const MANUAL_STOP_GRACE_MS = 15000;

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

// Resource-threshold rules (container_cpu/container_mem/host_cpu/host_mem/docker_disk).
// Same env-default + DB-override precedent as the webhook config above. All
// thresholds ship disabled (0) by default - existing users shouldn't get
// surprise webhook noise after upgrading. sustainMinutes is shared between the
// cpu and mem rules since both are evaluated from the same 5s stats poll.
const THRESHOLD_KEYS = {
  cpuThreshold: { settingKey: 'alertCpuThreshold', envVar: 'ALERT_CPU_THRESHOLD' },
  memThreshold: { settingKey: 'alertMemThreshold', envVar: 'ALERT_MEM_THRESHOLD' },
  sustainMinutes: { settingKey: 'alertSustainMinutes', envVar: 'ALERT_SUSTAIN_MINUTES', default: 5 },
  diskThresholdGb: { settingKey: 'alertDiskThresholdGb', envVar: 'ALERT_DISK_THRESHOLD_GB' },
};

function numSetting(settingKey, envVar, defaultValue = 0) {
  const dbVal = db.getSetting(settingKey);
  if (dbVal !== null) return dbVal === '' ? defaultValue : Number(dbVal);
  const envVal = process.env[envVar];
  return envVal !== undefined && envVal !== '' ? Number(envVal) : defaultValue;
}

function getThresholdConfig() {
  const config = { overridden: false };
  for (const [field, { settingKey, envVar, default: def }] of Object.entries(THRESHOLD_KEYS)) {
    if (db.getSetting(settingKey) !== null) config.overridden = true;
    config[field] = numSetting(settingKey, envVar, def);
  }
  return config;
}

function setThresholdConfig(values) {
  for (const [field, { settingKey }] of Object.entries(THRESHOLD_KEYS)) {
    db.setSetting(settingKey, String(values[field] ?? 0));
  }
  return getThresholdConfig();
}

function clearThresholdConfig() {
  for (const { settingKey } of Object.values(THRESHOLD_KEYS)) {
    db.deleteSetting(settingKey);
  }
  return getThresholdConfig();
}

// Consecutive-breach tracking, keyed by "hostId:containerId:rule". A single
// sample over threshold is noise (image builds, cron jobs, JVM startup) - the
// rule only fires once the breach has been continuous for sustainMs. Storing
// the timestamp of the *first* breaching sample (rather than a sample count)
// means this is independent of the poll interval and trivially testable with
// synthetic timestamps. Resets the moment a sample dips back under threshold,
// which doubles as hysteresis. In-memory only - counters reset on restart,
// worst case an alert fires a few minutes later than it would have.
const breachStarts = new Map();

function checkSustained(key, breached, sustainMs, ts) {
  if (!breached) {
    breachStarts.delete(key);
    return false;
  }
  let start = breachStarts.get(key);
  if (start === undefined) {
    start = ts;
    breachStarts.set(key, start);
  }
  return ts - start >= sustainMs;
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
  const log = severity === 'critical' ? logger.error : logger.warn;
  log('alert.fired', { host: hostId, container: containerName || containerId, rule, severity, message });
  notify({ id, ts, hostId, containerId, containerName, rule, severity, message });
}

function handleEvent(event) {
  const { hostId, containerId, containerName, action, ts, raw } = event;

  if (action === 'die') {
    const exitCode = raw && raw.Actor && raw.Actor.Attributes ? raw.Actor.Attributes.exitCode : undefined;
    // parseInt of a present-but-garbled attribute (rather than a genuinely missing one, already
    // handled by the `: 0` default) is NaN, and NaN !== 0 is true - without this, an unparsable
    // exit code would still fire but read as "exited with code NaN" instead of a message that
    // actually describes what happened.
    const parsed = exitCode !== undefined ? parseInt(exitCode, 10) : 0;
    const code = Number.isNaN(parsed) ? null : parsed;
    if (code !== 0) {
      const recentManualStop = db.countManualStopsSince(hostId, containerId, ts - MANUAL_STOP_GRACE_MS) > 0;
      if (!recentManualStop) {
        fire({
          hostId,
          containerId,
          containerName,
          rule: 'container_crashed',
          severity: 'critical',
          message: `Container ${containerName || containerId} exited with ${code === null ? 'an unrecognized exit code' : `code ${code}`}`,
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
    const autoCount = count - manualCount;
    if (autoCount >= CRASH_LOOP_THRESHOLD) {
      fire({
        hostId,
        containerId,
        containerName,
        rule: 'crash_loop',
        severity: 'critical',
        // autoCount, not the raw count - the threshold this rule fires on already excludes
        // manual restarts, so reporting the raw count would overstate how many of them actually
        // looked like crashes.
        message: `Container ${containerName || containerId} restarted ${autoCount} times in the last 5 minutes`,
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

// Called once per running container on every stats poll (~5s). cpuPerc is raw
// docker-stats CPU% (per-core cumulative, so a container using 4 cores fully
// reads 400% - matches what the UI already shows, so the threshold isn't
// normalized). memPerc is docker's MemPerc, which is computed against the
// container's own memory limit - containers with no limit set read low against
// host total and rarely trip this, which in practice focuses the rule on
// containers that have limits, i.e. where mem pressure actually OOMKills.
function handleSample({ hostId, containerId, containerName, cpuPerc, memPerc, ts, alertsDisabled }) {
  if (alertsDisabled) return;
  const cfg = getThresholdConfig();
  const sustainMs = cfg.sustainMinutes * 60_000;

  if (cfg.cpuThreshold > 0) {
    const breached = cpuPerc >= cfg.cpuThreshold;
    if (checkSustained(`${hostId}:${containerId}:container_cpu`, breached, sustainMs, ts)) {
      fire({
        hostId,
        containerId,
        containerName,
        rule: 'container_cpu',
        severity: 'warning',
        message: `Container ${containerName || containerId} CPU at ${cpuPerc.toFixed(1)}% (threshold ${cfg.cpuThreshold}%)`,
      });
    }
  }

  if (cfg.memThreshold > 0) {
    const breached = memPerc >= cfg.memThreshold;
    if (checkSustained(`${hostId}:${containerId}:container_mem`, breached, sustainMs, ts)) {
      fire({
        hostId,
        containerId,
        containerName,
        rule: 'container_mem',
        severity: 'warning',
        message: `Container ${containerName || containerId} memory at ${memPerc.toFixed(1)}% (threshold ${cfg.memThreshold}%)`,
      });
    }
  }
}

// Called once per host per stats poll. cpuPercent is host-normalized (cpuSum /
// ncpu, so 100% means all cores busy); memPercent is sum-of-container-usage
// over host total memory.
function handleHostSample({ hostId, hostName, cpuPercent, memPercent, ts }) {
  const cfg = getThresholdConfig();
  const sustainMs = cfg.sustainMinutes * 60_000;

  if (cfg.cpuThreshold > 0) {
    const breached = cpuPercent >= cfg.cpuThreshold;
    if (checkSustained(`${hostId}:host:host_cpu`, breached, sustainMs, ts)) {
      fire({
        hostId,
        containerId: null,
        containerName: null,
        rule: 'host_cpu',
        severity: 'warning',
        message: `Host ${hostName || hostId} CPU at ${cpuPercent.toFixed(1)}% (threshold ${cfg.cpuThreshold}%)`,
      });
    }
  }

  if (cfg.memThreshold > 0) {
    const breached = memPercent >= cfg.memThreshold;
    if (checkSustained(`${hostId}:host:host_mem`, breached, sustainMs, ts)) {
      fire({
        hostId,
        containerId: null,
        containerName: null,
        rule: 'host_mem',
        severity: 'warning',
        message: `Host ${hostName || hostId} memory at ${memPercent.toFixed(1)}% (threshold ${cfg.memThreshold}%)`,
      });
    }
  }
}

// Called once per host per disk-usage poll (~60s). `docker system df` reports
// Docker's own footprint (images/containers/volumes/build cache), not host
// filesystem free space - Docker doesn't expose that - so this is honestly a
// "Docker is using more than X GB, consider pruning" reminder rather than a
// disk-full alert. Already coarse at a 60s poll interval, so no sustain window;
// the existing 10-minute cooldown is enough to keep it from spamming.
function handleDiskUsage({ hostId, hostName, rows }) {
  const cfg = getThresholdConfig();
  if (!(cfg.diskThresholdGb > 0)) return;

  const totalGb = (rows || []).reduce((sum, r) => sum + parseByteString(r.size), 0) / 1024 ** 3;
  if (totalGb >= cfg.diskThresholdGb) {
    fire({
      hostId,
      containerId: null,
      containerName: null,
      rule: 'docker_disk',
      severity: 'warning',
      message: `Docker disk usage on ${hostName || hostId} is ${totalGb.toFixed(1)} GB (threshold ${cfg.diskThresholdGb} GB)`,
    });
  }
}

module.exports = {
  handleEvent,
  handleHostReachability,
  handleSample,
  handleHostSample,
  handleDiskUsage,
  buildDelivery,
  getWebhookConfig,
  setWebhookConfig,
  clearWebhookConfig,
  getThresholdConfig,
  setThresholdConfig,
  clearThresholdConfig,
  sendTestAlert,
};
