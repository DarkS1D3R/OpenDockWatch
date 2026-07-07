const { loadHosts } = require('./hosts');
const { streamEvents } = require('./docker');
const db = require('./db');
const alerts = require('./alerts');
const { Broadcaster } = require('./sse');

const broadcaster = new Broadcaster();

const RESTART_BASE_DELAY_MS = 2000;
const RESTART_MAX_DELAY_MS = 30000;

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
    action: raw.Action,
    ts: raw.time ? raw.time * 1000 : Date.now(),
    raw,
  };
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
      if (!event) continue;
      db.insertEvent({
        hostId: event.hostId,
        containerId: event.containerId,
        containerName: event.containerName,
        action: event.action,
        ts: event.ts,
        rawJson: JSON.stringify(event.raw),
      });
      broadcaster.publish(host.id, event);
      alerts.handleEvent(event);
    }
  });

  child.stderr.on('data', () => {
    /* docker CLI warnings (e.g. host briefly unreachable) - reachability is tracked separately by metricsCollector */
  });

  // Without this handler, a spawn failure (docker not on PATH, bad SSH host, etc.) emits an
  // unhandled 'error' that crashes the whole process - taking down monitoring for every host.
  child.on('error', (err) => {
    console.error(`[opendockwatch] events stream error for host ${host.id}: ${err.message}`);
  });

  const state = watchers.get(host.id) || { restartDelay: RESTART_BASE_DELAY_MS };
  state.child = child;
  watchers.set(host.id, state);

  child.on('spawn', () => {
    const s = watchers.get(host.id);
    if (s) s.restartDelay = RESTART_BASE_DELAY_MS;
  });

  child.on('exit', () => {
    const s = watchers.get(host.id);
    if (!s || s.stopped) return;
    const delay = Math.min(s.restartDelay, RESTART_MAX_DELAY_MS);
    setTimeout(() => {
      const current = watchers.get(host.id);
      if (current && !current.stopped) startWatcher(host);
    }, delay);
    s.restartDelay = Math.min(delay * 2, RESTART_MAX_DELAY_MS);
  });
}

function start() {
  for (const host of loadHosts()) {
    startWatcher(host);
  }
}

function stop() {
  for (const state of watchers.values()) {
    state.stopped = true;
    if (state.child) state.child.kill();
  }
}

module.exports = { start, stop, broadcaster, parseEventLine };
