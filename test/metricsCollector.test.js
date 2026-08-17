const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// metricsCollector requires server/db, which opens a database the moment it's required - so this
// has to be set before the require below, or these run against the real data/opendockwatch.db a
// container may hold open in WAL mode (see test/index.test.js).
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-collector-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const metricsCollector = require('../server/metricsCollector');
const { nextDiskDelay, DISK_POLL_MS, DISK_DUTY_FACTOR, DISK_BACKOFF_MAX_MS } = metricsCollector;
const docker = require('../server/docker');
const statsWatcher = require('../server/statsWatcher');
const alerts = require('../server/alerts');
const db = require('../server/db');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  }
});

// The disk poll's cadence is the one schedule in the app derived from measurement rather than
// declared, because `docker system df`'s cost is a property of the host's storage - sub-second on
// native Linux, 40-75s on a WSL2 virtual disk. These assert both halves and, more importantly,
// that neither half changes anything on a host where the call is fast and working.
test('nextDiskDelay', async (t) => {
  const state = (lastDurationMs = 0, failures = 0) => ({ lastDurationMs, failures });

  await t.test('a fast, healthy call keeps the plain interval', () => {
    assert.equal(nextDiskDelay(state(0, 0)), DISK_POLL_MS, 'before the first run there is nothing to derive from');
    assert.equal(nextDiskDelay(state(400, 0)), DISK_POLL_MS, 'sub-second, as on native Linux');
    // Right up to the point where duty-cycling would ask for more than the interval anyway.
    assert.equal(nextDiskDelay(state(DISK_POLL_MS / DISK_DUTY_FACTOR, 0)), DISK_POLL_MS);
  });

  await t.test('a slow call spaces itself out instead of running back-to-back', () => {
    // The measured WSL2 case: a 75s call must not be scheduled every 60s.
    const delay = nextDiskDelay(state(75_000, 0));
    assert.equal(delay, 75_000 * DISK_DUTY_FACTOR);
    assert.ok(delay > 75_000, 'the gap has to exceed the call itself or it is effectively continuous');
  });

  await t.test('consecutive failures back off exponentially and cap', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 20].map((f) => nextDiskDelay(state(0, f)));
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], 'must never shorten as failures accumulate');
    }
    assert.equal(delays[0], DISK_POLL_MS * 2);
    assert.equal(delays[delays.length - 1], DISK_BACKOFF_MAX_MS, 'and settles at the cap rather than growing forever');
    assert.ok(delays.every((d) => d <= DISK_BACKOFF_MAX_MS));
  });

  await t.test('duty and backoff compose - whichever is longer wins', () => {
    // A slow call that is also failing (the exact case that shipped: 41-75s against a 30s timeout)
    // must not have its backoff undone by the duty figure, or vice versa.
    assert.equal(nextDiskDelay(state(75_000, 1)), Math.max(75_000 * DISK_DUTY_FACTOR, DISK_POLL_MS * 2));
    assert.ok(nextDiskDelay(state(75_000, 5)) >= nextDiskDelay(state(75_000, 0)));
    assert.ok(nextDiskDelay(state(0, 5)) >= nextDiskDelay(state(0, 4)));
  });

  await t.test('one success is enough to return to normal', () => {
    // failures resets to 0 in pollDiskUsage, so a recovered host must not stay backed off.
    assert.equal(nextDiskDelay(state(500, 0)), DISK_POLL_MS);
  });
});

// Reachability used to be its own `docker version` probe in front of every poll. It is now derived
// from whether the poll's own calls answered, with the probe kept only as the gate for a host
// already believed down - so these cover which branch runs, and that the alert fires exactly once
// per poll either way. Nothing here spawns docker: every call pollHost makes is stubbed.
test('pollHost reachability', async (t) => {
  const HOST = { id: 'rh', name: 'Remote' };
  const containers = [{ id: 'aaa', name: 'web', state: 'running', alertsDisabled: false, composeProject: null }];
  const stats = { aaa: { cpuPerc: '1.0%', memUsage: '10MiB / 1GiB', memPerc: '1.0%' } };

  // Returns the calls made and the reachability transitions alerted, for one poll.
  function stub(t2, { list, stat, info, probe = true } = {}) {
    const calls = [];
    const reach = [];
    const fail = (name) => () => {
      calls.push(name);
      return Promise.reject(Object.assign(new Error(`${name} blew up`), { stderr: `${name}: no such host` }));
    };
    const ok = (name, value) => () => {
      calls.push(name);
      return Promise.resolve(value);
    };
    t2.mock.method(docker, 'listContainers', list === false ? fail('list') : ok('list', containers));
    t2.mock.method(docker, 'getStats', stat === false ? fail('stats') : ok('stats', stats));
    t2.mock.method(docker, 'getHostInfo', info === false ? fail('info') : ok('info', { ncpu: 4, memTotalBytes: 1e9 }));
    t2.mock.method(docker, 'checkHost', () => {
      calls.push('probe');
      return Promise.resolve(probe);
    });
    t2.mock.method(statsWatcher, 'getSamples', () => null);
    t2.mock.method(alerts, 'handleHostReachability', (id, name, reachable, wasReachable) => reach.push([reachable, wasReachable]));
    t2.mock.method(alerts, 'handleSample', () => {});
    t2.mock.method(alerts, 'handleHostSample', () => {});
    t2.mock.method(alerts, 'retainContainers', () => {});
    t2.mock.method(db, 'insertContainerMetrics', () => {});
    t2.mock.method(db, 'insertHostMetric', () => {});
    // removeHost only unwinds a host that was addHost-ed; these drive pollHost directly, so the
    // snapshot is what has to be cleared or the next subtest inherits this one's reachability.
    t2.after(() => metricsCollector.getAllSnapshots().delete(HOST.id));
    return { calls, reach };
  }

  // The whole point of the change: a host that answered last time does not get probed again.
  await t.test('a reachable host is not probed at all', async (t2) => {
    const s = stub(t2);
    await metricsCollector.pollHost(HOST);
    assert.equal(s.calls.includes('probe'), false, '`docker version` ran in front of a poll whose own calls already prove the host is up');
    assert.deepEqual(s.calls.sort(), ['info', 'list', 'stats']);
    assert.deepEqual(s.reach, [[true, true]], 'reachability must be reported exactly once per poll');
    assert.equal(metricsCollector.getSnapshot(HOST.id).reachable, true);
  });

  await t.test('all three failing is what marks a host unreachable', async (t2) => {
    // A good poll first, so the clearing below is actually clearing something - a host that was
    // never up has an empty snapshot either way and would pass this without the code doing it.
    stub(t2, {});
    await metricsCollector.pollHost(HOST);
    assert.equal(metricsCollector.getSnapshot(HOST.id).containers.length, 1);
    t2.mock.restoreAll();

    const s = stub(t2, { list: false, stat: false, info: false });
    await metricsCollector.pollHost(HOST);
    assert.deepEqual(s.reach, [[false, true]]);
    const snap = metricsCollector.getSnapshot(HOST.id);
    assert.equal(snap.reachable, false);
    assert.deepEqual(snap.containers, [], 'an unreachable host has nothing on the way, unlike a slow one');
    assert.deepEqual(snap.stats, {});
    assert.equal(snap.hostInfo, null);
  });

  // The old probe answered one question with one call, so a single failing call could not be
  // mistaken for a dead daemon. Deriving reachability from three calls has to keep that property.
  await t.test('one failing call is a failed poll, not an unreachable host', async (t2) => {
    for (const only of ['list', 'stat', 'info']) {
      const s = stub(t2, { [only]: false });
      await metricsCollector.pollHost(HOST);
      assert.deepEqual(s.reach, [[true, true]], `${only} failing alone must not fire host_unreachable`);
      assert.equal(metricsCollector.getSnapshot(HOST.id).reachable, true);
      metricsCollector.getAllSnapshots().delete(HOST.id);
    }
  });

  await t.test('a partial failure leaves the previous poll on the snapshot', async (t2) => {
    stub(t2, {});
    await metricsCollector.pollHost(HOST);
    assert.equal(metricsCollector.getSnapshot(HOST.id).containers.length, 1);
    t2.mock.restoreAll();
    const s = stub(t2, { info: false });
    await metricsCollector.pollHost(HOST);
    assert.equal(s.reach.length, 1);
    // Half a poll would diff this poll's stats against themselves and write an instant of
    // history that never happened, so the whole update is skipped rather than partly applied.
    assert.equal(metricsCollector.getSnapshot(HOST.id).containers.length, 1);
  });
});

test('pollHost probe gate', async (t) => {
  const HOST = { id: 'gate' };

  function stub(t2, probe) {
    const calls = [];
    const reach = [];
    t2.mock.method(docker, 'checkHost', () => {
      calls.push('probe');
      return Promise.resolve(probe);
    });
    for (const name of ['listContainers', 'getStats', 'getHostInfo']) {
      t2.mock.method(docker, name, () => {
        calls.push(name);
        return Promise.resolve(name === 'listContainers' ? [] : {});
      });
    }
    t2.mock.method(statsWatcher, 'getSamples', () => null);
    t2.mock.method(alerts, 'handleHostReachability', (id, n, r, w) => reach.push([r, w]));
    t2.mock.method(alerts, 'retainContainers', () => {});
    t2.mock.method(db, 'insertContainerMetrics', () => {});
    // removeHost only unwinds a host that was addHost-ed; these drive pollHost directly, so the
    // snapshot is what has to be cleared or the next subtest inherits this one's reachability.
    t2.after(() => metricsCollector.getAllSnapshots().delete(HOST.id));
    return { calls, reach };
  }

  // The asymmetry the probe exists for: against a host that IS down, one process failing fast
  // beats three each waiting out their own timeout, so a down host never gets past the gate.
  await t.test('a host already down is probed, and stops there while it stays down', async (t2) => {
    stub(t2, false);
    await metricsCollector.pollHost(HOST); // first poll assumes reachable, all calls succeed
    t2.mock.restoreAll();
    const s = stub(t2, false);
    // Force the "was down" state the gate keys off.
    metricsCollector.getSnapshot(HOST.id).reachable = false;
    await metricsCollector.pollHost(HOST);
    assert.deepEqual(s.calls, ['probe'], 'a down host spent three calls finding out it is still down');
    assert.deepEqual(s.reach, [[false, false]]);
  });

  await t.test('the probe succeeding lets the poll through', async (t2) => {
    stub(t2, true);
    await metricsCollector.pollHost(HOST);
    t2.mock.restoreAll();
    const s = stub(t2, true);
    metricsCollector.getSnapshot(HOST.id).reachable = false;
    await metricsCollector.pollHost(HOST);
    assert.equal(s.calls[0], 'probe');
    assert.deepEqual(s.calls.slice(1).sort(), ['getHostInfo', 'getStats', 'listContainers']);
    assert.deepEqual(s.reach, [[true, false]], 'coming back up is a transition worth reporting');
    assert.equal(metricsCollector.getSnapshot(HOST.id).reachable, true);
  });
});
