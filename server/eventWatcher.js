const { loadHosts } = require('./hosts');
const { streamEvents } = require('./docker');
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

// One event line's fan-out: persistence, live SSE push, rule engine. Deliberately never throws -
// it runs inside a stdout 'data' handler, so anything escaping becomes an uncaughtException and
// index.js exits on those, losing monitoring for every host over one failed sqlite write.
function ingestEvent(event) {
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
  const child = streamEvents(host);
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
    state.healthyTimer = setTimeout(() => {
      state.restartDelay = RESTART_BASE_DELAY_MS;
    }, HEALTHY_AFTER_MS);
  });

  child.on('exit', () => {
    // Identity check, not a lookup by id: an edit through Settings is a removeHost + addHost
    // pair, so a dead stream's backoff could revive against a *new* state object under the same
    // id, leaving two `docker events` streams running for one host. See CLAUDE.md.
    if (watchers.get(host.id) !== state || state.stopped) return;
    if (state.healthyTimer) clearTimeout(state.healthyTimer);
    const delay = Math.min(state.restartDelay, RESTART_MAX_DELAY_MS);
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
}

function stop() {
  for (const state of watchers.values()) teardown(state);
  watchers.clear();
}

module.exports = { start, stop, addHost, removeHost, broadcaster, parseEventLine, ingestEvent };
