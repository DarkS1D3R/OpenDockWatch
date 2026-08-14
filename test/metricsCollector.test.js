const test = require('node:test');
const assert = require('node:assert/strict');

const { nextDiskDelay, DISK_POLL_MS, DISK_DUTY_FACTOR, DISK_BACKOFF_MAX_MS } = require('../server/metricsCollector');

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
