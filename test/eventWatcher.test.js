const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// server/eventWatcher requires server/db, which opens a database the moment it's required - so
// this has to be set before the require below, or the tests here run against the real
// data/opendockwatch.db a container may hold open in WAL mode (see test/index.test.js).
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-eventwatcher-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const { parseEventLine, ingestEvent, broadcaster } = require('../server/eventWatcher');
const db = require('../server/db');
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
