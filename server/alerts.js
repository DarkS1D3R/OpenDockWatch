const db = require('./db');
const logger = require('./logger');
const { parseByteString } = require('./docker');
// The module object too, for getRestartPolicy - a destructured binding would be a copy taken at
// require time, out of reach of test/alerts.test.js stubbing it afterwards.
const docker = require('./docker');
const hosts = require('./hosts');

const COOLDOWN_MS = 10 * 60 * 1000;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LOOP_THRESHOLD = 3;
// docker stop/restart SIGKILLs after a 10s SIGTERM grace (docker.js's CONTAINER_ACTION_TIMEOUT_MS)
// before the die event fires; this must exceed that or a container taking the full grace period
// falls outside the lookback window from the die event back to the requested action's audit row.
const MANUAL_STOP_GRACE_MS = 15000;

// docker emits `kill` (carrying the signal) just before the `die` of anything it stopped on
// request - docker stop/restart/kill, compose stop/down, from the CLI as much as from this app - and
// nothing before a process that simply ended. That is the only thing that tells a clean exit that
// was asked for from one that was not, since both arrive as `die` with exit code 0. Kept for longer
// than a stop's 10s grace, so `docker stop -t 60` still reads as commanded.
const KILL_MEMORY_MS = 60_000;
const recentKills = new Map(); // "hostId:containerId" -> ts of the last kill event

function noteKill(hostId, containerId, ts) {
  for (const [key, killedAt] of recentKills) if (ts - killedAt > KILL_MEMORY_MS) recentKills.delete(key);
  recentKills.set(`${hostId}:${containerId}`, ts);
}

function wasKilledRecently(hostId, containerId, ts) {
  const killedAt = recentKills.get(`${hostId}:${containerId}`);
  return killedAt !== undefined && ts - killedAt <= KILL_MEMORY_MS;
}

// An OOM kill of PID 1 arrives as `oom` then `die` (exit 137) - one incident, so a crash alert right
// after an oom_killed one is skipped. Short: the two events land within a second of each other.
const OOM_MEMORY_MS = 10_000;
const recentOoms = new Map(); // "hostId:containerId" -> ts of the last unmuted oom event

function noteOom(hostId, containerId, ts) {
  for (const [key, oomAt] of recentOoms) if (ts - oomAt > OOM_MEMORY_MS) recentOoms.delete(key);
  recentOoms.set(`${hostId}:${containerId}`, ts);
}

function wasOomKilledRecently(hostId, containerId, ts) {
  const oomAt = recentOoms.get(`${hostId}:${containerId}`);
  return oomAt !== undefined && ts - oomAt <= OOM_MEMORY_MS;
}

// Restart policies that mean "keep this running". A clean exit under `no` or `on-failure` is how a
// finished job or migration looks, so those stay silent - alerting on them would be every one-shot.
const KEEP_RUNNING_POLICIES = new Set(['always', 'unless-stopped']);

// Every rule fire() can raise - what a webhook route may filter on. Mirrored by ALERT_RULES in
// public/js/constants.js, enforced by test/sharedConstants.test.js.
const ALERT_RULES = [
  'container_crashed',
  'crash_loop',
  'unhealthy',
  'unexpected_exit',
  'oom_killed',
  'container_cpu',
  'container_mem',
  'host_cpu',
  'host_mem',
  'docker_disk',
  'host_unreachable',
];

function shouldFire(hostId, containerId, rule) {
  const last = db.getLastAlertFireTs(hostId, containerId, rule);
  if (!last) return true;
  return Date.now() - last > COOLDOWN_MS;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const isResolved = (alert) => alert.status === 'resolved';

// What a notice calls itself: the severity while firing, RESOLVED once the problem has cleared.
function noticeLabel(alert) {
  return isResolved(alert) ? 'resolved' : alert.severity;
}

function slackText(alert) {
  return `*[opendockwatch] ${noticeLabel(alert).toUpperCase()}* ${alert.hostId}/${alert.containerName || alert.containerId || ''}: ${alert.message}`;
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
        Title: `opendockwatch: ${noticeLabel(alert)}`,
        Priority: isResolved(alert) ? 'low' : alert.severity === 'critical' ? 'urgent' : 'default',
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
        title: `opendockwatch: ${noticeLabel(alert)}`,
        message: alert.message,
        priority: isResolved(alert) ? 2 : alert.severity === 'critical' ? 8 : 4,
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
const WEBHOOK_RECOVERY_KEY = 'alertWebhookNotifyRecovery';
// 'all': the main webhook gets every alert. 'unmatched': only alerts no route took, so routes can
// carve traffic away from it rather than only copying it elsewhere. UI-only; routes are too.
const WEBHOOK_MODE_KEY = 'alertWebhookMode';
const WEBHOOK_MODES = new Set(['all', 'unmatched']);
// Minutes between reminders for a problem nobody has acknowledged; 0 (the default) is off.
const WEBHOOK_REPEAT_KEY = 'alertRepeatMinutes';
const REPEAT_MAX_MINUTES = 24 * 60;

const envFlag = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// .env sets ALERT_WEBHOOK_URL/FORMAT/NOTIFY_RECOVERY (needs a restart); the Settings UI persists to
// the settings table and applies immediately, overriding .env - including an intentional empty
// string to disable a webhook .env configured. db.getSetting returns null only when never set.
function getWebhookConfig() {
  const dbUrl = db.getSetting(WEBHOOK_URL_KEY);
  const overridden = dbUrl !== null;
  const url = overridden ? dbUrl : process.env.ALERT_WEBHOOK_URL || '';
  const format = overridden ? db.getSetting(WEBHOOK_FORMAT_KEY) || '' : process.env.ALERT_WEBHOOK_FORMAT || '';
  const dbRecovery = db.getSetting(WEBHOOK_RECOVERY_KEY);
  const notifyRecovery = dbRecovery !== null ? dbRecovery === '1' : envFlag(process.env.ALERT_WEBHOOK_NOTIFY_RECOVERY);
  const dbMode = db.getSetting(WEBHOOK_MODE_KEY);
  const mode = WEBHOOK_MODES.has(dbMode) ? dbMode : 'all';
  const repeatMinutes = repeatFrom(db.getSetting(WEBHOOK_REPEAT_KEY) ?? process.env.ALERT_REPEAT_MINUTES);
  return { url, format, overridden, notifyRecovery, mode, repeatMinutes };
}

// A whole number of minutes within range, else 0 - a typo in .env must not turn reminders on.
function repeatFrom(raw) {
  const n = Number(String(raw ?? '').trim() || 0);
  return Number.isInteger(n) && n >= 0 && n <= REPEAT_MAX_MINUTES ? n : 0;
}

// notifyRecovery and mode are left alone when not given, so an older client saving only the URL
// does not silently switch recovery messages off.
function setWebhookConfig({ url, format, notifyRecovery, mode, repeatMinutes }) {
  db.setSetting(WEBHOOK_URL_KEY, url || '');
  db.setSetting(WEBHOOK_FORMAT_KEY, format || '');
  if (notifyRecovery !== undefined) db.setSetting(WEBHOOK_RECOVERY_KEY, notifyRecovery ? '1' : '0');
  if (mode !== undefined) db.setSetting(WEBHOOK_MODE_KEY, WEBHOOK_MODES.has(mode) ? mode : 'all');
  if (repeatMinutes !== undefined) db.setSetting(WEBHOOK_REPEAT_KEY, String(repeatFrom(repeatMinutes)));
  return getWebhookConfig();
}

function clearWebhookConfig() {
  for (const key of [WEBHOOK_URL_KEY, WEBHOOK_FORMAT_KEY, WEBHOOK_RECOVERY_KEY, WEBHOOK_MODE_KEY, WEBHOOK_REPEAT_KEY])
    db.deleteSetting(key);
  return getWebhookConfig();
}

const MAIN_DESTINATION = 'main';
const routeKey = (route) => `route:${route.id}`;

function routeDestination(route) {
  return { key: routeKey(route), url: route.url, format: route.format, notifyRecovery: route.notifyRecovery };
}

const isDelayed = (route) => route.delayMinutes > 0;

function mainDestination(main) {
  return { key: MAIN_DESTINATION, url: main.url, format: main.format, notifyRecovery: main.notifyRecovery };
}

// Whether a route takes this alert: its host (or any), its rules (or all), and critical-only or not.
function routeMatches(route, alert) {
  if (!route.enabled) return false;
  if (route.hostId && route.hostId !== alert.hostId) return false;
  if (route.rules.length && !route.rules.includes(alert.rule)) return false;
  if (route.minSeverity === 'critical' && alert.severity !== 'critical') return false;
  return true;
}

// Where a firing alert goes at once: each matching route, plus the main webhook unless it takes only
// what no route took. A delayed route is left to the follow-up sweep and does not count as taking it.
function selectDestinations(alert, main, routes) {
  const out = routes.filter((r) => !isDelayed(r) && routeMatches(r, alert)).map(routeDestination);
  if (main.url && (main.mode !== 'unmatched' || out.length === 0)) out.unshift(mainDestination(main));
  return out;
}

// A destination as it is configured now, for a retry or a resolved notice: null once it has been
// removed, disabled, or (for main) had its URL cleared.
function destinationByKey(key, main, routes) {
  if (key === MAIN_DESTINATION) return main.url ? mainDestination(main) : null;
  const route = routes.find((r) => routeKey(r) === key && r.enabled);
  return route ? routeDestination(route) : null;
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

// Takes the already-read setting value rather than reading it itself - getThresholdConfig needs
// the raw value anyway to know whether it's overridden, and re-reading it here doubled the sqlite
// executions (8 for 4 fields, 4 needed) on every alert-checking poll.
function numFromSetting(dbVal, envVar, defaultValue = 0) {
  if (dbVal !== null) return dbVal === '' ? defaultValue : Number(dbVal);
  const envVal = process.env[envVar];
  return envVal !== undefined && envVal !== '' ? Number(envVal) : defaultValue;
}

function getThresholdConfig() {
  const config = { overridden: false };
  for (const [field, { settingKey, envVar, default: def }] of Object.entries(THRESHOLD_KEYS)) {
    const dbVal = db.getSetting(settingKey);
    if (dbVal !== null) config.overridden = true;
    config[field] = numFromSetting(dbVal, envVar, def);
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
// config untouched. Deliberately separate from the opendockwatch.alerts=off label - see server/CLAUDE.md.
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
// (hysteresis). Mirrored to alert_breaches so a restart mid-breach resumes counting - see server/CLAUDE.md.
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

// sustained: fire now. start: when the ongoing breach began. endedStart: a breach just ended, and
// when it began - so the resolve it triggers only closes an alert that breach raised.
function checkSustained(key, breached, sustainMs, ts) {
  if (!breached) {
    const start = breachStarts.get(key);
    if (start === undefined) return { sustained: false, endedStart: null };
    breachStarts.delete(key);
    db.deleteBreachStart(key);
    return { sustained: false, endedStart: start };
  }
  let start = breachStarts.get(key);
  if (start === undefined) {
    start = ts;
    breachStarts.set(key, start);
    db.setBreachStart(key, start);
  }
  return { sustained: ts - start >= sustainMs, endedStart: null, start };
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
  for (const key of recentKills.keys()) if (key.startsWith(`${hostId}:`)) recentKills.delete(key);
  for (const key of recentOoms.keys()) if (key.startsWith(`${hostId}:`)) recentOoms.delete(key);
  for (const key of breachStarts.keys()) {
    if (key.startsWith(`${hostId}:`)) {
      breachStarts.delete(key);
      db.deleteBreachStart(key);
    }
  }
}

// A thrown message is not ours: undici says "fetch failed" today, but that wording is no contract
// and other runtimes name the URL in it. Both URL forms and the raw one's path embed the token, so
// each is swapped for its scheme before the message can be logged or answered. See server/CLAUDE.md.
function redactWebhookUrls(message, ...urls) {
  let out = String(message == null ? '' : message);
  const present = urls.filter(Boolean);
  // Whole URLs first, every one of them, before any path swap runs: one URL's path is a substring
  // of another's whole URL here (a discord:// token reappears in the discord.com endpoint), so
  // interleaving the two passes would chew a hole in a URL the later pass still had to match.
  for (const url of present) out = out.split(url).join(webhookScheme(url));
  for (const url of present) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    if (path.length > 1) out = out.split(path).join('/…');
  }
  return out;
}

async function deliverWebhook(rawUrl, alert, format) {
  let delivery;
  try {
    delivery = buildDelivery(rawUrl, alert, format);
    const res = await fetch(delivery.url, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`webhook responded with HTTP ${res.status}`);
    }
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`webhook did not respond within ${WEBHOOK_TIMEOUT_MS / 1000}s`, { cause: err });
    const message = redactWebhookUrls(err.message, rawUrl, delivery && delivery.url);
    // Nothing was redacted, so nothing is gained by re-wrapping - keep the original error whole
    // rather than trading its name and stack for an identical message.
    throw message === err.message ? err : new Error(message, { cause: err });
  }
}

// One notice to one destination. The delivery row is what the retry sweep works from; payload.id
// is 0 for sendTestAlert's synthetic alert, which intentionally skips that bookkeeping. Never throws.
async function sendNotice(dest, payload, kind = payload.status) {
  const fields = { host: payload.hostId, rule: payload.rule, status: kind, destination: dest.key };
  let deliveryId = null;
  try {
    if (payload.id) {
      deliveryId = db.insertWebhookDelivery({ alertId: payload.id, destination: dest.key, kind, ts: Date.now(), payload });
    }
    await deliverWebhook(dest.url, payload, dest.format);
    if (deliveryId) db.markDeliveryDelivered(deliveryId);
    // Scheme only, never the URL - it embeds the Discord/Gotify/ntfy token. Delivery was silent
    // on success, so "the alert fired but did the notification go out?" had no answer.
    logger.info('alert.webhook.delivered', { ...fields, via: webhookScheme(dest.url) });
  } catch (err) {
    if (deliveryId) db.markDeliveryFailed(deliveryId);
    // The URL stays out of this deliberately - it embeds the Discord/Gotify/ntfy token.
    logger.error('alert.webhook.failed', { ...fields, error: err.message });
  }
}

// The first delivery attempt to every destination the alert routes to, in parallel so one slow
// endpoint can't hold up the others. fire() doesn't await it; a failure is left for the sweep.
async function notify(alert) {
  const dests = selectDestinations(alert, getWebhookConfig(), db.getWebhookRoutes());
  await Promise.all(dests.map((dest) => sendNotice(dest, { ...alert, status: 'firing' })));
}

function formatAge(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

// Closes the newest open alert for (host, container, rule), if there is one at or after sinceTs, and
// sends a resolved notice to each destination its firing notice reached that wants one. Always
// recorded; the notice itself is opt-in per destination. See server/CLAUDE.md.
function resolve({ hostId, containerId = null, containerName = null, rule, message, sinceTs = 0 }) {
  const open = db.getUnresolvedAlert({ hostId, containerId, rule, sinceTs });
  if (!open) return;
  const ts = Date.now();
  if (!db.markAlertResolved(open.id, ts)) return;
  const name = containerName || open.containerName;
  logger.info('alert.resolved', { host: hostId, container: name || containerId, rule, afterSec: Math.round((ts - open.ts) / 1000) });
  const delivered = db.getDeliveredDestinations(open.id);
  if (!delivered.length) return;
  const main = getWebhookConfig();
  const routes = db.getWebhookRoutes();
  const payload = {
    id: open.id,
    ts,
    hostId,
    containerId,
    containerName: name,
    rule,
    severity: open.severity,
    message: `${message} - lasted ${formatAge(ts - open.ts)}`,
    status: 'resolved',
    firedAt: open.ts,
  };
  for (const key of delivered) {
    const dest = destinationByKey(key, main, routes);
    if (dest && dest.notifyRecovery) sendNotice(dest, payload);
  }
}

// A webhook host down for the exact window an alert fires (a flaky endpoint, often correlated
// with the alert's own network blip) used to mean that notification was gone for good - this
// sweep retries any notice notify(), resolve() or a prior sweep recorded as attempted-but-undelivered.
const WEBHOOK_MAX_ATTEMPTS = 5;
// Past this age, retrying is pointless - by the time it'd be delivered the information is stale
// anyway - and it bounds how big a backlog a webhook that's been down for hours can hand back at
// once when it recovers.
const WEBHOOK_RETRY_WINDOW_MS = 60 * 60 * 1000;
const WEBHOOK_RETRY_INTERVAL_MS = 60 * 1000;
const WEBHOOK_RETRY_BATCH_LIMIT = 20;

// Guards against a sweep still delivering its batch when the next tick fires - each delivery can
// take up to WEBHOOK_TIMEOUT_MS and rows only stop being "pending" once one finishes, so without
// this a slow/down endpoint gets the same backlog handed to it twice by two overlapping sweeps.
let retrying = false;

async function retryFailedWebhooks() {
  if (retrying) {
    logger.warn('alert.webhook.retry_sweep_overlapped');
    return;
  }
  retrying = true;
  try {
    const main = getWebhookConfig();
    const routes = db.getWebhookRoutes();
    // Nothing configured right now (never set up, or cleared since the failures happened) - nothing
    // to retry against. Rows just stay pending; if a webhook comes back, the next sweep picks them
    // up as long as they're still inside the retry window.
    if (!main.url && !routes.some((r) => r.enabled)) return;

    const sinceTs = Date.now() - WEBHOOK_RETRY_WINDOW_MS;
    const pending = db.getPendingDeliveries({ maxAttempts: WEBHOOK_MAX_ATTEMPTS, sinceTs, limit: WEBHOOK_RETRY_BATCH_LIMIT });
    // The individual retry_delivered/retry_failed lines below each describe one notice; none of them
    // says how deep the backlog is. An endpoint that's been down for a day otherwise shows only a
    // trickle of unrelated-looking failures, with nothing saying they're the same growing queue.
    // Capped at WEBHOOK_RETRY_BATCH_LIMIT, so `atBatchLimit` is the tell that there are likely more.
    if (pending.length) {
      logger.warn('alert.webhook.backlog', { pending: pending.length, atBatchLimit: pending.length === WEBHOOK_RETRY_BATCH_LIMIT });
    }
    for (const row of pending) {
      const fields = { destination: row.destination, status: row.kind, attempt: row.attempts + 1 };
      try {
        const payload = JSON.parse(row.payload);
        Object.assign(fields, { host: payload.hostId, rule: payload.rule });
        // Paging someone late about a problem that has already cleared helps nobody.
        if (row.kind === 'firing' && row.resolvedAt) {
          db.deleteDelivery(row.id);
          logger.info('alert.webhook.retry_dropped', { ...fields, reason: 'resolved' });
          continue;
        }
        // Removed, disabled or cleared since: the row stays and ages out of the retry window.
        const dest = destinationByKey(row.destination, main, routes);
        if (!dest) continue;
        await deliverWebhook(dest.url, payload, dest.format);
        db.markDeliveryDelivered(row.id);
        logger.info('alert.webhook.retry_delivered', { ...fields, delayedSec: Math.round((Date.now() - row.ts) / 1000) });
      } catch (err) {
        db.markDeliveryFailed(row.id);
        logger.error('alert.webhook.retry_failed', { ...fields, error: err.message });
      }
    }
  } finally {
    retrying = false;
  }
}

// Rules that describe a state, which resolve() closes when it clears. Only these get reminders: a
// crash or an OOM kill is over by the time anyone reads it, and the Activity badge already holds it.
const STATEFUL_RULES = new Set(['host_unreachable', 'unhealthy', 'container_cpu', 'container_mem', 'host_cpu', 'host_mem', 'docker_disk']);
// An escalation route takes an alert once it has been open this long past the route's delay, and no
// later - so adding a route, or a restart, doesn't page about every old alert at once.
const ESCALATION_WINDOW_MS = 60 * 60 * 1000;
const FOLLOW_UP_LIMIT = 200;

const followUpKey = (a) => `${a.hostId}:${a.containerId}:${a.rule}`;

function followUpPayload(alert, now, message, extra) {
  const { id, hostId, containerId, containerName, rule, severity } = alert;
  return { id, ts: now, hostId, containerId, containerName, rule, severity, message, status: 'firing', firedAt: alert.ts, ...extra };
}

// The notices due right now for unacknowledged, unresolved alerts: an escalation to each delayed
// route whose delay has passed, and a reminder to each destination that got the firing notice once
// repeatMinutes has passed since it (or the last reminder). Pure - see server/CLAUDE.md.
function dueFollowUps({ alerts: open, noticesFor, main, routes, now }) {
  const repeatMs = main.repeatMinutes * 60_000;
  const delayed = routes.filter((r) => r.enabled && isDelayed(r));
  const due = [];
  const seen = new Set();
  for (const alert of open) {
    // Newest first, so a stale duplicate from before one alert per breach is skipped.
    if (seen.has(followUpKey(alert))) continue;
    seen.add(followUpKey(alert));
    const age = now - alert.ts;
    const notices = noticesFor(alert.id);
    const sentTo = new Set(notices.map((n) => n.destination));
    for (const route of delayed) {
      const delayMs = route.delayMinutes * 60_000;
      if (sentTo.has(routeKey(route)) || age < delayMs || age > delayMs + ESCALATION_WINDOW_MS || !routeMatches(route, alert)) continue;
      const message = `Unacknowledged for ${formatAge(age)}: ${alert.message}`;
      due.push({ dest: routeDestination(route), kind: 'firing', payload: followUpPayload(alert, now, message, { escalated: true }) });
    }
    if (!repeatMs || !STATEFUL_RULES.has(alert.rule)) continue;
    for (const n of notices) {
      if (!n.firingDeliveredAt || now - Math.max(n.firingDeliveredAt, n.lastReminderTs || 0) < repeatMs) continue;
      const dest = destinationByKey(n.destination, main, routes);
      if (!dest) continue;
      const message = `Still unacknowledged after ${formatAge(age)}: ${alert.message}`;
      due.push({ dest, kind: 'reminder', payload: followUpPayload(alert, now, message, { reminder: true }) });
    }
  }
  return due;
}

let followingUp = false;

async function sendFollowUps(now = Date.now()) {
  if (followingUp) return;
  followingUp = true;
  try {
    const main = getWebhookConfig();
    const routes = db.getWebhookRoutes();
    // Neither feature on: not even the query runs.
    if (!main.repeatMinutes && !routes.some((r) => r.enabled && isDelayed(r))) return;
    const due = dueFollowUps({
      alerts: db.getFollowUpAlerts({ limit: FOLLOW_UP_LIMIT }),
      noticesFor: (id) => db.getAlertNotices(id),
      main,
      routes,
      now,
    });
    await Promise.all(due.map((d) => sendNotice(d.dest, d.payload, d.kind)));
  } finally {
    followingUp = false;
  }
}

let retryTimer = null;

function start() {
  retryTimer = setInterval(() => {
    retryFailedWebhooks().catch((err) => logger.error('alert.webhook.retry_sweep_failed', { error: err.message }));
    sendFollowUps().catch((err) => logger.error('alert.follow_up_failed', { error: err.message }));
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
// With routeId, tests that route - enabled or not, so a route can be checked before it goes live.
async function sendTestAlert({ routeId } = {}) {
  let rawUrl;
  let format;
  if (routeId) {
    const route = db.getWebhookRoutes().find((r) => r.id === routeId);
    if (!route) throw new Error('no such webhook route');
    ({ url: rawUrl, format } = route);
  } else {
    ({ url: rawUrl, format } = getWebhookConfig());
    if (!rawUrl) {
      throw new Error('no webhook URL configured');
    }
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
    status: 'firing',
  };
  await deliverWebhook(rawUrl, testAlert, format);
}

// openSince: for a rule that describes a state, skip firing while an alert raised at or after this
// time is still unresolved - one alert per breach, with reminders as the only repeat.
function fire({ hostId, containerId, containerName, rule, severity, message, openSince }) {
  if (!shouldFire(hostId, containerId, rule)) return;
  if (openSince !== undefined && db.getUnresolvedAlert({ hostId, containerId, rule, sinceTs: openSince })) return;
  const ts = Date.now();
  const id = db.insertAlert({ ts, hostId, containerId, containerName, rule, severity, message });
  const log = severity === 'critical' ? logger.error : logger.warn;
  log('alert.fired', { host: hostId, container: containerName || containerId, rule, severity, message });
  notify({ id, ts, hostId, containerId, containerName, rule, severity, message });
}

// `podman stop` sends no kill event, so on Podman the tell is what happens next: a clean exit the
// restart policy brings straight back was not asked for; one that stays stopped was `podman stop`.
const PODMAN_RESTART_WAIT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restartedByPolicy(host, containerId, wait) {
  await wait(PODMAN_RESTART_WAIT_MS);
  const status = await docker.getContainerStatus(host, containerId);
  return status === 'running' || status === 'restarting';
}

// A container that exited 0 when it was meant to stay up: restart policy `always`/`unless-stopped`,
// and nobody asked it to stop (no audit row from this app, no kill event from docker). Exported for
// testing, since handleEvent can only fire-and-forget it.
async function checkCleanExit(event, { wait = sleep } = {}) {
  const { hostId, containerId, containerName, ts } = event;
  if (db.countManualStopsSince(hostId, containerId, ts - MANUAL_STOP_GRACE_MS) > 0) return;
  if (wasKilledRecently(hostId, containerId, ts)) return;
  const host = hosts.getHost(hostId);
  if (!host) return;
  const policy = await docker.getRestartPolicy(host, containerId);
  if (!KEEP_RUNNING_POLICIES.has(policy)) return;
  if (docker.hostEngine(hostId) === 'podman' && !(await restartedByPolicy(host, containerId, wait))) return;
  if (mutedByRule('unexpected_exit', event)) return;
  fire({
    hostId,
    containerId,
    containerName,
    rule: 'unexpected_exit',
    severity: 'warning',
    message: `Container ${containerName || containerId} exited cleanly (code 0), but its restart policy is "${policy}" so it should keep running`,
  });
}

function handleEvent(event) {
  // composeProject isn't destructured here - mutedByRule reads it (and the ids) off `event` itself.
  const { hostId, containerId, containerName, action, ts, raw } = event;

  if (action === 'kill') noteKill(hostId, containerId, ts);

  // Not every oom kills the container: the kernel may pick a child process and leave PID 1 running,
  // so the message says a process was killed, and the container_crashed it may lead to is skipped.
  if (action === 'oom' && !mutedByRule('oom_killed', event)) {
    noteOom(hostId, containerId, ts);
    fire({
      hostId,
      containerId,
      containerName,
      rule: 'oom_killed',
      severity: 'critical',
      message: `Container ${containerName || containerId} hit its memory limit and the kernel OOM-killed a process in it`,
    });
  }

  if (action === 'die') {
    const exitCode = raw && raw.Actor && raw.Actor.Attributes ? raw.Actor.Attributes.exitCode : undefined;
    // parseInt of a present-but-garbled exit code is NaN, not caught by the `: 0` default (which
    // only covers a genuinely missing attribute); without this it would still fire but read as
    // "exited with code NaN" instead of a message that actually describes what happened.
    const parsed = exitCode !== undefined ? parseInt(exitCode, 10) : 0;
    const code = Number.isNaN(parsed) ? null : parsed;
    if (code === 0) {
      // Async because it has to ask the daemon for the restart policy; never throws out of here -
      // handleEvent runs inside a stdout handler, where a rejection would be an unhandled one.
      checkCleanExit(event).catch((err) =>
        logger.warn('unexpected_exit.check_failed', { host: hostId, container: containerName || containerId, error: err.message })
      );
    } else {
      const recentManualStop = db.countManualStopsSince(hostId, containerId, ts - MANUAL_STOP_GRACE_MS) > 0;
      // mutedByRule only runs in this already-narrow, about-to-fire path - not once per
      // docker-events line - so this is at most one extra rules-table read per real crash.
      if (wasOomKilledRecently(hostId, containerId, ts)) {
        logger.info('alert.superseded', {
          host: hostId,
          container: containerName || containerId,
          rule: 'container_crashed',
          by: 'oom_killed',
        });
      } else if (!recentManualStop && !mutedByRule('container_crashed', event)) {
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

  // Start only: Docker sends restart beside start for `docker restart`, and Podman for every
  // restart, so counting both made one restart read as two. See server/CLAUDE.md.
  if (action === 'start') {
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

  if (action === 'health_status: healthy') {
    resolve({
      hostId,
      containerId,
      containerName,
      rule: 'unhealthy',
      message: `Container ${containerName || containerId} is healthy again`,
    });
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
    // host_unreachable below only ever records the down side - without a row here too, nothing
    // durable ever says the host came back, and server/uptime.js's computeHostUptime would have no
    // way to tell "down for the whole window" from "down for five minutes of it".
    db.insertHostReachability(hostId, Date.now(), false);
    fire({
      hostId,
      containerId: null,
      containerName: null,
      rule: 'host_unreachable',
      severity: 'critical',
      message: `Host ${hostName || hostId} became unreachable`,
    });
  }
  // Recovery is a log line always, and a resolved notice only where one was asked for - going down
  // was loud and coming back was silent, which left the log implying it's still down.
  if (!wasReachable && reachable) {
    db.insertHostReachability(hostId, Date.now(), true);
    logger.info('host.reachable', { host: hostId, name: hostName || hostId });
    resolve({ hostId, rule: 'host_unreachable', message: `Host ${hostName || hostId} is reachable again` });
  }
}

// Called once per running container on every stats poll (~5s), with `ctx` one alertContext() shared
// by the whole poll. cpuPerc is raw docker-stats CPU% (per-core cumulative, so 4 cores fully used
// reads 400%, matching the UI); memPerc is MemPerc against the container's own limit.
function handleSample({ hostId, containerId, containerName, composeProject, cpuPerc, memPerc, ts, alertsDisabled }, ctx) {
  // Unconditional, before any rules-table read - zero DB cost for a container opted out via the
  // label, same as today. See server/CLAUDE.md for why this stays separate from container_alert_rules.
  if (alertsDisabled) return;
  const cfg = resolveContainerConfig({ hostId, containerName, composeProject }, ctx);
  const sustainMs = cfg.sustainMinutes * 60_000;

  // Folded into "breached" itself rather than skipping checkSustained while disabled - a rule
  // switched off mid-breach still needs to clear its own persisted alert_breaches row via
  // checkSustained's !breached path, or it would sit there forever instead of self-healing.
  const cpuBreached = cfg.cpuThreshold > 0 && cpuPerc >= cfg.cpuThreshold;
  const cpu = checkSustained(`${hostId}:${containerId}:container_cpu`, cpuBreached, sustainMs, ts);
  if (cpu.sustained) {
    fire({
      hostId,
      containerId,
      containerName,
      rule: 'container_cpu',
      severity: 'warning',
      message: `Container ${containerName || containerId} CPU at ${cpuPerc.toFixed(1)}% (threshold ${cfg.cpuThreshold}%)`,
      openSince: cpu.start,
    });
  } else if (cpu.endedStart !== null && cfg.cpuThreshold > 0) {
    resolve({
      hostId,
      containerId,
      containerName,
      rule: 'container_cpu',
      sinceTs: cpu.endedStart,
      message: `Container ${containerName || containerId} CPU back under threshold (now ${cpuPerc.toFixed(1)}%, threshold ${cfg.cpuThreshold}%)`,
    });
  }

  const memBreached = cfg.memThreshold > 0 && memPerc >= cfg.memThreshold;
  const mem = checkSustained(`${hostId}:${containerId}:container_mem`, memBreached, sustainMs, ts);
  if (mem.sustained) {
    fire({
      hostId,
      containerId,
      containerName,
      rule: 'container_mem',
      severity: 'warning',
      message: `Container ${containerName || containerId} memory at ${memPerc.toFixed(1)}% (threshold ${cfg.memThreshold}%)`,
      openSince: mem.start,
    });
  } else if (mem.endedStart !== null && cfg.memThreshold > 0) {
    resolve({
      hostId,
      containerId,
      containerName,
      rule: 'container_mem',
      sinceTs: mem.endedStart,
      message: `Container ${containerName || containerId} memory back under threshold (now ${memPerc.toFixed(1)}%, threshold ${cfg.memThreshold}%)`,
    });
  }
}

// Called once per host per stats poll. cpuPercent is host-normalized (cpuSum /
// ncpu, so 100% means all cores busy); memPercent is sum-of-container-usage
// over host total memory. Takes the same ctx as handleSample - see server/CLAUDE.md.
function handleHostSample({ hostId, hostName, cpuPercent, memPercent, ts }, ctx) {
  const cfg = (ctx && ctx.global) || getThresholdConfig();
  const sustainMs = cfg.sustainMinutes * 60_000;

  // Same reasoning as handleSample above: fold the enabled-check into "breached" itself so a
  // disabled rule still clears its own persisted breach row via checkSustained's !breached path.
  const cpuBreached = cfg.cpuThreshold > 0 && cpuPercent >= cfg.cpuThreshold;
  const cpu = checkSustained(`${hostId}:host:host_cpu`, cpuBreached, sustainMs, ts);
  if (cpu.sustained) {
    fire({
      hostId,
      containerId: null,
      containerName: null,
      rule: 'host_cpu',
      severity: 'warning',
      message: `Host ${hostName || hostId} CPU at ${cpuPercent.toFixed(1)}% (threshold ${cfg.cpuThreshold}%)`,
      openSince: cpu.start,
    });
  } else if (cpu.endedStart !== null && cfg.cpuThreshold > 0) {
    resolve({
      hostId,
      rule: 'host_cpu',
      sinceTs: cpu.endedStart,
      message: `Host ${hostName || hostId} CPU back under threshold (now ${cpuPercent.toFixed(1)}%, threshold ${cfg.cpuThreshold}%)`,
    });
  }

  const memBreached = cfg.memThreshold > 0 && memPercent >= cfg.memThreshold;
  const mem = checkSustained(`${hostId}:host:host_mem`, memBreached, sustainMs, ts);
  if (mem.sustained) {
    fire({
      hostId,
      containerId: null,
      containerName: null,
      rule: 'host_mem',
      severity: 'warning',
      message: `Host ${hostName || hostId} memory at ${memPercent.toFixed(1)}% (threshold ${cfg.memThreshold}%)`,
      openSince: mem.start,
    });
  } else if (mem.endedStart !== null && cfg.memThreshold > 0) {
    resolve({
      hostId,
      rule: 'host_mem',
      sinceTs: mem.endedStart,
      message: `Host ${hostName || hostId} memory back under threshold (now ${memPercent.toFixed(1)}%, threshold ${cfg.memThreshold}%)`,
    });
  }
}

// Called once per host per disk-usage poll (~60s). `docker system df` reports Docker's own
// footprint, not host filesystem free space (Docker doesn't expose that) - so this is a "Docker
// is using more than X GB" reminder, not a disk-full alert. No sustain window; cooldown suffices.
function handleDiskUsage({ hostId, hostName, rows }, ctx) {
  const cfg = (ctx && ctx.global) || getThresholdConfig();
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
      openSince: 0,
    });
  } else {
    resolve({
      hostId,
      rule: 'docker_disk',
      message: `Docker disk usage on ${hostName || hostId} is back under threshold (now ${totalGb.toFixed(1)} GB, threshold ${cfg.diskThresholdGb} GB)`,
    });
  }
}

module.exports = {
  handleEvent,
  checkCleanExit,
  handleHostReachability,
  handleSample,
  handleHostSample,
  handleDiskUsage,
  retainContainers,
  forgetHost,
  buildDelivery,
  webhookScheme,
  routeMatches,
  selectDestinations,
  ALERT_RULES,
  WEBHOOK_MODES,
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
  dueFollowUps,
  sendFollowUps,
  REPEAT_MAX_MINUTES,
  start,
  stop,
};
