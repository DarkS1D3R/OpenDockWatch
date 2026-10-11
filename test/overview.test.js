const test = require('node:test');
const assert = require('node:assert/strict');
const { hostDisplayName, countContainers, hostStatus, hostOverview } = require('../server/overview');

const LOCAL = { id: 'local' };
const REMOTE = { id: 'edge', name: 'Edge box', dockerHost: 'ssh://deploy@edge.example.com' };

function snapshot(overrides = {}) {
  return {
    ts: 1000,
    statsTs: 1000,
    reachable: true,
    containers: [
      { id: 'a', name: 'web', state: 'running', health: 'healthy' },
      { id: 'b', name: 'db', state: 'running', health: null },
      { id: 'c', name: 'job', state: 'exited', health: null },
    ],
    hostInfo: { ncpu: 4, memTotalBytes: 8e9, hostname: 'shop-01' },
    usage: { cpuPercent: 12.5, memUsedBytes: 2e9 },
    ...overrides,
  };
}

test('hostDisplayName', async (t) => {
  await t.test('a configured name wins', () => {
    assert.equal(hostDisplayName(REMOTE, snapshot()), 'Edge box');
  });
  await t.test("a local host with no name uses the daemon's own hostname", () => {
    assert.equal(hostDisplayName(LOCAL, snapshot()), 'shop-01');
  });
  await t.test('a remote host never borrows a hostname, and nothing at all falls back to the id', () => {
    assert.equal(hostDisplayName({ id: 'edge', dockerHost: 'ssh://x' }, snapshot()), 'edge');
    assert.equal(hostDisplayName(LOCAL, null), 'local');
  });
});

test('countContainers', () => {
  const counts = countContainers([
    { state: 'running', health: 'unhealthy' },
    { state: 'running', health: 'healthy' },
    { state: 'restarting', health: null },
    { state: 'exited', health: null },
  ]);
  assert.deepEqual(counts, { total: 4, running: 2, unhealthy: 1, restarting: 1 });
  assert.deepEqual(countContainers(undefined), { total: 0, running: 0, unhealthy: 0, restarting: 0 });
});

test('hostStatus', async (t) => {
  const quiet = { total: 2, running: 2, unhealthy: 0, restarting: 0 };
  await t.test('not polled yet is pending, even if it would otherwise be down', () => {
    assert.equal(hostStatus({ polled: false, reachable: null, openAlerts: 3, containers: null }), 'pending');
  });
  await t.test('unreachable is down, whatever else is true', () => {
    assert.equal(hostStatus({ polled: true, reachable: false, openAlerts: 0, containers: null }), 'down');
  });
  await t.test('an open alert, an unhealthy or a restarting container each make it a warning', () => {
    assert.equal(hostStatus({ polled: true, reachable: true, openAlerts: 1, containers: quiet }), 'warning');
    assert.equal(hostStatus({ polled: true, reachable: true, openAlerts: 0, containers: { ...quiet, unhealthy: 1 } }), 'warning');
    assert.equal(hostStatus({ polled: true, reachable: true, openAlerts: 0, containers: { ...quiet, restarting: 1 } }), 'warning');
  });
  await t.test('stopped containers alone are not a problem - plenty are stopped on purpose', () => {
    assert.equal(hostStatus({ polled: true, reachable: true, openAlerts: 0, containers: { ...quiet, total: 5 } }), 'ok');
  });
});

test('hostOverview', async (t) => {
  await t.test('a healthy host carries counts, usage and memory total', () => {
    const row = hostOverview({ host: LOCAL, snapshot: snapshot(), openAlerts: 0 });
    assert.deepEqual(row, {
      id: 'local',
      name: 'shop-01',
      remote: false,
      polled: true,
      reachable: true,
      downSince: null,
      containers: { total: 3, running: 2, unhealthy: 0, restarting: 0 },
      cpuPercent: 12.5,
      memUsedBytes: 2e9,
      memTotalBytes: 8e9,
      openAlerts: 0,
      status: 'ok',
    });
  });

  await t.test('the SSH address never leaves the server - only that the host is remote', () => {
    const row = hostOverview({ host: REMOTE, snapshot: snapshot() });
    assert.equal(row.remote, true);
    assert.ok(!JSON.stringify(row).includes('deploy@'), 'the docker host URL carries a user name and address');
  });

  await t.test('a host with no snapshot yet is pending, with nothing guessed', () => {
    const row = hostOverview({ host: REMOTE, snapshot: null, openAlerts: 2 });
    assert.equal(row.status, 'pending');
    assert.equal(row.reachable, null);
    assert.equal(row.containers, null);
    assert.equal(row.cpuPercent, null);
    assert.equal(row.openAlerts, 2, 'alerts are in sqlite and still worth showing');
  });

  // Reachable but before the first full poll: zero containers would read as "runs nothing".
  await t.test('reachable but without a container list yet shows no counts rather than zero', () => {
    const row = hostOverview({ host: LOCAL, snapshot: snapshot({ statsTs: undefined, containers: [] }) });
    assert.equal(row.containers, null);
  });

  await t.test('a down host reports when it went down, and none of its stale figures', () => {
    const down = snapshot({ reachable: false, containers: [], hostInfo: null, usage: null, statsTs: undefined });
    const row = hostOverview({ host: REMOTE, snapshot: down, openAlerts: 1, lastReachability: { ts: 500, reachable: false } });
    assert.equal(row.status, 'down');
    assert.equal(row.downSince, 500);
    assert.equal(row.containers, null);
    assert.equal(row.cpuPercent, null);
    assert.equal(row.memTotalBytes, null);
  });

  await t.test('down with no transition on record, or a last transition that says up, has no down-since', () => {
    const down = snapshot({ reachable: false });
    assert.equal(hostOverview({ host: REMOTE, snapshot: down, lastReachability: null }).downSince, null);
    assert.equal(hostOverview({ host: REMOTE, snapshot: down, lastReachability: { ts: 500, reachable: true } }).downSince, null);
  });

  await t.test('an up host ignores an old down transition', () => {
    const row = hostOverview({ host: LOCAL, snapshot: snapshot(), lastReachability: { ts: 500, reachable: false } });
    assert.equal(row.downSince, null);
  });
});
