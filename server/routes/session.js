const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../logger');
const { version: appVersion } = require('../../package.json');
const { getDefaultView } = require('./settings');

const router = express.Router();

// Caps client-supplied text before it reaches a log line. Newlines need no handling: logger.js
// JSON.stringifies any value containing whitespace, so they can't forge a second line.
function clip(value, max) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max) || null;
}

// Backstop for a client that isn't ours - the client's own per-page cap (app.js) is the real
// defence. Generous enough that a burst of distinct errors still gets through.
const clientErrorLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: 'too many client error reports' },
});

// Puts browser-side failures (a blank page from a broken template) in the server log. 204 with no
// body: the client is fire-and-forget. See server/CLAUDE.md.
router.post('/client-error', clientErrorLimiter, (req, res) => {
  const { kind, message, source, line } = req.body || {};
  logger.warn('client.error', {
    user: req.session.username,
    kind: clip(kind, 40),
    message: clip(message, 300),
    source: clip(source, 200),
    line: Number.isFinite(Number(line)) ? Number(line) : null,
  });
  res.status(204).end();
});

router.get('/session', (req, res) => {
  res.json({ username: req.session.username, role: req.session.role, version: appVersion, defaultView: getDefaultView() });
});

module.exports = router;
