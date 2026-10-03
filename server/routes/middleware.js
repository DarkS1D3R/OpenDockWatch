const { getHost } = require('../hosts');
const { ALLOWED_ACTIONS } = require('../docker');
const logger = require('../logger');

// Longer than any docker call this can be waiting on (CONTAINER_ACTION_TIMEOUT_MS, the longest,
// is 30s) plus the queue wait in docker.js's run(), so a request only hits this once the call
// behind it has stopped being merely slow. The compose-group route is exempt - see routes/containers.js.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 50_000;

// Number('abc') is NaN, and better-sqlite3 rejects NaN outright ("datatype mismatch") rather
// than treating it as absent - so a garbled ?limit=/?since= would 500 instead of falling back.
// Clamping the upper bound too keeps a hand-written ?limit=10000000 from pulling the whole table.
function intParam(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

// `docker logs --tail` takes a line count or the literal "all" (the log viewer's "All lines"
// option), so this can't just be intParam - but everything else has to be a plain positive
// integer before it's handed to the CLI.
function tailParam(raw, fallback) {
  if (raw === 'all') return 'all';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Container ids/names go into the docker CLI's argv (execFile/spawn with an array, never a
// shell), so this isn't about injection - it's that an id starting with "-" would be read by
// docker as a flag rather than a container, better refused here than handed over misparsed.
const CONTAINER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function requireContainerId(req, res, next) {
  if (!CONTAINER_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid container id' });
  next();
}

// :action reaches the audit log and the *event name* of a log line before containerAction can
// reject it, and express URL-decodes path params - so unchecked, a bogus action writes a phantom
// audit row and an embedded newline forges a whole second log line. docker.js's set, not a copy.
function requireContainerAction(req, res, next) {
  if (!ALLOWED_ACTIONS.has(req.params.action)) {
    return res.status(400).json({ error: `invalid container action - expected one of ${[...ALLOWED_ACTIONS].join(', ')}` });
  }
  next();
}

// Resolves :hostId to a configured host so route handlers don't each repeat the getHost()/404
// pair. The property is `odwHost` and must not be `host`: express defines req.host as a getter-only
// property (the Host header), so assigning it silently no-ops and handlers get a string. See server/CLAUDE.md.
function requireHost(req, res, next) {
  const host = getHost(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  req.odwHost = host;
  next();
}

// Same 400/404 pair for the routes that scope by ?hostId= rather than a path segment, so a typo'd
// host id can't come back 200 having done nothing. Sets no req.odwHost: these routes only ever
// hand the id to sqlite, never to the docker CLI, so there is nothing to resolve it to.
function requireHostQuery(req, res, next) {
  if (!req.query.hostId) return res.status(400).json({ error: 'hostId required' });
  if (!getHost(req.query.hostId)) return res.status(404).json({ error: 'unknown host' });
  next();
}

// A browser allows ~6 connections per origin over HTTP/1.1, some held open indefinitely by
// design (SSE streams) - a request that never answers holds a slot until the tab can't issue
// any request at all. So: answer, always, even 504. SSE routes are exempt by path suffix.
const STREAMING_PATH_RE = /\/(logs|logs\/download|events\/stream)$/;

// The compose-group route runs its levels sequentially, each up to CONTAINER_ACTION_TIMEOUT_MS,
// so REQUEST_TIMEOUT_MS's single-docker-call budget doesn't hold for it - it sizes its own timeout
// with armResponseTimeout instead of the blanket one below. See routes/containers.js.
const COMPOSE_GROUP_PATH_RE = /\/compose\/[^/]+\/[^/]+$/;

// Wraps res.json so a late real response after the timer fires is dropped instead of throwing
// ERR_HTTP_HEADERS_SENT (the 504 already went out through the captured original), and clears the
// timer on finish/close. Shared by the blanket timeout below and routes/containers.js.
function armResponseTimeout(req, res, ms) {
  let timedOut = false;
  const sendJson = res.json.bind(res);
  res.json = (body) => (timedOut ? res : sendJson(body));

  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    timedOut = true;
    logger.warn('request.timeout', { method: req.method, path: req.originalUrl, ms });
    res.status(504);
    sendJson({ error: 'timed out waiting for the docker daemon' });
  }, ms);

  const clear = () => clearTimeout(timer);
  res.on('finish', clear);
  res.on('close', clear);
}

function requestTimeout(ms) {
  return (req, res, next) => {
    if (STREAMING_PATH_RE.test(req.path) || COMPOSE_GROUP_PATH_RE.test(req.path)) return next();
    armResponseTimeout(req, res, ms);
    next();
  };
}

// docker.js's run() attaches the CLI's real stderr to err.stderr; anything else only has
// err.message. Every docker-backed route reports failure the same way, so this fallback is
// spelled out once here instead of copy-pasted into every catch block.
function dockerError(res, err, status = 502) {
  res.status(status).json({ error: err.stderr || err.message });
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  STREAMING_PATH_RE,
  intParam,
  tailParam,
  requireContainerId,
  requireContainerAction,
  requireHost,
  requireHostQuery,
  armResponseTimeout,
  requestTimeout,
  dockerError,
};
