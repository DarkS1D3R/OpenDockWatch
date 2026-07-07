const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const alerts = require('../server/alerts');

// alerts.js holds a reference to the real db module, so mocking methods on
// that same (require-cached) object intercepts every db call it makes,
// without touching sqlite.
function mockDb(t, overrides = {}) {
  const defaults = {
    getLastAlertFireTs: () => null,
    insertAlert: () => 1,
    countManualStopsSince: () => 0,
    countManualStartsSince: () => 0,
    countRestartsSince: () => 0,
  };
  for (const [name, impl] of Object.entries({ ...defaults, ...overrides })) {
    t.mock.method(db, name, impl);
  }
}

function captureFired(t, extraOverrides = {}) {
  const fired = [];
  mockDb(t, { insertAlert: (a) => (fired.push(a), 1), ...extraOverrides });
  return fired;
}

test('handleEvent: container_crashed', async (t) => {
  await t.test('fires when a container dies with a non-zero exit code', () => {
    const fired = captureFired(t);
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '1' } } },
    });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'container_crashed');
  });

  await t.test('does not fire on a clean exit (code 0)', () => {
    const fired = captureFired(t);
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '0' } } },
    });
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire when the container was manually stopped just before dying', () => {
    const fired = captureFired(t, { countManualStopsSince: () => 1 });
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '137' } } },
    });
    assert.equal(fired.length, 0);
  });
});

test('handleEvent: crash_loop', async (t) => {
  await t.test('fires when the restart count reaches the threshold with no manual restarts', () => {
    const fired = captureFired(t, { countRestartsSince: () => 3, countManualStartsSince: () => 0 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'crash_loop');
  });

  await t.test('does not fire when the restarts were manually triggered', () => {
    const fired = captureFired(t, { countRestartsSince: () => 3, countManualStartsSince: () => 3 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire below the threshold', () => {
    const fired = captureFired(t, { countRestartsSince: () => 2, countManualStartsSince: () => 0 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 0);
  });
});

test('handleEvent: unhealthy fires on a health_status: unhealthy event', (t) => {
  const fired = captureFired(t);
  alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'health_status: unhealthy', ts: Date.now(), raw: {} });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].rule, 'unhealthy');
});

test('handleHostReachability', async (t) => {
  await t.test('fires on a reachable -> unreachable transition', () => {
    const fired = captureFired(t);
    alerts.handleHostReachability('h', 'Host', false, true);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'host_unreachable');
  });

  await t.test('does not fire if the host was already unreachable', () => {
    const fired = captureFired(t);
    alerts.handleHostReachability('h', 'Host', false, false);
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire on an unreachable -> reachable transition', () => {
    const fired = captureFired(t);
    alerts.handleHostReachability('h', 'Host', true, false);
    assert.equal(fired.length, 0);
  });
});

test('cooldown: does not re-fire the same rule within the cooldown window', (t) => {
  const fired = captureFired(t, { getLastAlertFireTs: () => Date.now() - 1000 });
  alerts.handleEvent({
    hostId: 'h',
    containerId: 'c',
    containerName: 'web',
    action: 'die',
    ts: Date.now(),
    raw: { Actor: { Attributes: { exitCode: '1' } } },
  });
  assert.equal(fired.length, 0);
});
