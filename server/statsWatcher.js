// The module object rather than a destructured streamStats: this one spawns a long-lived child,
// so test/statsWatcher.test.js swaps it for a fake to exercise the buffering, staleness and
// restart paths without a docker daemon. Same reason eventWatcher's tests reach db that way.
const docker = require('./docker');
const { statsRowToSample } = require('./docker');
const logger = require('./logger');
const { createRestartingWatcher } = require('./restartingWatcher');

// How long a live stream may go without printing a row before its samples stop being trusted.
// `docker stats` reprints every running container roughly twice a second, so silence this long
// means the stream is up but no longer reporting - frozen CPU numbers are worse than slow ones,
// so the collector falls back to the one-shot call rather than serving them.
const STALE_SAMPLES_MS = 30_000;

// docker draws the stats table with cursor-control escapes even when its output is a pipe (each
// refresh is `ESC[J ESC[H <rows> ESC[H <rows> ESC[K`, verified byte-for-byte against docker 29),
// so a row arrives with them glued to the front of the JSON. Stripped rather than parsed: the
// escapes only describe a redraw, and nothing here needs to know where one redraw ends. Wider
// than format.js's ANSI_STRIP_RE, which only matches colour (`m`) sequences: these are cursor
// control (`H`/`J`/`K`), and that module is a browser ES module this one couldn't require anyway.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// Pure and exported so the parsing is unit-testable without spawning docker, the same split
// eventWatcher.parseEventLine and docker.js's own parsers use. Returns null for anything that
// isn't a usable row - blank redraw padding, a truncated line, output from a future CLI whose
// shape changed - so the caller can skip it without a try/catch of its own.
function parseStatsLine(line) {
  const cleaned = (line || '').replace(ANSI_CSI_RE, '').trim();
  if (!cleaned) return null;
  let raw;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!raw || typeof raw.Container !== 'string' || !raw.Container) return null;
  return { id: raw.Container.slice(0, 12), sample: statsRowToSample(raw) };
}

// Runs inside the child's stdout 'data' handler, so it must never throw: an exception out of an
// EventEmitter listener is an uncaughtException and index.js exits on those, which would end
// monitoring for every host over one malformed stats row. Same contract as ingestEvent.
function ingestChunk(state, hostId, text) {
  state.buffer += text;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop();
  for (const line of lines) {
    let row;
    try {
      row = parseStatsLine(line);
    } catch (err) {
      logger.error('stats.parse.failed', { host: hostId, error: err.message });
      continue;
    }
    if (!row) continue;
    state.samples.set(row.id, row.sample);
    state.lastRowAt = Date.now();
    if (state.stale) {
      state.stale = false;
      logger.info('stats.stream.resumed', { host: hostId });
    }
  }
}

// The restart/backoff/teardown machinery below is shared with eventWatcher.js via
// restartingWatcher.js - see the comment there. Only what's specific to a `docker stats` stream
// lives here: spawning it, buffering/parsing its stdout into samples, and dropping those samples
// right before a restart (see beforeRestart below - the numbers stop advancing the moment the
// stream dies, and a dashboard confidently showing a stale 40% CPU is worse than one paying for
// the slow one-shot call again; emptying the map is what makes getSamples return null for that).
const watcher = createRestartingWatcher({
  logPrefix: 'stats',
  spawnChild: (host) => docker.streamStats(host),
  initState: () => ({ samples: new Map() }),
  beforeRestart: (state) => state.samples.clear(),
  wireChild: (state, child, host) => {
    state.buffer = '';
    child.stdout.on('data', (chunk) => ingestChunk(state, host.id, chunk.toString('utf8')));
    child.stderr.on('data', () => {
      /* CLI warnings (host briefly unreachable, a container gone mid-refresh) - reachability is metricsCollector's job */
    });
  },
});

// null means "no usable stream data, use the one-shot call" - no samples yet (a host whose stream
// has just started, or one with nothing running), or a stream that has gone quiet. Never an empty
// object, which the caller couldn't tell apart from a genuinely idle host.
function getSamples(hostId, now = Date.now()) {
  const state = watcher.watchers.get(hostId);
  if (!state || !state.samples.size) return null;
  if (now - state.lastRowAt > STALE_SAMPLES_MS) {
    if (!state.stale) {
      state.stale = true;
      logger.warn('stats.stream.stale', { host: hostId, quietSec: Math.round((now - state.lastRowAt) / 1000) });
    }
    return null;
  }
  // A fresh object, and a copy of every sample: metricsCollector mutates what it gets here
  // (Object.assign(s, computeIoRates(...))) and diffs it against the object it kept from the
  // previous poll. Handing out the live map would make those two the same object - every
  // cumulative counter identical to itself, and every I/O rate silently zero.
  const out = {};
  for (const [id, sample] of state.samples) out[id] = { ...sample };
  return out;
}

// `docker stats` only ever reports running containers, so the collector - which already has the
// authoritative list from `docker ps` every poll - prunes the rest. Without it a host that cycles
// through containers accumulates a sample for every id it has ever seen.
function retainContainers(hostId, runningIds) {
  const state = watcher.watchers.get(hostId);
  if (!state) return;
  const keep = new Set(runningIds);
  for (const id of state.samples.keys()) {
    if (!keep.has(id)) state.samples.delete(id);
  }
}

// For index.js's vitals line: how many hosts are actually being served from a live stream. If
// this sits below the host count, some host is paying for the one-shot call on every poll and
// the stream is failing somewhere - which the restart lines say, but only as they happen.
function liveCount(now = Date.now()) {
  let n = 0;
  for (const state of watcher.watchers.values()) {
    if (state.samples.size && now - state.lastRowAt <= STALE_SAMPLES_MS) n += 1;
  }
  return n;
}

function addHost(host) {
  watcher.addHost(host);
}

function removeHost(hostId) {
  watcher.removeHost(hostId);
}

function stop() {
  watcher.stop();
}

module.exports = { addHost, removeHost, stop, getSamples, retainContainers, liveCount, parseStatsLine, STALE_SAMPLES_MS };
