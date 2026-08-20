const { loadHosts } = require('./hosts');
// The module object rather than a destructured streamEvents: this spawns a long-lived child, so
// test/eventWatcher.test.js swaps it for a fake to drive the restart paths without a daemon. Same
// reason statsWatcher and metricsCollector reach docker.js that way.
const docker = require('./docker');
const db = require('./db');
const alerts = require('./alerts');
const logger = require('./logger');
const { Broadcaster } = require('./sse');

const broadcaster = new Broadcaster();

const RESTART_BASE_DELAY_MS = 2000;
const RESTART_MAX_DELAY_MS = 30000;
// How long a stream has to stay up before we consider it "healthy" and reset the backoff -
// spawning succeeds even for a doomed connection (e.g. SSH auth failure kills it right after),
// so resetting on 'spawn' never actually backs off for a permanently unreachable host.
const HEALTHY_AFTER_MS = 30000;

const watchers = new Map(); // hostId -> { child, stopped, restartDelay }

function parseEventLine(line, host) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw.Type !== 'container') return null;
  // exec_create/exec_start/exec_die fire on every healthcheck probe (often every few seconds),
  // which would flood the event log with noise unrelated to container lifecycle.
  if (raw.Action && raw.Action.startsWith('exec_')) return null;
  const attrs = (raw.Actor && raw.Actor.Attributes) || {};
  const id = raw.Actor && raw.Actor.ID ? raw.Actor.ID : raw.id;
  return {
    hostId: host.id,
    containerId: id ? id.slice(0, 12) : null,
    containerName: attrs.name || null,
    // docker events' Actor.Attributes carries the full label set (same source docker.js's
    // listContainers reads composeProject from) alongside name/exitCode/signal - free, no extra call.
    composeProject: attrs['com.docker.compose.project'] || null,
    action: raw.Action,
    ts: raw.time ? raw.time * 1000 : Date.now(),
    raw,
  };
}

// Every ingested event is a synchronous sqlite write on the same event loop everything else runs
// on, so a container in a tight restart loop is a real source of lag with no signal of its own.
// Counted rather than logged per event - logging the flood would *be* the flood. Read (and reset)
// by index.js's vitals line, so the rate is visible as a rate.
let ingested = 0;

function takeIngestCount() {
  const out = ingested;
  ingested = 0;
  return out;
}

// One event line's fan-out: persistence, live SSE push, rule engine. Deliberately never throws -
// it runs inside a stdout 'data' handler, so anything escaping becomes an uncaughtException and
// index.js exits on those, losing monitoring for every host over one failed sqlite write.
function ingestEvent(event) {
  ingested += 1;
  try {
    db.insertEvent({
      hostId: event.hostId,
      containerId: event.containerId,
      containerName: event.containerName,
      action: event.action,
      ts: event.ts,
      rawJson: JSON.stringify(event.raw),
    });
    broadcaster.publish(event.hostId, event);
    alerts.handleEvent(event);
  } catch (err) {
    logger.error('events.handle.failed', { host: event.hostId, action: event.action, error: err.message });
  }
}

function startWatcher(host) {
  const child = docker.streamEvents(host);
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseEventLine(trimmed, host);
      if (event) ingestEvent(event);
    }
  });

  child.stderr.on('data', () => {
    /* docker CLI warnings (e.g. host briefly unreachable) - reachability is tracked separately by metricsCollector */
  });

  // Without this handler, a spawn failure (docker not on PATH, bad SSH host, etc.) emits an
  // unhandled 'error' that crashes the whole process - taking down monitoring for every host.
  child.on('error', (err) => {
    logger.error('events.stream.failed', { host: host.id, error: err.message });
  });

  const state = watchers.get(host.id) || { restartDelay: RESTART_BASE_DELAY_MS };
  state.child = child;
  watchers.set(host.id, state);

  child.on('spawn', () => {
    if (watchers.get(host.id) !== state) return;
    logger.info('events.stream.started', { host: host.id, dockerHost: host.dockerHost || 'local' });
    state.healthyTimer = setTimeout(() => {
      state.restartDelay = RESTART_BASE_DELAY_MS;
    }, HEALTHY_AFTER_MS);
  });

  // 'close', not 'exit': a child that never spawned at all (docker off PATH, EAGAIN under process
  // pressure) emits 'error' then 'close' and *never* 'exit', so hanging the restart off 'exit' left
  // that host with no event stream for the life of the process. 'close' covers both. See server/CLAUDE.md.
  child.on('close', () => {
    // Identity check, not a lookup by id: an edit through Settings is a removeHost + addHost
    // pair, so a dead stream's backoff could revive against a *new* state object under the same
    // id, leaving two `docker events` streams running for one host. See server/CLAUDE.md.
    if (watchers.get(host.id) !== state || state.stopped) return;
    if (state.healthyTimer) clearTimeout(state.healthyTimer);
    const delay = Math.min(state.restartDelay, RESTART_MAX_DELAY_MS);
    // A host whose stream keeps dying and backing off is otherwise entirely silent - the exit
    // isn't an error, so nothing logged it, and the growing delay was invisible.
    logger.warn('events.stream.restarting', { host: host.id, delayMs: delay });
    state.restartTimer = setTimeout(() => {
      if (watchers.get(host.id) !== state || state.stopped) return;
      startWatcher(host);
    }, delay);
    state.restartDelay = Math.min(delay * 2, RESTART_MAX_DELAY_MS);
  });
}

function start() {
  for (const host of loadHosts()) {
    startWatcher(host);
  }
}

// Used by the settings/hosts routes so a host added (or edited, via removeHost+addHost) through
// the GUI starts streaming events right away instead of needing a process restart.
function addHost(host) {
  if (watchers.has(host.id)) return;
  startWatcher(host);
}

function teardown(state) {
  state.stopped = true;
  if (state.healthyTimer) clearTimeout(state.healthyTimer);
  if (state.restartTimer) clearTimeout(state.restartTimer);
  if (state.child) state.child.kill();
}

function removeHost(hostId) {
  const state = watchers.get(hostId);
  if (!state) return;
  teardown(state);
  watchers.delete(hostId);
  logger.info('events.stream.stopped', { host: hostId });
}

function stop() {
  for (const state of watchers.values()) teardown(state);
  watchers.clear();
}

module.exports = { start, stop, addHost, removeHost, broadcaster, parseEventLine, ingestEvent, takeIngestCount };
