const express = require('express');
const { requireAdmin } = require('../auth');
const db = require('../db');
const logger = require('../logger');
const eventWatcher = require('../eventWatcher');
const { requireHost, requireHostQuery, intParam } = require('./middleware');
const { forgetDashboardCaches } = require('./dashboardData');

const router = express.Router();

const MAX_ROW_LIMIT = 1000;

router.get('/hosts/:hostId/events', requireHost, (req, res) => {
  const sinceTs = intParam(req.query.since, 0);
  const limit = intParam(req.query.limit, 200, MAX_ROW_LIMIT);
  const rows = db.getEvents(req.params.hostId, { sinceTs, limit });
  res.json(
    rows.map((r) => ({
      hostId: r.host_id,
      containerId: r.container_id,
      containerName: r.container_name,
      action: r.action,
      ts: r.ts,
    }))
  );
});

// The clears are soft, so `cleared_at` already records when - this records *who*, which is the
// audit question and the one thing that column can't answer. No container, and no pending/ok pair
// either: unlike a container action the delete is synchronous, so there is no window to report.
function auditClear(req, hostId, action) {
  db.insertAuditLog({
    ts: Date.now(),
    username: req.session.username || null,
    hostId,
    containerId: null,
    containerName: null,
    action,
    result: 'ok',
    error: null,
  });
}

router.delete('/hosts/:hostId/events', requireAdmin, requireHost, (req, res) => {
  const count = db.clearEvents(req.params.hostId);
  auditClear(req, req.params.hostId, 'clear_events');
  logger.info('events.clear', { host: req.params.hostId, user: req.session.username, count });
  res.json({ ok: true, count });
});

// Logged on both ends: these hold one of the browser's ~6 per-origin connections for as long as
// the Activity tab is open, so "which streams are actually open right now" is worth being able to
// reconstruct from the log when the UI goes unresponsive. See server/CLAUDE.md's connection budget.
router.get('/hosts/:hostId/events/stream', requireHost, (req, res) => {
  const unsubscribe = eventWatcher.broadcaster.subscribe(res, req.params.hostId);
  const openedAt = Date.now();
  logger.info('events.stream.subscribed', { host: req.params.hostId, user: req.session.username });
  req.on('close', () => {
    unsubscribe();
    logger.info('events.stream.unsubscribed', {
      host: req.params.hostId,
      user: req.session.username,
      heldSec: Math.round((Date.now() - openedAt) / 1000),
    });
  });
});

// Admin-only, unlike the alerts list below it: this is who ran what, and its `error` column carries
// raw docker/ssh stderr. Same call as masking Config.Env for a viewer - read-only does not mean
// "may read everything", and nothing in public/js reads this route at all. See server/CLAUDE.md.
router.get('/audit', requireAdmin, (req, res) => {
  const limit = intParam(req.query.limit, 200, MAX_ROW_LIMIT);
  res.json(db.getAuditLog(req.query.hostId || null, { limit }));
});

router.get('/alerts', (req, res) => {
  const limit = intParam(req.query.limit, 200, MAX_ROW_LIMIT);
  res.json(db.getAlerts(req.query.hostId || null, { limit }));
});

// Each of these mutates rows dashboardExtrasCache already answered from - must invalidate it, or
// a clear/ack is invisible to /dashboard until the next statsTs tick. See server/CLAUDE.md.
router.post('/alerts/:id/ack', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid alert id' });
  // The id alone doesn't say which host's cache to invalidate - looked up before acking.
  const hostId = db.getAlertHostId(id);
  db.ackAlert(id);
  if (hostId) forgetDashboardCaches(hostId);
  res.json({ ok: true });
});

// requireHostQuery, the same as DELETE /alerts below: a typo'd id used to come back 200 with a
// count of 0, which reads as "there was nothing to acknowledge" when the truth is "no such host".
router.post('/alerts/ack-all', requireAdmin, requireHostQuery, (req, res) => {
  const count = db.ackAllAlerts(req.query.hostId);
  forgetDashboardCaches(req.query.hostId);
  res.json({ ok: true, count });
});

router.delete('/alerts', requireAdmin, requireHostQuery, (req, res) => {
  const hostId = req.query.hostId;
  const count = db.clearAlerts(hostId);
  forgetDashboardCaches(hostId);
  auditClear(req, hostId, 'clear_alerts');
  logger.info('alerts.clear', { host: hostId, user: req.session.username, count });
  res.json({ ok: true, count });
});

module.exports = router;
