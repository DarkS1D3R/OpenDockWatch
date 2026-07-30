const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWatchdog, STALE_MS, EXIT_AFTER_MS } = require('../server/watchdog');

// A controllable clock and a fake timer, so a watchdog whose whole job is measured in minutes can
// be exercised without waiting any of them out. `check` is called directly rather than through
// setInterval - start()/stop() only own the timer, all the decisions live in check().
function harness({ hostCount = 1 } = {}) {
  const state = {
    now: 1_000_000,
    lastPoll: 1_000_000,
    hostCount,
    exits: [],
  };
  const watchdog = createWatchdog({
    getLastPollCompletedTs: () => state.lastPoll,
    getHostCount: () => state.hostCount,
    now: () => state.now,
    exit: (code) => state.exits.push(code),
  });
  // Every tick advances the clock by the sample interval unless a test asks for a jump, so lag
  // reads as zero and doesn't pollute the staleness assertions.
  state.tick = (advanceMs = 1000) => {
    state.now += advanceMs;
    watchdog.check();
  };
  state.pollNow = () => {
    state.lastPoll = state.now;
  };
  return { state, watchdog };
}

test('watchdog', async (t) => {
  await t.test('reports healthy while the collector keeps completing polls', () => {
    const { state, watchdog } = harness();
    for (let i = 0; i < 10; i++) {
      state.pollNow();
      state.tick();
    }
    assert.equal(watchdog.status().ok, true);
    assert.deepEqual(state.exits, []);
  });

  await t.test('goes unhealthy once no poll has completed for STALE_MS', () => {
    const { state, watchdog } = harness();
    state.tick(STALE_MS - 1000);
    assert.equal(watchdog.status().ok, true);
    state.tick(2000);
    const status = watchdog.status();
    assert.equal(status.ok, false);
    assert.match(status.reason, /no metrics poll completed/);
  });

  await t.test('exits once staleness has persisted for EXIT_AFTER_MS, not before', () => {
    const { state } = harness();
    state.tick(STALE_MS + 1000); // first tick that observes staleness - starts the clock on it
    assert.deepEqual(state.exits, [], 'must not exit the moment it first goes stale');

    state.tick(EXIT_AFTER_MS - 1000);
    assert.deepEqual(state.exits, [], 'must not exit before the grace period is up');

    state.tick(2000);
    assert.deepEqual(state.exits, [1]);
  });

  await t.test('a poll landing during the grace period cancels the pending exit', () => {
    const { state, watchdog } = harness();
    state.tick(STALE_MS + 1000);
    state.tick(EXIT_AFTER_MS - 1000);
    assert.deepEqual(state.exits, []);

    state.pollNow();
    state.tick();
    assert.equal(watchdog.status().ok, true);

    // ...and the countdown restarts from scratch rather than resuming where it left off.
    state.tick(STALE_MS + 1000);
    state.tick(EXIT_AFTER_MS - 5000);
    assert.deepEqual(state.exits, []);
  });

  await t.test('never trips with no hosts configured', () => {
    // An empty config has nothing to poll, so lastPollCompletedTs stands still forever - without
    // this guard the process would restart itself on a loop over a config it is behaving
    // correctly for.
    const { state, watchdog } = harness({ hostCount: 0 });
    state.tick(STALE_MS + EXIT_AFTER_MS + 10_000);
    assert.equal(watchdog.status().ok, true);
    assert.deepEqual(state.exits, []);
  });

  await t.test('measures event-loop lag as timer drift beyond the sample interval', () => {
    const { state, watchdog } = harness();
    state.pollNow();
    state.tick(); // establishes a baseline tick
    assert.equal(watchdog.status().lagMs, 0);

    // A tick that arrives 8s after the previous one on a 1s interval means the loop was blocked
    // for ~7s in between.
    state.pollNow();
    state.now += 8000;
    state.lastPoll = state.now;
    watchdog.check();
    assert.equal(watchdog.status().lagMs, 7000);
  });

  await t.test('start() is idempotent and stop() clears the timer', () => {
    let intervals = 0;
    let cleared = 0;
    const watchdog = createWatchdog({
      getLastPollCompletedTs: () => 0,
      getHostCount: () => 0,
      setIntervalImpl: () => {
        intervals++;
        return { unref() {} };
      },
      clearIntervalImpl: () => {
        cleared++;
      },
    });
    watchdog.start();
    watchdog.start();
    assert.equal(intervals, 1);
    watchdog.stop();
    watchdog.stop();
    assert.equal(cleared, 1);
  });
});
