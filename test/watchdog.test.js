const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createWatchdog,
  STALE_MS,
  EXIT_AFTER_MS,
  LAG_WARN_MS,
  LAG_SUMMARY_MS,
  SUSPEND_JUMP_MS,
  RESUME_GRACE_MS,
} = require('../server/watchdog');

// Two controllable clocks and a fake timer, so a watchdog whose whole job is measured in minutes
// can be exercised without waiting any of them out. They are separate because the watchdog tells a
// blocked event loop from a suspended host by how far they diverge - `tick` advances both together
// (a running host), `suspend` advances only the wall clock (the machine was away). `check` is
// called directly rather than through setInterval - start()/stop() only own the timer, all the
// decisions live in check().
function harness({ hostCount = 1 } = {}) {
  const state = {
    now: 1_000_000,
    mono: 5_000,
    lastPoll: 1_000_000,
    hostCount,
    exits: [],
  };
  const watchdog = createWatchdog({
    getLastPollCompletedTs: () => state.lastPoll,
    getHostCount: () => state.hostCount,
    now: () => state.now,
    monotonic: () => state.mono,
    exit: (code) => state.exits.push(code),
  });
  // Every tick advances both clocks by the sample interval unless a test asks for a jump, so lag
  // reads as zero and doesn't pollute the staleness assertions.
  state.tick = (advanceMs = 1000) => {
    state.now += advanceMs;
    state.mono += advanceMs;
    watchdog.check();
  };
  // A blocked event loop: the tick arrives late on both clocks alike.
  state.stall = (blockedMs) => state.tick(1000 + blockedMs);
  // A suspended host: wall time passed, monotonic time did not.
  state.suspend = (awayMs) => {
    state.now += awayMs;
    state.tick();
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
    state.mono += 8000;
    state.lastPoll = state.now;
    watchdog.check();
    assert.equal(watchdog.status().lagMs, 7000);
  });

  await t.test('a suspended host is not a stall - lag stays zero and the exit countdown never starts', () => {
    // The wall clock jumps hours, the monotonic clock does not. Reading staleness off the wall
    // clock alone would restart a perfectly healthy process every time the machine wakes up.
    const { state, watchdog } = harness();
    state.pollNow();
    state.tick();

    state.suspend(15 * 3600 * 1000);
    assert.equal(watchdog.status().lagMs, 0, 'a suspend is not event-loop lag');
    assert.equal(watchdog.status().ok, true, 'and must not read as unhealthy on the way back');

    // The collector gets a grace period to turn over before staleness counts again.
    state.tick(RESUME_GRACE_MS - 2000);
    assert.equal(watchdog.status().ok, true);
    assert.deepEqual(state.exits, []);

    // Once it does poll, everything carries on as normal.
    state.pollNow();
    state.tick(2000);
    assert.equal(watchdog.status().ok, true);
    assert.deepEqual(state.exits, []);
  });

  await t.test('a host that never comes back after a resume still gets restarted', () => {
    // The resume grace must delay the countdown, not cancel it - a machine that wakes with a
    // wedged collector is exactly the case the watchdog exists for.
    const { state } = harness();
    state.pollNow();
    state.tick();
    state.suspend(15 * 3600 * 1000);

    // The grace expires and staleness is observed on the same tick, since lastPoll is already
    // hours old - that tick starts the countdown, it does not exit on its own.
    state.tick(RESUME_GRACE_MS + 1000);
    assert.deepEqual(state.exits, [], 'the resume grace delays the countdown, it does not cancel it');

    state.tick(EXIT_AFTER_MS - 1000);
    assert.deepEqual(state.exits, []);

    state.tick(2000);
    assert.deepEqual(state.exits, [1]);
  });

  await t.test('a stall shorter than the warn threshold is still carried into the lag summary', () => {
    // The whole point of the summary: a host losing minutes an hour to sub-threshold stalls left
    // no trace at all when the only signal was a single-stall warning.
    const { state, watchdog } = harness();
    const lines = [];
    const logger = require('../server/logger');
    const realWarn = logger.warn;
    logger.warn = (event, fields) => lines.push({ event, fields });
    try {
      state.pollNow();
      state.tick();
      for (let i = 0; i < 5; i++) {
        state.stall(600); // under LAG_WARN_MS, so no line of its own
        state.pollNow();
      }
      assert.deepEqual(
        lines.filter((l) => l.event === 'watchdog.event_loop_lag'),
        [],
        'stalls under the warn threshold must not each log a line'
      );
      assert.equal(watchdog.status().lagMs, 600);

      // ...but they are all still accounted for when the window closes.
      state.tick(LAG_SUMMARY_MS);
      state.pollNow();
      const summary = lines.find((l) => l.event === 'watchdog.lag_summary');
      assert.ok(summary, 'the window should have been flushed');
      assert.equal(summary.fields.stalls, 6, '5 small stalls plus the one that closed the window');
      assert.ok(summary.fields.totalMs >= 3000);
    } finally {
      logger.warn = realWarn;
    }
  });

  await t.test('a single stall past the warn threshold still gets its own line', () => {
    const { state } = harness();
    const lines = [];
    const logger = require('../server/logger');
    const realWarn = logger.warn;
    logger.warn = (event, fields) => lines.push({ event, fields });
    try {
      state.pollNow();
      state.tick();
      state.stall(LAG_WARN_MS + 500);
      const warned = lines.filter((l) => l.event === 'watchdog.event_loop_lag');
      assert.equal(warned.length, 1);
      assert.equal(warned[0].fields.lagMs, LAG_WARN_MS + 500);
    } finally {
      logger.warn = realWarn;
    }
  });

  await t.test('recovery is bounded by STALE_MS + EXIT_AFTER_MS, not minutes beyond it', () => {
    // Guards the two constants against drifting back up: this is the number the user actually
    // experiences as "how long until it fixes itself".
    assert.ok(
      STALE_MS + EXIT_AFTER_MS <= 300_000,
      `worst-case recovery is ${(STALE_MS + EXIT_AFTER_MS) / 1000}s - past 5 minutes it stops being self-healing`
    );
    assert.ok(STALE_MS >= 90_000, 'detection must stay clear of a legitimately slow poll cycle (~45s worst case)');
    assert.ok(SUSPEND_JUMP_MS < STALE_MS);
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
