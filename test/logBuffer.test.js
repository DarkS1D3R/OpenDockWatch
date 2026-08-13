const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as format/graph/spark/logStream's tests.
let pushCapped;
test.before(async () => {
  ({ pushCapped } = await import('../public/js/lib/logBuffer.js'));
});

test('pushCapped', async (t) => {
  await t.test('appends in order and leaves a buffer under the cap alone', () => {
    const buf = [1, 2];
    assert.deepEqual(pushCapped(buf, [3, 4], 10), [1, 2, 3, 4]);
  });

  await t.test('trims from the front, keeping the newest max entries', () => {
    assert.deepEqual(pushCapped([1, 2, 3], [4, 5], 3), [3, 4, 5]);
  });

  await t.test('handles a single flush larger than the cap', () => {
    assert.deepEqual(pushCapped([1], [2, 3, 4, 5], 2), [4, 5]);
  });

  await t.test('mutates and returns the same array - callers hold a long-lived reference', () => {
    const buf = [1];
    assert.equal(pushCapped(buf, [2], 5), buf);
  });

  await t.test('an empty flush is a no-op', () => {
    assert.deepEqual(pushCapped([1, 2], [], 5), [1, 2]);
  });
});

// The property that makes pausing safe: holding lines aside and draining them later has to land
// exactly where streaming them straight through would have, cap included. If these ever diverge, a
// pause silently loses or reorders lines - the failure a user would only notice much later.
test('pausing and resuming lands on the same buffer as never pausing', async (t) => {
  const flushes = [[1, 2, 3], [4, 5], [6, 7, 8, 9], [10]];

  await t.test('under the cap', () => {
    const streamed = [];
    for (const f of flushes) pushCapped(streamed, f, 100);

    const visible = [];
    const pending = [];
    pushCapped(visible, flushes[0], 100); // live
    for (const f of flushes.slice(1)) pushCapped(pending, f, 100); // paused
    pushCapped(visible, pending, 100); // resumed

    assert.deepEqual(visible, streamed);
  });

  // The interesting half: a pause long enough that the held buffer alone overflows the cap. Both
  // paths must end on the same newest-N window, not just the same order.
  await t.test('when the pause outlasts the cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => i);
    const cap = 10;

    const streamed = [];
    for (const n of many) pushCapped(streamed, [n], cap);

    const visible = [];
    const pending = [];
    pushCapped(visible, [many[0]], cap);
    for (const n of many.slice(1)) pushCapped(pending, [n], cap);
    pushCapped(visible, pending, cap);

    assert.deepEqual(visible, streamed);
    assert.equal(visible.length, cap);
    assert.equal(visible[visible.length - 1], 49);
  });
});
