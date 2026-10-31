const express = require('express');
const { requireAdmin } = require('../auth');
const { loadHosts, saveHosts, isValidHostId, isValidDockerHostUrl, hasLocalHost } = require('../hosts');
const { testHostConnection } = require('../docker');
const db = require('../db');
const logger = require('../logger');
const alerts = require('../alerts');
const eventWatcher = require('../eventWatcher');
const metricsCollector = require('../metricsCollector');
const { requireHost, dockerError } = require('./middleware');
const { forgetDashboardCaches } = require('./dashboardData');
const { VALID_VIEWS } = require('../views');
const imageUpdates = require('../imageUpdates');
const inventory = require('../inventory');

const router = express.Router();

// The tab the app lands on after login - env default + DB override. Not admin-gated: /session
// hands it to every role, so a viewer's landing tab matches the configured default.
const DEFAULT_VIEW_KEY = 'defaultView';
const FALLBACK_VIEW = 'list';

// Resolved once at load, not per /session call, so a misspelt .env value warns once at boot
// instead of on every login.
const ENV_DEFAULT_VIEW = (() => {
  const raw = process.env.DEFAULT_VIEW;
  if (!raw) return FALLBACK_VIEW;
  if (VALID_VIEWS.has(raw)) return raw;
  logger.warn('config.default_view.invalid', { value: raw, using: FALLBACK_VIEW });
  return FALLBACK_VIEW;
})();

// Validated on the way out too: a hand-edited or stale row would land the client on a tab nothing
// renders. An unusable row counts as absent, which keeps `overridden` honest. See server/CLAUDE.md.
function dbDefaultView() {
  const val = db.getSetting(DEFAULT_VIEW_KEY);
  return val !== null && VALID_VIEWS.has(val) ? val : null;
}

function getDefaultView() {
  return dbDefaultView() || ENV_DEFAULT_VIEW;
}

router.get('/settings/default-view', requireAdmin, (req, res) => {
  res.json({ defaultView: getDefaultView(), overridden: dbDefaultView() !== null });
});

router.put('/settings/default-view', requireAdmin, (req, res) => {
  const { defaultView } = req.body || {};
  if (!VALID_VIEWS.has(defaultView)) {
    return res.status(400).json({ error: `defaultView must be one of ${[...VALID_VIEWS].join(', ')}` });
  }
  db.setSetting(DEFAULT_VIEW_KEY, defaultView);
  logger.info('settings.default_view.update', { user: req.session.username, defaultView });
  res.json({ defaultView, overridden: true });
});

router.delete('/settings/default-view', requireAdmin, (req, res) => {
  db.deleteSetting(DEFAULT_VIEW_KEY);
  logger.info('settings.default_view.clear', { user: req.session.username });
  res.json({ defaultView: ENV_DEFAULT_VIEW, overridden: false });
});

// Webhook URLs carry auth tokens (Discord/Gotify) - admin-only, same as
// container control.
const ALLOWED_WEBHOOK_SCHEMES = new Set(['http:', 'https:', 'discord:', 'ntfy:', 'gotify:', 'gotifys:']);

router.get('/settings/webhook', requireAdmin, (req, res) => {
  res.json(alerts.getWebhookConfig());
});

// Shared by the main webhook and every route, so the two can't accept different URLs.
function webhookUrlError(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid webhook URL';
  }
  if (!ALLOWED_WEBHOOK_SCHEMES.has(parsed.protocol)) {
    return `unsupported scheme "${parsed.protocol}" - use http(s), discord, ntfy, gotify, or gotifys`;
  }
  return null;
}

// Reminder interval and a route's escalation delay share one range: whole minutes, up to a day.
function minutesError(field, value) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > alerts.REPEAT_MAX_MINUTES) {
    return `${field} must be a whole number of minutes from 0 to ${alerts.REPEAT_MAX_MINUTES}`;
  }
  return null;
}

router.put('/settings/webhook', requireAdmin, (req, res) => {
  const { url = '', format = '', notifyRecovery, mode, repeatMinutes } = req.body || {};
  const urlError = url ? webhookUrlError(url) : null;
  if (urlError) return res.status(400).json({ error: urlError });
  if (format && format !== 'slack') {
    return res.status(400).json({ error: 'format must be empty or "slack"' });
  }
  if (notifyRecovery !== undefined && typeof notifyRecovery !== 'boolean') {
    return res.status(400).json({ error: 'notifyRecovery must be true or false' });
  }
  if (mode !== undefined && !alerts.WEBHOOK_MODES.has(mode)) {
    return res.status(400).json({ error: 'mode must be "all" or "unmatched"' });
  }
  const repeatError = minutesError('repeatMinutes', repeatMinutes);
  if (repeatError) return res.status(400).json({ error: repeatError });
  // Scheme only, never the full URL - webhook URLs embed secrets (Discord token, Slack path, ntfy
  // topic) that have no business in the container's log output. Shared helper, same reason.
  logger.info('settings.webhook.update', {
    user: req.session.username,
    url: url ? alerts.webhookScheme(url) : '(cleared)',
    format: format || 'auto',
    notifyRecovery,
    mode,
    repeatMinutes,
  });
  res.json(alerts.setWebhookConfig({ url, format, notifyRecovery, mode, repeatMinutes }));
});

router.delete('/settings/webhook', requireAdmin, (req, res) => {
  logger.info('settings.webhook.clear', { user: req.session.username });
  res.json(alerts.clearWebhookConfig());
});

router.post('/settings/webhook/test', requireAdmin, async (req, res) => {
  try {
    await alerts.sendTestAlert();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Extra webhook destinations, each taking the alerts its host/rules/severity filters match - every
// matching route gets the alert, not just the first. See alerts.js's selectDestinations.
const ALERT_RULE_NAMES = new Set(alerts.ALERT_RULES);
const ROUTE_SEVERITIES = new Set(['warning', 'critical']);
const ROUTE_NAME_MAX = 60;

function validateWebhookRouteBody(body, hosts) {
  const { name, url, format, hostId, rules, minSeverity, notifyRecovery, enabled, delayMinutes } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > ROUTE_NAME_MAX)
    return `name is required, up to ${ROUTE_NAME_MAX} characters`;
  if (typeof url !== 'string' || !url) return 'url is required';
  const urlError = webhookUrlError(url);
  if (urlError) return urlError;
  if (format && format !== 'slack') return 'format must be empty or "slack"';
  if (hostId && !hosts.some((h) => h.id === hostId)) return 'unknown hostId';
  if (rules !== undefined && (!Array.isArray(rules) || rules.some((r) => !ALERT_RULE_NAMES.has(r)))) {
    return `rules must be an array of ${alerts.ALERT_RULES.join('/')}`;
  }
  if (minSeverity !== undefined && !ROUTE_SEVERITIES.has(minSeverity)) return 'minSeverity must be "warning" or "critical"';
  const delayError = minutesError('delayMinutes', delayMinutes);
  if (delayError) return delayError;
  for (const [field, val] of [
    ['notifyRecovery', notifyRecovery],
    ['enabled', enabled],
  ]) {
    if (val !== undefined && typeof val !== 'boolean') return `${field} must be true or false`;
  }
  return null;
}

function normalizeWebhookRouteBody(body) {
  return {
    name: body.name.trim(),
    url: body.url,
    format: body.format || '',
    hostId: body.hostId || null,
    rules: [...new Set(body.rules || [])],
    minSeverity: body.minSeverity || 'warning',
    notifyRecovery: !!body.notifyRecovery,
    enabled: body.enabled !== false,
    delayMinutes: body.delayMinutes || 0,
  };
}

router.get('/settings/webhook-routes', requireAdmin, (req, res) => {
  res.json(db.getWebhookRoutes());
});

router.post('/settings/webhook-routes', requireAdmin, (req, res) => {
  const body = req.body || {};
  const err = validateWebhookRouteBody(body, loadHosts());
  if (err) return res.status(400).json({ error: err });
  const route = normalizeWebhookRouteBody(body);
  const id = db.insertWebhookRoute(route);
  logger.info('settings.webhook_routes.add', { user: req.session.username, id, url: alerts.webhookScheme(route.url) });
  res.json(db.getWebhookRoutes());
});

router.put('/settings/webhook-routes/:id', requireAdmin, (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid route id' });
  const body = req.body || {};
  const err = validateWebhookRouteBody(body, loadHosts());
  if (err) return res.status(400).json({ error: err });
  const route = normalizeWebhookRouteBody(body);
  if (!db.updateWebhookRoute(id, route)) return res.status(404).json({ error: 'no such route' });
  logger.info('settings.webhook_routes.update', { user: req.session.username, id, url: alerts.webhookScheme(route.url) });
  res.json(db.getWebhookRoutes());
});

router.delete('/settings/webhook-routes/:id', requireAdmin, (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid route id' });
  if (!db.deleteWebhookRoute(id)) return res.status(404).json({ error: 'no such route' });
  logger.info('settings.webhook_routes.remove', { user: req.session.username, id });
  res.json(db.getWebhookRoutes());
});

router.post('/settings/webhook-routes/:id/test', requireAdmin, async (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid route id' });
  if (!db.getWebhookRoutes().some((r) => r.id === id)) return res.status(404).json({ error: 'no such route' });
  try {
    await alerts.sendTestAlert({ routeId: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// How often to check running images against their registries - 0 is off. Same env-default +
// DB-override shape as the rest. See imageUpdates.js for why off is the default.
const IMAGE_CHECK_MAX_HOURS = 24 * 30;

router.get('/settings/image-updates', requireAdmin, (req, res) => {
  res.json(imageUpdates.getCheckConfig());
});

router.put('/settings/image-updates', requireAdmin, (req, res) => {
  const hours = Number((req.body || {}).hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > IMAGE_CHECK_MAX_HOURS) {
    return res.status(400).json({ error: `hours must be between 0 (off) and ${IMAGE_CHECK_MAX_HOURS}` });
  }
  logger.info('settings.image_updates.update', { user: req.session.username, hours });
  res.json(imageUpdates.setCheckConfig({ hours }));
});

router.delete('/settings/image-updates', requireAdmin, (req, res) => {
  logger.info('settings.image_updates.clear', { user: req.session.username });
  res.json(imageUpdates.clearCheckConfig());
});

// Resource-threshold rules (container/host CPU & mem, Docker disk footprint) -
// same env-default + DB-override + admin-only shape as the webhook settings above.
const THRESHOLD_FIELDS = ['cpuThreshold', 'memThreshold', 'sustainMinutes', 'diskThresholdGb'];

router.get('/settings/thresholds', requireAdmin, (req, res) => {
  res.json(alerts.getThresholdConfig());
});

router.put('/settings/thresholds', requireAdmin, (req, res) => {
  const body = req.body || {};
  const values = {};
  for (const field of THRESHOLD_FIELDS) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      values[field] = 0;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${field} must be a non-negative number` });
    }
    values[field] = n;
  }
  logger.info('settings.thresholds.update', { user: req.session.username, ...values });
  res.json(alerts.setThresholdConfig(values));
});

router.delete('/settings/thresholds', requireAdmin, (req, res) => {
  logger.info('settings.thresholds.clear', { user: req.session.username });
  res.json(alerts.clearThresholdConfig());
});

// Host management (add/edit/remove monitored Docker hosts, including SSH-based remote ones) -
// writes to config/hosts.json via saveHosts() and immediately starts/stops the corresponding
// metricsCollector polling and eventWatcher watching, so changes take effect without a restart.
router.get('/settings/hosts', requireAdmin, (req, res) => {
  res.json(loadHosts());
});

router.post('/settings/hosts', requireAdmin, (req, res) => {
  const { id, name, dockerHost } = req.body || {};
  if (!isValidHostId(id)) {
    return res.status(400).json({ error: 'id is required and may only contain letters, numbers, - and _' });
  }
  const hosts = loadHosts();
  if (hosts.some((h) => h.id === id)) {
    return res.status(400).json({ error: `a host with id "${id}" already exists` });
  }
  if (!isValidDockerHostUrl(dockerHost)) {
    return res.status(400).json({ error: 'dockerHost must be an ssh:// URL, a unix:///path socket, or blank for the local socket' });
  }
  if (!dockerHost && hasLocalHost(hosts)) {
    return res.status(400).json({ error: 'a host already uses the local socket - only one local connection is allowed' });
  }
  const host = { id, name: name || undefined, dockerHost: dockerHost || null, edges: [] };
  const updated = [...hosts, host];
  saveHosts(updated);
  metricsCollector.addHost(host);
  eventWatcher.addHost(host);
  logger.info('settings.hosts.add', { user: req.session.username, host: id, dockerHost: dockerHost || 'local' });
  res.json(updated);
});

router.put('/settings/hosts/:id', requireAdmin, (req, res) => {
  const hosts = loadHosts();
  const idx = hosts.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'unknown host' });
  const { name, dockerHost } = req.body || {};
  if (!isValidDockerHostUrl(dockerHost)) {
    return res.status(400).json({ error: 'dockerHost must be an ssh:// URL, a unix:///path socket, or blank for the local socket' });
  }
  if (!dockerHost && hasLocalHost(hosts, req.params.id)) {
    return res.status(400).json({ error: 'a host already uses the local socket - only one local connection is allowed' });
  }
  const updatedHost = { ...hosts[idx], name: name || undefined, dockerHost: dockerHost || null };
  const updated = [...hosts];
  updated[idx] = updatedHost;
  saveHosts(updated);
  // Reconnect with the new config rather than trying to figure out exactly what changed.
  metricsCollector.removeHost(updatedHost.id);
  eventWatcher.removeHost(updatedHost.id);
  forgetDashboardCaches(updatedHost.id);
  imageUpdates.forgetHost(updatedHost.id);
  inventory.forgetHost(updatedHost.id);
  metricsCollector.addHost(updatedHost);
  eventWatcher.addHost(updatedHost);
  logger.info('settings.hosts.update', { user: req.session.username, host: updatedHost.id, dockerHost: dockerHost || 'local' });
  res.json(updated);
});

router.delete('/settings/hosts/:id', requireAdmin, (req, res) => {
  const hosts = loadHosts();
  if (!hosts.some((h) => h.id === req.params.id)) return res.status(404).json({ error: 'unknown host' });
  const updated = hosts.filter((h) => h.id !== req.params.id);
  saveHosts(updated);
  metricsCollector.removeHost(req.params.id);
  eventWatcher.removeHost(req.params.id);
  forgetDashboardCaches(req.params.id);
  imageUpdates.forgetHost(req.params.id);
  inventory.forgetHost(req.params.id);
  // Once the host is gone its alerts can't be shown, acknowledged or cleared from the UI, and an
  // open one would keep counting and keep getting reminders. A soft clear, as from the Activity tab.
  const alertsCleared = db.clearAlerts(req.params.id);
  logger.info('settings.hosts.remove', { user: req.session.username, host: req.params.id, alertsCleared });
  res.json(updated);
});

// Runs the same probe as the reachability poll, but surfaces the real docker/ssh stderr instead
// of collapsing it to a boolean - "Host key verification failed" or "Permission denied
// (publickey)" tells the user exactly what to fix, "unreachable" in the host card doesn't.
router.post('/settings/hosts/:hostId/test', requireAdmin, requireHost, async (req, res) => {
  const host = req.odwHost;
  try {
    await testHostConnection(host);
    res.json({ ok: true });
  } catch (err) {
    dockerError(res, err);
  }
});

// Per-container/name/compose-project alert overrides - first-match-wins ordered list, same
// admin-only shape as the webhook/threshold/host settings above. See alerts.js's resolveContainerConfig.
const EVENT_RULE_NAMES = new Set(['container_crashed', 'crash_loop', 'unhealthy', 'unexpected_exit', 'oom_killed']);
const MATCH_TYPES = new Set(['name', 'composeProject']);

// Same reasoning as intParam/requireContainerId: nothing off the URL reaches sqlite unchecked.
// Returns null for anything that isn't a positive integer rowid, so the route can 400 rather than
// bind a NaN that quietly matches no row and reports success.
function ruleIdParam(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validateContainerRuleBody(body, hosts) {
  const { hostId, matchType, matchValue, cpuThreshold, memThreshold, sustainMinutes, mutedRules } = body;
  if (hostId && !hosts.some((h) => h.id === hostId)) return 'unknown hostId';
  if (!MATCH_TYPES.has(matchType)) return 'matchType must be "name" or "composeProject"';
  if (!matchValue || typeof matchValue !== 'string' || !matchValue.trim()) return 'matchValue is required';
  for (const [field, val] of [
    ['cpuThreshold', cpuThreshold],
    ['memThreshold', memThreshold],
    ['sustainMinutes', sustainMinutes],
  ]) {
    if (val !== null && val !== undefined && val !== '' && (!Number.isFinite(Number(val)) || Number(val) < 0)) {
      return `${field} must be a non-negative number, or blank to inherit the global default`;
    }
  }
  if (mutedRules !== undefined && (!Array.isArray(mutedRules) || mutedRules.some((r) => !EVENT_RULE_NAMES.has(r)))) {
    return 'mutedRules must be an array of container_crashed/crash_loop/unhealthy/unexpected_exit/oom_killed';
  }
  return null;
}

function normalizeContainerRuleBody(body) {
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    hostId: body.hostId || null,
    matchType: body.matchType,
    matchValue: body.matchValue.trim(),
    cpuThreshold: num(body.cpuThreshold),
    memThreshold: num(body.memThreshold),
    sustainMinutes: num(body.sustainMinutes),
    mutedRules: body.mutedRules || [],
  };
}

router.get('/settings/container-rules', requireAdmin, (req, res) => {
  res.json(db.getContainerAlertRules());
});

// Registered before the /:id routes below - :id would otherwise match the literal string
// "reorder" too, since Express matches route patterns in registration order.
router.put('/settings/container-rules/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body || {};
  const existing = db.getContainerAlertRules();
  const existingIds = new Set(existing.map((r) => r.id));
  const valid =
    Array.isArray(orderedIds) &&
    orderedIds.length === existing.length &&
    orderedIds.every((id) => existingIds.has(id)) &&
    new Set(orderedIds).size === orderedIds.length;
  if (!valid) return res.status(400).json({ error: 'orderedIds must list every existing rule id exactly once' });
  db.reorderContainerAlertRules(orderedIds);
  logger.info('settings.container_rules.reorder', { user: req.session.username });
  res.json(db.getContainerAlertRules());
});

router.post('/settings/container-rules', requireAdmin, (req, res) => {
  const body = req.body || {};
  const err = validateContainerRuleBody(body, loadHosts());
  if (err) return res.status(400).json({ error: err });
  db.insertContainerAlertRule(normalizeContainerRuleBody(body));
  logger.info('settings.container_rules.add', { user: req.session.username, matchType: body.matchType, matchValue: body.matchValue });
  res.json(db.getContainerAlertRules());
});

router.put('/settings/container-rules/:id', requireAdmin, (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid rule id' });
  const body = req.body || {};
  const err = validateContainerRuleBody(body, loadHosts());
  if (err) return res.status(400).json({ error: err });
  if (!db.updateContainerAlertRule(id, normalizeContainerRuleBody(body))) {
    return res.status(404).json({ error: 'no such rule' });
  }
  logger.info('settings.container_rules.update', { user: req.session.username, id });
  res.json(db.getContainerAlertRules());
});

router.delete('/settings/container-rules/:id', requireAdmin, (req, res) => {
  const id = ruleIdParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid rule id' });
  if (!db.deleteContainerAlertRule(id)) return res.status(404).json({ error: 'no such rule' });
  logger.info('settings.container_rules.remove', { user: req.session.username, id });
  res.json(db.getContainerAlertRules());
});

module.exports = { router, getDefaultView };
