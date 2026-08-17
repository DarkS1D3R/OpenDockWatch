const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let logSync;
before(async () => {
  logSync = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logSync.js')));
});

test('closestIndexByTs', async (t) => {
  await t.test('returns -1 for an empty array', () => {
    assert.equal(logSync.closestIndexByTs([], 100), -1);
  });

  await t.test('returns -1 for an all-null array', () => {
    assert.equal(logSync.closestIndexByTs([null, null, null], 100), -1);
  });

  await t.test('returns -1 when the target itself is null', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], null), -1);
  });

  await t.test('the only element in a single-element array', () => {
    assert.equal(logSync.closestIndexByTs([10], 999), 0);
  });

  await t.test('the first element for a target before the whole range', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], 0), 0);
  });

  await t.test('the last element for a target after the whole range', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], 100), 2);
  });

  await t.test('an exact match', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], 20), 1);
  });

  await t.test('ties between two equidistant values resolve to the earlier one', () => {
    assert.equal(logSync.closestIndexByTs([10, 30], 20), 0);
  });

  await t.test('skips over null entries to find the nearest real value on either side', () => {
    assert.equal(logSync.closestIndexByTs([10, null, null, 40], 12), 0);
    assert.equal(logSync.closestIndexByTs([10, null, null, 40], 38), 3);
  });

  await t.test('a tie across null gaps still resolves to the earlier real value', () => {
    assert.equal(logSync.closestIndexByTs([10, null, null, 40], 25), 0);
  });

  await t.test('finds the only real value regardless of direction when surrounded by nulls', () => {
    assert.equal(logSync.closestIndexByTs([null, null, 50, null], 10), 2);
    assert.equal(logSync.closestIndexByTs([null, null, 50, null], 999), 2);
  });
});

// The other half of the same feature: closestIndexByTs answers "where do I scroll to", this
// answers "where am I now" - the line at the top of the viewport, whose timestamp a pane
// broadcasts to its siblings. It lived inline in LogViewer.js reading el.children directly, which
// is why only one of the two halves of multi-pane sync was ever tested.
test('topIndexByOffset', async (t) => {
  // Line boxes are laid out top to bottom, so offsets are non-decreasing - the property that makes
  // a binary search valid here at all. Uniform 20px rows unless a case needs otherwise.
  const rows = (n, h = 20) => Array.from({ length: n }, (_, i) => i * h);

  // EVERY call below goes through a probe budget, and that is the point rather than belt-and-braces.
  // The failure this function can have is a loop that never returns, and `node --test` has no
  // per-test timeout - so an unbudgeted assertion does not fail on a non-terminating search, it
  // hangs the entire run until something outside kills it, which reads as a broken suite rather
  // than a broken function. Measured: with a lower mid, an unbudgeted accessor spun until a 60s
  // `timeout` killed the runner (exitCode 143, zero tests reported); budgeted, it names the fault
  // in milliseconds. If a case is added here, give it a budget too.
  const budgeted = (offsets, budget = 64) => {
    let probes = 0;
    const accessor = (i) => {
      if ((probes += 1) > budget) throw new Error(`topIndexByOffset made more than ${budget} probes - it is not terminating`);
      return offsets[i];
    };
    accessor.probes = () => probes;
    return accessor;
  };

  const topIndex = (offsets, scrollTop) => logSync.topIndexByOffset(offsets.length, budgeted(offsets), scrollTop);

  await t.test('returns -1 when nothing is rendered', () => {
    assert.equal(
      logSync.topIndexByOffset(0, () => 0, 100),
      -1
    );
  });

  await t.test('the first line when scrolled to the very top', () => {
    assert.equal(topIndex(rows(10), 0), 0);
  });

  await t.test('the line whose box starts exactly at the scroll position', () => {
    assert.equal(topIndex(rows(10), 60), 3);
  });

  // A scroll position lands mid-line far more often than on a boundary, and the answer is the line
  // being cut off at the top - the one you are actually looking at - not the next one down.
  await t.test('the partially-scrolled line, not the next one, for a position inside a box', () => {
    assert.equal(topIndex(rows(10), 65), 3);
    assert.equal(topIndex(rows(10), 79), 3);
    assert.equal(topIndex(rows(10), 80), 4);
  });

  await t.test('the last line when scrolled past the end', () => {
    assert.equal(topIndex(rows(10), 99999), 9);
  });

  await t.test('the only line in a single-line pane, wherever it is scrolled', () => {
    assert.equal(topIndex([0], 0), 0);
    assert.equal(topIndex([0], 500), 0);
  });

  // Wrapped lines make rows different heights, which is the normal case with `wrap` on - the
  // search must not assume a uniform stride.
  await t.test('handles unequal row heights, as wrapped lines produce', () => {
    const offsets = [0, 14, 70, 84, 200];
    assert.equal(topIndex(offsets, 69), 1);
    assert.equal(topIndex(offsets, 70), 2);
    assert.equal(topIndex(offsets, 199), 3);
  });

  // The loop moves lo to mid rather than mid + 1, so it needs the upper mid; a lower one leaves
  // lo === mid once hi === lo + 1 and spins. Two elements is the smallest case that reaches it,
  // and a long pane scrolled to its end is the case a real user hits.
  await t.test('terminates on the cases a lower mid would spin on', () => {
    assert.equal(topIndex([0, 20], 25), 1);
    assert.equal(topIndex([0, 20], 5), 0);
    assert.equal(topIndex(rows(64), 99999), 63);
  });

  // It is a search, not a scan: a pane can hold thousands of lines and this runs on every frame of
  // a drag. Counting probes is what keeps a "simplification" to findLast/indexOf honest.
  await t.test('probes logarithmically, not linearly', () => {
    const offsets = rows(4096);
    const accessor = budgeted(offsets, 64);
    assert.equal(logSync.topIndexByOffset(offsets.length, accessor, 40960), 2048);
    assert.ok(accessor.probes() <= 16, `expected ~log2(4096) probes, got ${accessor.probes()}`);
  });
});
