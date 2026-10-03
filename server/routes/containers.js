const express = require('express');
const { requireAdmin } = require('../auth');
const { streamLogs, downloadLogs, CONTAINER_ACTION_TIMEOUT_MS, MAX_QUEUE_WAIT_MS } = require('../docker');
// The module object, not a destructured reference, for the calls the compose-group route and
// performContainerAction make - test/index.test.js mocks them afterwards. See server/CLAUDE.md.
const docker = require('../docker');
const db = require('../db');
const logger = require('../logger');
const metricsCollector = require('../metricsCollector');
const { orderGroupLevels, mapLimit } = require('../composeGroup');
const {
  REQUEST_TIMEOUT_MS,
  tailParam,
  requireHost,
  requireContainerId,
  requireContainerAction,
  armResponseTimeout,
  dockerError,
} = require('./middleware');

const router = express.Router();

const SSE_HEARTBEAT_MS = 30_000;

// Live count of held `docker logs -f` children, each also holding one of the browser's ~6
// per-origin connections. Running out of either is the app's main self-inflicted hang.
let openLogStreams = 0;

// Shared by the single and compose-group routes so a group action writes the same audit_log row
// and log-line pair - alerts.js's manual-stop suppression reads audit_log by ts. Never throws: a
// failed action is a reportable {ok: false}, not an exception. See server/CLAUDE.md.
async function performContainerAction(host, containerId, action, { username, containerName }) {
  const logFields = { user: username, host: host.id, container: containerName || containerId };
  const startedAt = Date.now();

  // Written before containerAction runs, not after it resolves - the daemon can emit the
  // die/start event before this CLI call returns (a slow-to-stop container). alerts.js's
  // manual-stop suppression looks this row up by ts, so it must already exist or a fast event races it.
  const auditId = db.insertAuditLog({
    ts: Date.now(),
    username: username || null,
    hostId: host.id,
    containerId,
    containerName: containerName || null,
    action,
    result: 'pending',
    error: null,
  });

  // Paired with the completion line below rather than logging only on success: `docker stop` can
  // sit through its full 10s SIGTERM grace (longer against a wedged daemon), and until it returned
  // a pressed button left nothing in the log at all - only a 'pending' audit row.
  logger.info(`container.${action}.requested`, logFields);

  try {
    // Module object, not the destructured containerAction above - mockable for the same reason
    // docker.listContainers/getTopologyMeta are, and metricsCollector.pollHost's own docker calls
    // already go through the module object for the identical reason. See server/CLAUDE.md.
    await docker.containerAction(host, containerId, action);
    db.updateAuditLogResult(auditId, 'ok', null);
    logger.info(`container.${action}`, { ...logFields, tookMs: Date.now() - startedAt });
    return { ok: true };
  } catch (err) {
    const detail = err.stderr || err.message;
    db.updateAuditLogResult(auditId, 'error', detail);
    logger.error(`container.${action}`, { ...logFields, tookMs: Date.now() - startedAt, error: detail });
    return { ok: false, error: detail };
  }
}

router.post(
  '/hosts/:hostId/containers/:id/:action',
  requireAdmin,
  requireHost,
  requireContainerId,
  requireContainerAction,
  async (req, res) => {
    const host = req.odwHost;
    const snapshot = metricsCollector.getSnapshot(req.params.hostId);
    const container = (snapshot?.containers || []).find((c) => c.id === req.params.id);
    const result = await performContainerAction(host, req.params.id, req.params.action, {
      username: req.session.username,
      containerName: container ? container.name : null,
    });
    if (result.ok) return res.json({ ok: true });
    dockerError(res, { stderr: result.error });
  }
);

// Group actions are batch start/stop/restart, not real `docker compose up`/`down` - the compose
// YAML is never available here, so a group is identified by its compose project label alone.
// See server/CLAUDE.md.

// Caps how many containers within one level run at once - leaves most of docker.js's
// MAX_CONCURRENT slots free for other hosts' polls and other viewers' requests. See mapLimit
// in composeGroup.js and server/CLAUDE.md.
const COMPOSE_LEVEL_CONCURRENCY = 4;

router.post('/hosts/:hostId/compose/:project/:action', requireAdmin, requireHost, requireContainerAction, async (req, res) => {
  const host = req.odwHost;
  const { project } = req.params;
  const action = req.params.action;

  let containers;
  try {
    containers = await docker.listContainers(host);
  } catch (err) {
    return dockerError(res, err);
  }
  const groupContainers = containers.filter((c) => c.composeProject === project);
  if (!groupContainers.length) return res.status(404).json({ error: 'no such compose project on this host' });

  // Ordering is a nicety on top of a correct-either-way action, not a precondition for it - a
  // depends_on label that fails to parse (or the docker call behind it failing outright) falls
  // back to one unordered level rather than failing the whole group action.
  let edges = [];
  try {
    const meta = await docker.getTopologyMeta(host, containers);
    edges = docker.dependsOnEdges(containers, meta.dependsOnRaw);
  } catch (err) {
    logger.warn('compose_group.order.failed', { host: host.id, project, error: err.message });
  }

  const byId = new Map(groupContainers.map((c) => [c.id, c]));
  const levels = orderGroupLevels(
    groupContainers.map((c) => c.id),
    edges,
    action
  );

  // Levels run sequentially and each level now runs in batches of COMPOSE_LEVEL_CONCURRENCY (below),
  // so this route is exempt from the blanket REQUEST_TIMEOUT_MS (COMPOSE_GROUP_PATH_RE) and sizes
  // its own instead, worst-case batch count times a batch's worst-case time.
  const totalBatches = levels.reduce((sum, level) => sum + Math.ceil(level.length / COMPOSE_LEVEL_CONCURRENCY), 0);
  const timeoutMs = Math.max(REQUEST_TIMEOUT_MS, totalBatches * (CONTAINER_ACTION_TIMEOUT_MS + MAX_QUEUE_WAIT_MS));
  armResponseTimeout(req, res, timeoutMs);

  const results = [];
  for (const level of levels) {
    const settled = await mapLimit(level, COMPOSE_LEVEL_CONCURRENCY, async (id) => {
      const c = byId.get(id);
      const outcome = await performContainerAction(host, id, action, { username: req.session.username, containerName: c.name });
      return { containerId: id, containerName: c.name, ...outcome };
    });
    results.push(...settled);
  }

  res.json({ project, action, results });
});

router.get('/hosts/:hostId/containers/:id/logs', requireHost, requireContainerId, (req, res) => {
  const host = req.odwHost;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const tail = tailParam(req.query.tail, 200);
  const child = streamLogs(host, req.params.id, { tail });
  // Each of these is a `docker logs -f` child on the host *and* a held browser connection, and
  // the pair is the app's main way of running out of either. closedBy says which side ended it:
  // 'client' is a normal pane close or tab suspend, 'child' is docker exiting under us.
  const openedAt = Date.now();
  openLogStreams += 1;
  logger.info('logs.stream.open', { host: host.id, container: req.params.id, tail, user: req.session.username, open: openLogStreams });
  // Decremented here rather than in cleanup() so it can't be missed by a future early return -
  // cleanup is the single place that calls this, and it self-guards against running twice.
  const logClose = (closedBy) => {
    openLogStreams = Math.max(0, openLogStreams - 1);
    logger.info('logs.stream.close', {
      host: host.id,
      container: req.params.id,
      closedBy,
      heldSec: Math.round((Date.now() - openedAt) / 1000),
      open: openLogStreams,
    });
  };

  // Buffer partial lines per-stream (stdout/stderr arrive as independent byte
  // streams) so a line split across chunk boundaries isn't emitted as two SSE
  // events, which breaks timestamps and the frontend's level detection.
  const makeSender = () => {
    let buffer = '';
    return (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.length) res.write(`data: ${line}\n\n`);
      }
    };
  };

  child.stdout.on('data', makeSender());
  child.stderr.on('data', makeSender());

  // Behind nginx or any proxy with an idle timeout, a quiet log stream gets cut -
  // a periodic comment line keeps the connection alive.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

  // Either side can end this first: client disconnect, or `docker logs -f` itself exiting (a
  // removed container, a restarted daemon) - without ending the response on the latter, the
  // heartbeat kept it looking alive forever. Ending it lets EventSource's reconnect take over.
  let closed = false;
  const cleanup = (closedBy) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    child.kill();
    res.end();
    logClose(closedBy);
  };

  child.on('error', (err) => {
    // Only the browser pane used to see this - a stream that never starts left nothing server-side.
    logger.error('logs.stream.failed', { host: host.id, container: req.params.id, error: err.message });
    res.write(`data: [opendockwatch] failed to stream logs: ${err.message}\n\n`);
    cleanup('error');
  });
  // Both wrapped rather than passed directly: 'close' hands its listener an exit code, which would
  // otherwise land in cleanup's closedBy.
  child.on('close', () => cleanup('child'));
  req.on('close', () => cleanup('client'));
});

router.get('/hosts/:hostId/containers/:id/logs/download', requireHost, requireContainerId, (req, res) => {
  const host = req.odwHost;

  const tail = tailParam(req.query.tail, 5000);
  // Container logs routinely carry secrets and customer data, so who exported them and when is
  // audit material, not just diagnostics - the same reason container.start/stop is logged.
  logger.info('logs.download', { host: host.id, container: req.params.id, tail, user: req.session.username });
  const child = downloadLogs(host, req.params.id, { tail });

  const safeName = (s) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safeName(req.params.hostId)}-${safeName(req.params.id)}-logs.txt"`,
  });

  // Two independent stdio streams feeding one response - don't let either one's
  // end() race the other; end the response once, when the process itself closes.
  child.stdout.pipe(res, { end: false });
  child.stderr.pipe(res, { end: false });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    res.end();
  };
  child.on('close', finish);
  child.on('error', (err) => {
    if (!res.headersSent) res.status(502);
    res.write(`[opendockwatch] failed to fetch logs: ${err.message}\n`);
    finish();
  });

  req.on('close', () => child.kill());
});

module.exports = { router, getOpenLogStreams: () => openLogStreams };
