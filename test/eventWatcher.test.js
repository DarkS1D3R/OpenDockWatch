const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// server/eventWatcher requires server/db, which opens a database the moment it's required - so
// this has to be set before the require below, or the tests here run against the real
// data/opendockwatch.db a container may hold open in WAL mode (see test/index.test.js).
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-eventwatcher-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const eventWatcher = require('../server/eventWatcher');
const { parseEventLine, ingestEvent, broadcaster } = eventWatcher;
const db = require('../server/db');
const docker = require('../server/docker');
const alerts = require('../server/alerts');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  }
});

const host = { id: 'local' };

test('parseEventLine', async (t) => {
  await t.test('parses a container start event', () => {
    const raw = {
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'abcdef0123456789', Attributes: { name: 'web' } },
      time: 1700000000,
    };
    assert.deepEqual(parseEventLine(JSON.stringify(raw), host), {
      hostId: 'local',
      containerId: 'abcdef012345',
      containerName: 'web',
      composeProject: null,
      action: 'start',
      ts: 1700000000 * 1000,
      raw,
    });
  });

  await t.test('extracts composeProject from Actor.Attributes', () => {
    const raw = {
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'abcdef0123456789', Attributes: { name: 'web', 'com.docker.compose.project': 'billing' } },
      time: 1700000000,
    };
    assert.equal(parseEventLine(JSON.stringify(raw), host).composeProject, 'billing');
  });

  await t.test('ignores non-container events', () => {
    const raw = { Type: 'network', Action: 'connect' };
    assert.equal(parseEventLine(JSON.stringify(raw), host), null);
  });

  await t.test('filters out exec_* actions (healthcheck noise)', () => {
    const raw = { Type: 'container', Action: 'exec_create', Actor: { ID: 'a', Attributes: {} } };
    assert.equal(parseEventLine(JSON.stringify(raw), host), null);
  });

  await t.test('does not filter health_status actions', () => {
    const raw = { Type: 'container', Action: 'health_status: unhealthy', Actor: { ID: 'a', Attributes: {} } };
    assert.ok(parseEventLine(JSON.stringify(raw), host));
  });

  await t.test('returns null for invalid JSON', () => {
    assert.equal(parseEventLine('not json', host), null);
  });

  await t.test('falls back to Date.now() when the event has no time field', () => {
    const before = Date.now();
    const raw = { Type: 'container', Action: 'start', Actor: { ID: 'a', Attributes: {} } };
    const result = parseEventLine(JSON.stringify(raw), host);
    assert.ok(result.ts >= before);
  });
});

// ingestEvent runs inside the `docker events` stdout 'data' handler. A throw from an EventEmitter
// listener is an uncaughtException, and index.js's handler for those calls process.exit(1) - so a
// single failing sqlite write would end monitoring for every host, not just the one that failed.
test('ingestEvent', async (t) => {
  const fakeRes = () => {
    const written = [];
    return {
      written,
      set() {},
      flushHeaders() {},
      write(s) {
        written.push(s);
      },
    };
  };
  const event = (overrides = {}) => ({
    hostId: 'local',
    containerId: 'abcdef012345',
    containerName: 'web',
    action: 'stop',
    ts: 1700000000000,
    raw: { Type: 'container', Action: 'stop' },
    ...overrides,
  });
  const countFor = (containerId) => db.client.prepare('SELECT COUNT(*) AS n FROM events WHERE container_id = ?').get(containerId).n;

  await t.test('persists the event and pushes it to live subscribers', () => {
    const res = fakeRes();
    const unsubscribe = broadcaster.subscribe(res, 'local');
    try {
      ingestEvent(event({ containerId: 'happy-path' }));
    } finally {
      unsubscribe();
    }
    assert.equal(countFor('happy-path'), 1);
    assert.equal(res.written.length, 1, 'subscriber received no SSE frame');
    assert.match(res.written[0], /"action":"stop"/);
  });

  await t.test('swallows a failing db write instead of letting it reach the stream handler', (t2) => {
    t2.mock.method(db, 'insertEvent', () => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    assert.doesNotThrow(() => ingestEvent(event({ containerId: 'db-fails' })));
  });

  await t.test('swallows a failing alert rule too', (t2) => {
    t2.mock.method(alerts, 'handleEvent', () => {
      throw new Error('rule engine blew up');
    });
    assert.doesNotThrow(() => ingestEvent(event({ containerId: 'alert-fails' })));
    // The db write happens before the rule engine runs, so the event is still recorded.
    assert.equal(countFor('alert-fails'), 1);
  });

  // The guard is per event, so a bad one must not cost the rest of the chunk it arrived in.
  await t.test('a failed event does not stop the next one being ingested', (t2) => {
    const insert = t2.mock.method(db, 'insertEvent');
    insert.mock.mockImplementationOnce(() => {
      throw new Error('transient');
    });
    assert.doesNotThrow(() => ingestEvent(event({ containerId: 'first-fails' })));
    assert.doesNotThrow(() => ingestEvent(event({ containerId: 'second-ok' })));
    insert.mock.restore();
    assert.equal(countFor('first-fails'), 0);
    assert.equal(countFor('second-ok'), 1);
  });
});

// A stand-in for the `docker events` child: the watcher only reads stdout/stderr, listens for
// spawn/close/error and calls kill(), so this covers its whole contract without a daemon. Same
// shape as test/statsWatcher.test.js's, since both watchers share the restart machinery.
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

function withFakeStream(t, hostId) {
  const children = [];
  t.mock.method(docker, 'streamEvents', () => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  eventWatcher.addHost({ id: hostId });
  t.after(() => eventWatcher.removeHost(hostId));
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

// Losing this stream loses every event-driven alert for that host - container_crashed, crash_loop
// and unhealthy all ingest through it - and the watchdog cannot notice, since it measures the poll
// loop and an eventless host still polls normally. So the restart path is worth asserting directly.
test('stream lifecycle', async (t) => {
  await t.test('restarts after a backoff and reads the replacement stream', async (t2) => {
    const s = withFakeStream(t2, 'ew-restart');
    endChild(s.child());
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(s.children.length, 2, 'no replacement stream was spawned');
    const raw = { Type: 'container', Action: 'start', Actor: { ID: 'ew-restart01', Attributes: { name: 'web' } }, time: 1700000000 };
    s.child().stdout.emit('data', Buffer.from(JSON.stringify(raw) + '\n'));
    const n = db.client.prepare('SELECT COUNT(*) AS n FROM events WHERE container_id = ?').get('ew-restart01').n;
    assert.equal(n, 1, 'the replacement stream is not being ingested');
  });

  // The regression this exists for: the restart used to hang off 'exit', which Node does not emit
  // when the child never spawned - so a docker binary briefly unspawnable (EAGAIN under process
  // pressure) left that host with no event stream, and no alerts, for the life of the process.
  await t.test('a stream that never spawned is still restarted', async (t2) => {
    const s = withFakeStream(t2, 'ew-nospawn');
    endChild(s.child(), { spawned: false });
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(s.children.length, 2, 'a failed spawn got no replacement stream');
  });

  await t.test('a failed spawn backs off rather than respawning in a tight loop', async (t2) => {
    const s = withFakeStream(t2, 'ew-backoff');
    endChild(s.child(), { spawned: false });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(s.children.length, 1, 'respawned before the backoff elapsed');
  });

  // An edit through Settings is a removeHost + addHost pair, so a backoff elapsing after the remove
  // must not revive the old stream - that leaves two `docker events` children for one host, every
  // event inserted, published and alerted on twice, with the orphan out of removeHost's reach.
  await t.test('a pending restart does not revive after the host is removed', async (t2) => {
    const s = withFakeStream(t2, 'ew-removed');
    endChild(s.child());
    eventWatcher.removeHost('ew-removed');
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(s.children.length, 1, 'a removed host got a replacement stream anyway');
  });

  await t.test('removeHost kills the child', (t2) => {
    const s = withFakeStream(t2, 'ew-kill');
    eventWatcher.removeHost('ew-kill');
    assert.equal(s.child().killed, true);
  });

  await t.test('adding a host twice does not spawn a second stream', (t2) => {
    const s = withFakeStream(t2, 'ew-dup');
    eventWatcher.addHost({ id: 'ew-dup' });
    assert.equal(s.children.length, 1);
  });

  // A spawn failure emits 'error'; with no listener that is an unhandled event and the process dies.
  await t.test('a spawn error does not take the process down', (t2) => {
    const s = withFakeStream(t2, 'ew-error');
    assert.doesNotThrow(() => s.child().emit('error', new Error('docker: not found')));
  });
});
