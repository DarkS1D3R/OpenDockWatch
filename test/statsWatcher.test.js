const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const statsWatcher = require('../server/statsWatcher');
const { parseStatsLine } = statsWatcher;
const docker = require('../server/docker');
const { statsRowToSample } = docker;

// The exact bytes `docker stats --format '{{json .}}'` writes to a pipe, captured from docker 29
// on a two-container daemon. It draws the table with cursor control even when nothing is a
// terminal, so every parser assertion below is really about surviving that.
const ESC = '\x1b';
const ROW = {
  BlockIO: '290MB / 0B',
  CPUPerc: '1.47%',
  Container: 'c70c7850918ec7c6cfaee5963bef6180555453631ae28582986bc08f554d3ad3',
  ID: 'c70c7850918e',
  MemPerc: '3.21%',
  MemUsage: '512MiB / 15.6GiB',
  Name: 'web',
  NetIO: '1.2MB / 3.4MB',
  PIDs: '12',
};

test('parseStatsLine', async (t) => {
  await t.test('parses a plain row into the same sample shape as the one-shot getStats', () => {
    const row = parseStatsLine(JSON.stringify(ROW));
    assert.equal(row.id, 'c70c7850918e');
    assert.deepEqual(row.sample, statsRowToSample(ROW));
  });

  // The whole reason this parser exists rather than reusing getStats': a streamed row arrives with
  // a cursor-home escape glued to the front of the JSON, which JSON.parse rejects outright.
  await t.test('strips the leading cursor-home escape docker emits at the start of a redraw', () => {
    const row = parseStatsLine(`${ESC}[H${JSON.stringify(ROW)}`);
    assert.equal(row.id, 'c70c7850918e');
    assert.deepEqual(row.sample, statsRowToSample(ROW));
  });

  await t.test('strips the erase-display escape that opens each refresh', () => {
    const row = parseStatsLine(`${ESC}[J${ESC}[H${JSON.stringify(ROW)}`);
    assert.deepEqual(row.sample, statsRowToSample(ROW));
  });

  // The escape strip must not touch the payload: a container named `[0m` or a log-ish env value
  // in a field would otherwise be silently rewritten on its way through.
  await t.test('leaves bracket sequences inside the JSON alone', () => {
    const row = parseStatsLine(JSON.stringify({ ...ROW, Name: 'web[0m]-1' }));
    assert.deepEqual(row.sample, statsRowToSample({ ...ROW, Name: 'web[0m]-1' }));
    assert.equal(row.id, 'c70c7850918e');
  });

  await t.test('returns null for the padding line that closes each refresh', () => {
    assert.equal(parseStatsLine(` ${ESC}[K`), null);
  });

  await t.test('returns null for blank input', () => {
    assert.equal(parseStatsLine(''), null);
    assert.equal(parseStatsLine(null), null);
    assert.equal(parseStatsLine('   '), null);
  });

  // A chunk boundary can split a row mid-JSON; the caller line-buffers, but a truncated line must
  // never reach JSON.parse unguarded - this runs inside a stdout handler where a throw exits the process.
  await t.test('returns null for a truncated row instead of throwing', () => {
    assert.equal(parseStatsLine('{"BlockIO":"290MB / 0B","CPUPe'), null);
  });

  await t.test('returns null for JSON that is not a stats row', () => {
    assert.equal(parseStatsLine('{"something":"else"}'), null);
    assert.equal(parseStatsLine('"a bare string"'), null);
    assert.equal(parseStatsLine('null'), null);
  });

  // getStats keys on Container.slice(0, 12) and every consumer indexes by that short id, so a
  // stream keyed on anything else would produce samples nothing ever looks up.
  await t.test('keys on the short container id, matching every other stats consumer', () => {
    assert.equal(parseStatsLine(JSON.stringify(ROW)).id, ROW.Container.slice(0, 12));
  });

  await t.test('parses the cumulative I/O counters the rate maths depends on', () => {
    const { sample } = parseStatsLine(JSON.stringify(ROW));
    assert.equal(sample.netRxBytes, 1.2e6);
    assert.equal(sample.netTxBytes, 3.4e6);
    assert.equal(sample.blockReadBytes, 290e6);
    assert.equal(sample.blockWriteBytes, 0);
  });
});

// A stand-in for the `docker stats` child: the watcher only ever reads stdout/stderr, listens for
// spawn/close/error, and calls kill(), so this covers its whole contract without a daemon.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function withFakeStream(t, hostId = 'h1') {
  const children = [];
  t.mock.method(docker, 'streamStats', () => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  statsWatcher.addHost({ id: hostId });
  t.after(() => statsWatcher.removeHost(hostId));
  return { children, child: () => children[children.length - 1] };
}

// Children are always ended the way Node actually ends them, because the difference is the whole
// point of the restart handler listening on 'close': a child that ran emits 'exit' then 'close',
// one that never spawned emits 'error' then 'close' and *no* 'exit' at all. Verified on Node 22.
function endChild(child, { spawned = true } = {}) {
  if (spawned) child.emit('exit', 0, null);
  else child.emit('error', new Error('spawn docker EAGAIN'));
  child.emit('close', spawned ? 0 : null, null);
}

const rowLine = (overrides = {}) => JSON.stringify({ ...ROW, ...overrides }) + '\n';
const OTHER = 'f069bf3a7bb11e720afab2dc0822891b7fcf06e47ee36f98627439f8732e24e7';

test('sample collection', async (t) => {
  await t.test('collects streamed rows and serves them keyed by short id', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine() + rowLine({ Container: OTHER, CPUPerc: '0.49%' })));
    const samples = statsWatcher.getSamples('h1');
    assert.deepEqual(Object.keys(samples).sort(), ['c70c7850918e', 'f069bf3a7bb1']);
    assert.equal(samples.c70c7850918e.cpuPerc, '1.47%');
  });

  // Each refresh reprints every container, so the newest row for an id has to win rather than
  // accumulate - otherwise the dashboard would show whatever the stream happened to say first.
  await t.test('a later row for the same container replaces the earlier one', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine({ CPUPerc: '1.47%' })));
    s.child().stdout.emit('data', Buffer.from(rowLine({ CPUPerc: '9.90%' })));
    assert.equal(statsWatcher.getSamples('h1').c70c7850918e.cpuPerc, '9.90%');
  });

  // A chunk boundary lands mid-row routinely at 500ms refreshes with many containers.
  await t.test('reassembles a row split across two chunks', (t2) => {
    const s = withFakeStream(t2);
    const line = rowLine();
    s.child().stdout.emit('data', Buffer.from(line.slice(0, 40)));
    assert.equal(statsWatcher.getSamples('h1'), null, 'a half-arrived row must not be served');
    s.child().stdout.emit('data', Buffer.from(line.slice(40)));
    assert.equal(statsWatcher.getSamples('h1').c70c7850918e.cpuPerc, '1.47%');
  });

  await t.test('returns null before any row has arrived', (t2) => {
    withFakeStream(t2);
    assert.equal(statsWatcher.getSamples('h1'), null);
  });

  await t.test('returns null for a host with no stream at all', () => {
    assert.equal(statsWatcher.getSamples('never-added'), null);
  });

  // metricsCollector mutates the samples it is handed (Object.assign(s, computeIoRates(...))) and
  // diffs each poll's object against the previous poll's. If getSamples aliased the live map those
  // two would be the same object: every counter equal to itself, every I/O rate silently zero.
  await t.test('hands out a copy, not the live map', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    const first = statsWatcher.getSamples('h1');
    first.c70c7850918e.netRxRate = 12345;
    first.c70c7850918e.cpuPerc = 'clobbered';
    const second = statsWatcher.getSamples('h1');
    assert.equal(second.c70c7850918e.netRxRate, undefined);
    assert.equal(second.c70c7850918e.cpuPerc, '1.47%');
    assert.notEqual(first, second);
    assert.notEqual(first.c70c7850918e, second.c70c7850918e);
  });
});

test('retainContainers', async (t) => {
  await t.test('drops samples for containers no longer running', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine() + rowLine({ Container: OTHER })));
    statsWatcher.retainContainers('h1', ['c70c7850918e']);
    assert.deepEqual(Object.keys(statsWatcher.getSamples('h1')), ['c70c7850918e']);
  });

  await t.test('retaining nothing leaves no samples to serve', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    statsWatcher.retainContainers('h1', []);
    assert.equal(statsWatcher.getSamples('h1'), null);
  });

  await t.test('is a no-op for an unknown host', () => {
    assert.doesNotThrow(() => statsWatcher.retainContainers('never-added', ['x']));
  });
});

// A stream that is up but no longer printing would otherwise freeze the dashboard on whatever it
// last said. Falling back to the slow one-shot call is the right answer; serving stale CPU is not.
test('staleness', async (t) => {
  await t.test('stops serving samples once the stream has gone quiet', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    const now = Date.now();
    assert.ok(statsWatcher.getSamples('h1', now + statsWatcher.STALE_SAMPLES_MS));
    assert.equal(statsWatcher.getSamples('h1', now + statsWatcher.STALE_SAMPLES_MS + 1000), null);
  });

  await t.test('a fresh row brings it back', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    assert.equal(statsWatcher.getSamples('h1', Date.now() + statsWatcher.STALE_SAMPLES_MS + 1000), null);
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    assert.ok(statsWatcher.getSamples('h1'));
  });

  await t.test('liveCount only counts hosts actually being served from a stream', (t2) => {
    const s = withFakeStream(t2);
    assert.equal(statsWatcher.liveCount(), 0, 'no rows yet');
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    assert.equal(statsWatcher.liveCount(), 1);
    assert.equal(statsWatcher.liveCount(Date.now() + statsWatcher.STALE_SAMPLES_MS + 1000), 0);
  });
});

test('stream lifecycle', async (t) => {
  // The values stop advancing the moment the process dies, so they have to go with it - otherwise
  // the collector keeps serving a frozen snapshot instead of falling back to the one-shot call.
  await t.test('drops every sample when the stream exits', (t2) => {
    const s = withFakeStream(t2);
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    assert.ok(statsWatcher.getSamples('h1'));
    endChild(s.child());
    assert.equal(statsWatcher.getSamples('h1'), null);
  });

  await t.test('restarts after a backoff and serves rows from the new stream', async (t2) => {
    const s = withFakeStream(t2);
    endChild(s.child());
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(s.children.length, 2, 'no replacement stream was spawned');
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    assert.ok(statsWatcher.getSamples('h1'));
  });

  // An edit through Settings is a removeHost + addHost pair, so a backoff elapsing after the
  // remove must not revive the old stream against the new entry - that leaves two `docker stats`
  // children for one host, one of them orphaned where no removeHost can reach it.
  await t.test('a pending restart does not revive after the host is removed', async (t2) => {
    const s = withFakeStream(t2, 'h2');
    endChild(s.child());
    statsWatcher.removeHost('h2');
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(s.children.length, 1, 'a removed host got a replacement stream anyway');
  });

  await t.test('removeHost kills the child and forgets the host', (t2) => {
    const s = withFakeStream(t2, 'h3');
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    statsWatcher.removeHost('h3');
    assert.equal(s.child().killed, true);
    assert.equal(statsWatcher.getSamples('h3'), null);
  });

  await t.test('adding a host twice does not spawn a second stream', (t2) => {
    const s = withFakeStream(t2, 'h4');
    statsWatcher.addHost({ id: 'h4' });
    assert.equal(s.children.length, 1);
  });

  // The handler runs inside a stdout 'data' listener: a throw there is an uncaughtException, and
  // index.js exits on those - one malformed row would end monitoring for every host.
  await t.test('a malformed row cannot escape the stdout handler', (t2) => {
    const s = withFakeStream(t2);
    assert.doesNotThrow(() => s.child().stdout.emit('data', Buffer.from('not json\n{"nope":1}\n' + rowLine())));
    assert.ok(statsWatcher.getSamples('h1'), 'the good row in the same chunk was still ingested');
  });

  // A spawn failure emits 'error'; with no listener that is an unhandled event and the process dies.
  await t.test('a spawn error does not take the process down', (t2) => {
    const s = withFakeStream(t2, 'h5');
    assert.doesNotThrow(() => s.child().emit('error', new Error('docker: not found')));
  });

  // The regression this pair exists for: the restart used to hang off 'exit', which Node does not
  // emit when the child never spawned - so an EAGAIN under process pressure left the host with no
  // stats stream for the life of the process, silently paying for the one-shot call on every poll.
  await t.test('a stream that never spawned is still restarted', async (t2) => {
    const s = withFakeStream(t2, 'h6');
    endChild(s.child(), { spawned: false });
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(s.children.length, 2, 'a failed spawn got no replacement stream');
    s.child().stdout.emit('data', Buffer.from(rowLine()));
    assert.ok(statsWatcher.getSamples('h6'), 'the replacement stream is not being read');
  });

  await t.test('a failed spawn backs off rather than respawning in a tight loop', async (t2) => {
    const s = withFakeStream(t2, 'h7');
    endChild(s.child(), { spawned: false });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(s.children.length, 1, 'respawned before the backoff elapsed');
  });
});
