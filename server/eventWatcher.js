const { loadHosts } = require('./hosts');
// The module object rather than a destructured streamEvents: this spawns a long-lived child, so
// test/eventWatcher.test.js swaps it for a fake to drive the restart paths without a daemon. Same
// reason statsWatcher and metricsCollector reach docker.js that way.
const docker = require('./docker');
const db = require('./db');
const alerts = require('./alerts');
const logger = require('./logger');
const { Broadcaster } = require('./sse');
const { createRestartingWatcher } = require('./restartingWatcher');

const broadcaster = new Broadcaster();

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

// The restart/backoff/teardown machinery below is shared with statsWatcher.js via
// restartingWatcher.js - see the comment there. Only what's specific to a `docker events` stream
// lives here: spawning it and parsing its stdout into ingestEvent calls.
const watcher = createRestartingWatcher({
  logPrefix: 'events',
  spawnChild: (host) => docker.streamEvents(host),
  wireChild: (state, child, host) => {
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
  },
});

function start() {
  for (const host of loadHosts()) {
    watcher.startWatcher(host);
  }
}

// Used by the settings/hosts routes so a host added (or edited, via removeHost+addHost) through
// the GUI starts streaming events right away instead of needing a process restart.
function addHost(host) {
  watcher.addHost(host);
}

function removeHost(hostId) {
  watcher.removeHost(hostId);
}

function stop() {
  watcher.stop();
}

module.exports = { start, stop, addHost, removeHost, broadcaster, parseEventLine, ingestEvent, takeIngestCount };
