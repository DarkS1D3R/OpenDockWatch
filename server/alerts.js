const db = require('./db');
const logger = require('./logger');
const { parseByteString } = require('./docker');
const hosts = require('./hosts');

const COOLDOWN_MS = 10 * 60 * 1000;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LOOP_THRESHOLD = 3;
// docker stop/restart SIGKILLs after a 10s SIGTERM grace (docker.js's CONTAINER_ACTION_TIMEOUT_MS)
// before the die event fires; this must exceed that or a container taking the full grace period
// falls outside the lookback window from the die event back to the requested action's audit row.
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

// The only form of a webhook URL that may ever reach a log: the rest embeds a Discord/Gotify token
// or an ntfy topic. Shared with index.js's settings route so the redaction can't drift between them.
function webhookScheme(rawUrl) {
  try {
    return new URL(rawUrl).protocol + '//…';
  } catch {
    return '(unparseable)';
  }
}

// Routes ALERT_WEBHOOK_URL to the right destination/payload shape based on its scheme,
// apprise-style (discord://, ntfy://, gotify(s)://, or a plain http(s) URL - auto-detects
// Slack, else generic JSON POST). See README's Alerts section for the full scheme table.
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

// .env sets ALERT_WEBHOOK_URL/FORMAT (needs a restart); the Settings UI persists to the
// settings table and applies immediately, overriding .env - including an intentional empty
// string to disable a webhook .env configured. db.getSetting returns null only when never set.
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

// Resource-threshold rules, env-default + DB-override like the webhook config above. All ship
// disabled (0) by default so existing users don't get surprise webhook noise after upgrading.
// sustainMinutes is shared by cpu/mem since both come from the same 5s stats poll.
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

// Ordered walk, first host+matcher match wins *in full* for that container - not merged
// field-by-field across multiple candidate rules. composeProject matches exactly (it's a fixed
// label value); name matches by case-insensitive substring, same as every other filter in this
// app (List/Logs/Activity search boxes).
function findMatchingRule(rules, hostId, containerName, composeProject) {
  for (const rule of rules) {
    if (rule.hostId && rule.hostId !== hostId) continue;
    if (rule.matchType === 'name') {
      if (containerName && containerName.toLowerCase().includes(rule.matchValue.toLowerCase())) return rule;
    } else if (composeProject && composeProject.toLowerCase() === rule.matchValue.toLowerCase()) {
      return rule;
    }
  }
  return null;
}

// The settings+rules reads resolveContainerConfig needs, hoisted so a caller with many containers
// pays them once instead of per container - metricsCollector.pollHost does exactly that, since at
// 200 containers and 10 rules the per-container read cost ~6ms of event-loop time every 5s.
function alertContext() {
  return { global: getThresholdConfig(), rules: db.getContainerAlertRules() };
}

// The effective per-container config: the global threshold config, with any fields the matched
// rule sets overriding it (a rule's own null field still inherits the global value), plus which
// event rules are muted for this container. No matching rule (the common case) returns the global
// config untouched. Deliberately separate from the opendockwatch.alerts=off label - see CLAUDE.md.
function resolveContainerConfig({ hostId, containerName, composeProject }, ctx) {
  const { global, rules } = ctx || alertContext();
  const rule = findMatchingRule(rules, hostId, containerName, composeProject);
  if (!rule) return { ...global, mutedEventRules: new Set(), matchedRuleId: null };
  return {
    ...global,
    cpuThreshold: rule.cpuThreshold ?? global.cpuThreshold,
    memThreshold: rule.memThreshold ?? global.memThreshold,
    sustainMinutes: rule.sustainMinutes ?? global.sustainMinutes,
    mutedEventRules: new Set(rule.mutedRules),
    matchedRuleId: rule.id,
  };
}

// Logs the suppression as it reports it: a fired alert always leaves an alert.fired line, so
// without this a muted one is the only outcome with no trace at all to answer "why no alert?".
function mutedByRule(eventRule, { hostId, containerId, containerName, composeProject }) {
  const cfg = resolveContainerConfig({ hostId, containerName, composeProject });
  if (!cfg.mutedEventRules.has(eventRule)) return false;
  logger.info('alert.muted', {
    host: hostId,
    container: containerName || containerId,
    rule: eventRule,
    ruleId: cfg.matchedRuleId,
  });
  return true;
}

// Consecutive-breach tracking keyed "hostId:containerId:rule": fires once a breach is sustained
// for sustainMs (a single over-threshold sample is noise), resets on dipping under threshold
// (hysteresis). Mirrored to alert_breaches so a restart mid-breach resumes counting - see CLAUDE.md.
const breachStarts = new Map();

// Restores breachStarts from before the last restart - called once at boot (index.js), not at
// require time, so requiring this module (every test does) never touches sqlite. Drops rows for
// hosts no longer configured; per-container staleness is handled by retainContainers each poll.
function loadBreachState() {
  const validHostIds = new Set(hosts.loadHosts().map((h) => h.id));
  for (const row of db.getAllBreaches()) {
    const hostId = row.key.split(':')[0];
    if (!validHostIds.has(hostId)) {
      db.deleteBreachStart(row.key);
      continue;
    }
    breachStarts.set(row.key, row.startTs);
  }
}

function checkSustained(key, breached, sustainMs, ts) {
  if (!breached) {
    if (breachStarts.delete(key)) db.deleteBreachStart(key);
    return false;
  }
  let start = breachStarts.get(key);
  if (start === undefined) {
    start = ts;
    breachStarts.set(key, start);
    db.setBreachStart(key, start);
  }
  return ts - start >= sustainMs;
}

// fetch has no default timeout and notify() is fire-and-forget, so a webhook host that accepts
// the connection and never answers would hang a request for the process's life. TimeoutError is
// translated to a named message since this path also backs Settings' "Test webhook" button.
const WEBHOOK_TIMEOUT_MS = 10_000;

// checkSustained never removes a counter once its subject is gone, so left alone breachStarts
// keeps one entry per (container, rule) that ever breached for the process's life. Called from
// metricsCollector, the only thing that sees a container disappear; host-level counters survive.
function retainContainers(hostId, containerIds) {
  const keep = new Set(containerIds);
  for (const key of breachStarts.keys()) {
    const [host, subject] = key.split(':');
    if (host !== hostId || subject === 'host') continue;
    if (!keep.has(subject)) {
      breachStarts.delete(key);
      db.deleteBreachStart(key);
    }
  }
}

function forgetHost(hostId) {
  for (const key of breachStarts.keys()) {
    if (key.startsWith(`${hostId}:`)) {
      breachStarts.delete(key);
      db.deleteBreachStart(key);
    }
  }
}

async function deliverWebhook(rawUrl, alert, format) {
  const delivery = buildDelivery(rawUrl, alert, format);
  let res;
  try {
    res = await fetch(delivery.url, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`webhook did not respond within ${WEBHOOK_TIMEOUT_MS / 1000}s`, { cause: err });
    throw err;
  }
  if (!res.ok) {
    throw new Error(`webhook responded with HTTP ${res.status}`);
  }
}

// The first delivery attempt, fired synchronously (caller doesn't await) but no longer
// forget-forever on failure: a failed attempt is recorded so retryFailedWebhooks can retry it.
// alert.id is 0 for sendTestAlert's synthetic alert, which intentionally skips this bookkeeping.
async function notify(alert) {
  const { url: rawUrl, format } = getWebhookConfig();
  if (!rawUrl) return;

  try {
    await deliverWebhook(rawUrl, alert, format);
    if (alert.id) db.markWebhookDelivered(alert.id);
    // Scheme only, never the URL - it embeds the Discord/Gotify/ntfy token. Delivery was silent
    // on success, so "the alert fired but did the notification go out?" had no answer.
    logger.info('alert.webhook.delivered', { host: alert.hostId, rule: alert.rule, via: webhookScheme(rawUrl) });
  } catch (err) {
    if (alert.id) db.markWebhookAttemptFailed(alert.id);
    // The URL stays out of this deliberately - it embeds the Discord/Gotify/ntfy token.
    logger.error('alert.webhook.failed', { host: alert.hostId, rule: alert.rule, error: err.message });
  }
}

// A webhook host down for the exact window an alert fires (a flaky endpoint, often correlated
// with the alert's own network blip) used to mean that notification was gone for good - this
// sweep retries anything notify() (or a prior sweep) recorded as attempted-but-undelivered.
const WEBHOOK_MAX_ATTEMPTS = 5;
// Past this age, retrying is pointless - by the time it'd be delivered the information is stale
// anyway - and it bounds how big a backlog a webhook that's been down for hours can hand back at
// once when it recovers.
const WEBHOOK_RETRY_WINDOW_MS = 60 * 60 * 1000;
const WEBHOOK_RETRY_INTERVAL_MS = 60 * 1000;
const WEBHOOK_RETRY_BATCH_LIMIT = 20;

async function retryFailedWebhooks() {
  const { url: rawUrl, format } = getWebhookConfig();
  // No URL right now (never configured, or cleared since the failures happened) - nothing to
  // retry against. Rows just stay pending; if a webhook is configured later, the next sweep picks
  // them up as long as they're still inside the retry window.
  if (!rawUrl) return;

  const sinceTs = Date.now() - WEBHOOK_RETRY_WINDOW_MS;
  const pending = db.getPendingWebhookRetries({ maxAttempts: WEBHOOK_MAX_ATTEMPTS, sinceTs, limit: WEBHOOK_RETRY_BATCH_LIMIT });
  for (const row of pending) {
    const alert = {
      id: row.id,
      ts: row.ts,
      hostId: row.host_id,
      containerId: row.container_id,
      containerName: row.container_name,
      rule: row.rule,
      severity: row.severity,
      message: row.message,
    };
    try {
      await deliverWebhook(rawUrl, alert, format);
      db.markWebhookDelivered(alert.id);
      logger.info('alert.webhook.retry_delivered', {
        host: alert.hostId,
        rule: alert.rule,
        attempt: row.webhook_attempts + 1,
        delayedSec: Math.round((Date.now() - alert.ts) / 1000),
      });
    } catch (err) {
      db.markWebhookAttemptFailed(alert.id);
      logger.error('alert.webhook.retry_failed', {
        host: alert.hostId,
        rule: alert.rule,
        attempt: row.webhook_attempts + 1,
        error: err.message,
      });
    }
  }
}

let retryTimer = null;

function start() {
  retryTimer = setInterval(() => {
    retryFailedWebhooks().catch((err) => logger.error('alert.webhook.retry_sweep_failed', { error: err.message }));
  }, WEBHOOK_RETRY_INTERVAL_MS);
  retryTimer.unref();
}

function stop() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
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
  // composeProject isn't destructured here - mutedByRule reads it (and the ids) off `event` itself.
  const { hostId, containerId, containerName, action, ts, raw } = event;

  if (action === 'die') {
    const exitCode = raw && raw.Actor && raw.Actor.Attributes ? raw.Actor.Attributes.exitCode : undefined;
    // parseInt of a present-but-garbled exit code is NaN, not caught by the `: 0` default (which
    // only covers a genuinely missing attribute); without this it would still fire but read as
    // "exited with code NaN" instead of a message that actually describes what happened.
    const parsed = exitCode !== undefined ? parseInt(exitCode, 10) : 0;
    const code = Number.isNaN(parsed) ? null : parsed;
    if (code !== 0) {
      const recentManualStop = db.countManualStopsSince(hostId, containerId, ts - MANUAL_STOP_GRACE_MS) > 0;
      // mutedByRule only runs in this already-narrow, about-to-fire path - not once per
      // docker-events line - so this is at most one extra rules-table read per real crash.
      if (!recentManualStop && !mutedByRule('container_crashed', event)) {
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
    if (autoCount >= CRASH_LOOP_THRESHOLD && !mutedByRule('crash_loop', event)) {
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

  if (action === 'health_status: unhealthy' && !mutedByRule('unhealthy', event)) {
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
  // Recovery gets no alert (nobody wants a webhook for good news) but it does get a log line -
  // going down was loud and coming back was silent, which left the log implying it's still down.
  if (!wasReachable && reachable) {
    logger.info('host.reachable', { host: hostId, name: hostName || hostId });
  }
}

// Called once per running container on every stats poll (~5s), with `ctx` one alertContext() shared
// by the whole poll. cpuPerc is raw docker-stats CPU% (per-core cumulative, so 4 cores fully used
// reads 400%, matching the UI); memPerc is MemPerc against the container's own limit.
function handleSample({ hostId, containerId, containerName, composeProject, cpuPerc, memPerc, ts, alertsDisabled }, ctx) {
  // Unconditional, before any rules-table read - zero DB cost for a container opted out via the
  // label, same as today. See CLAUDE.md for why this stays separate from container_alert_rules.
  if (alertsDisabled) return;
  const cfg = resolveContainerConfig({ hostId, containerName, composeProject }, ctx);
  const sustainMs = cfg.sustainMinutes * 60_000;

  // Folded into "breached" itself rather than skipping checkSustained while disabled - a rule
  // switched off mid-breach still needs to clear its own persisted alert_breaches row via
  // checkSustained's !breached path, or it would sit there forever instead of self-healing.
  const cpuBreached = cfg.cpuThreshold > 0 && cpuPerc >= cfg.cpuThreshold;
  if (checkSustained(`${hostId}:${containerId}:container_cpu`, cpuBreached, sustainMs, ts)) {
    fire({
      hostId,
      containerId,
      containerName,
      rule: 'container_cpu',
      severity: 'warning',
      message: `Container ${containerName || containerId} CPU at ${cpuPerc.toFixed(1)}% (threshold ${cfg.cpuThreshold}%)`,
    });
  }

  const memBreached = cfg.memThreshold > 0 && memPerc >= cfg.memThreshold;
  if (checkSustained(`${hostId}:${containerId}:container_mem`, memBreached, sustainMs, ts)) {
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

// Called once per host per stats poll. cpuPercent is host-normalized (cpuSum /
// ncpu, so 100% means all cores busy); memPercent is sum-of-container-usage
// over host total memory.
function handleHostSample({ hostId, hostName, cpuPercent, memPercent, ts }) {
  const cfg = getThresholdConfig();
  const sustainMs = cfg.sustainMinutes * 60_000;

  // Same reasoning as handleSample above: fold the enabled-check into "breached" itself so a
  // disabled rule still clears its own persisted breach row via checkSustained's !breached path.
  const cpuBreached = cfg.cpuThreshold > 0 && cpuPercent >= cfg.cpuThreshold;
  if (checkSustained(`${hostId}:host:host_cpu`, cpuBreached, sustainMs, ts)) {
    fire({
      hostId,
      containerId: null,
      containerName: null,
      rule: 'host_cpu',
      severity: 'warning',
      message: `Host ${hostName || hostId} CPU at ${cpuPercent.toFixed(1)}% (threshold ${cfg.cpuThreshold}%)`,
    });
  }

  const memBreached = cfg.memThreshold > 0 && memPercent >= cfg.memThreshold;
  if (checkSustained(`${hostId}:host:host_mem`, memBreached, sustainMs, ts)) {
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

// Called once per host per disk-usage poll (~60s). `docker system df` reports Docker's own
// footprint, not host filesystem free space (Docker doesn't expose that) - so this is a "Docker
// is using more than X GB" reminder, not a disk-full alert. No sustain window; cooldown suffices.
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
  retainContainers,
  forgetHost,
  buildDelivery,
  webhookScheme,
  getWebhookConfig,
  setWebhookConfig,
  clearWebhookConfig,
  getThresholdConfig,
  setThresholdConfig,
  clearThresholdConfig,
  alertContext,
  resolveContainerConfig,
  sendTestAlert,
  loadBreachState,
  retryFailedWebhooks,
  start,
  stop,
};
