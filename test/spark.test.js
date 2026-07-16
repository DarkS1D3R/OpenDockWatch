const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let spark;
before(async () => {
  spark = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'spark.js')));
});

test('padSlots', async (t) => {
  await t.test('left-pads with null up to the target length', () => {
    assert.deepEqual(spark.padSlots([1, 2], 5), [null, null, null, 1, 2]);
  });

  await t.test('returns the array unchanged when already at or over length', () => {
    assert.deepEqual(spark.padSlots([1, 2, 3], 3), [1, 2, 3]);
    assert.deepEqual(spark.padSlots([1, 2, 3, 4], 3), [1, 2, 3, 4]);
  });

  await t.test('pads an empty array to all nulls', () => {
    assert.deepEqual(spark.padSlots([], 3), [null, null, null]);
  });
});

test('sparkPoint', async (t) => {
  await t.test('returns null for null/undefined samples', () => {
    assert.equal(spark.sparkPoint([null, 5], 10, 0), null);
    assert.equal(spark.sparkPoint([undefined, 5], 10, 0), null);
  });

  await t.test('maps a single-sample series to the right edge', () => {
    const p = spark.sparkPoint([5], 10, 0);
    assert.equal(p.x, 100);
  });

  await t.test('maps first/last of a multi-sample series to x=0/x=100', () => {
    const first = spark.sparkPoint([1, 2, 3], 10, 0);
    const last = spark.sparkPoint([1, 2, 3], 10, 2);
    assert.equal(first.x, 0);
    assert.equal(last.x, 100);
  });

  await t.test('a value at peak sits at the top of the usable area (y = topPad = 3)', () => {
    const p = spark.sparkPoint([10], 10, 0);
    assert.equal(p.y, 3);
  });

  await t.test('a zero peak (no data yet) flattens every point to the baseline (y = 30)', () => {
    const p = spark.sparkPoint([0], 0, 0);
    assert.equal(p.y, 30);
  });

  await t.test('carries the raw value through as v', () => {
    assert.equal(spark.sparkPoint([7], 10, 0).v, 7);
  });
});

test('sparkPaths', async (t) => {
  await t.test('an all-null series produces empty paths and no dot', () => {
    assert.deepEqual(spark.sparkPaths([null, null], 10), { line: '', area: '', dot: null });
  });

  await t.test('builds an M/L line string skipping null slots', () => {
    const { line } = spark.sparkPaths([null, 5, 10], 10);
    assert.ok(line.startsWith('M'));
    // Only two real points (indices 1 and 2) should appear, joined by one L.
    assert.equal(line.split('L').length, 2);
  });

  await t.test('the area path closes down to the baseline under first/last points', () => {
    const { area, line } = spark.sparkPaths([5, 10], 10);
    assert.ok(area.startsWith(line));
    assert.ok(area.trim().endsWith('Z'));
  });

  await t.test('the dot sits at the last real point', () => {
    const { dot } = spark.sparkPaths([5, 10, null], 10);
    // Last real sample is index 1 of 3 -> x = 1/(3-1) * 100 = 50.
    assert.equal(dot.x, 50);
  });
});

test('hoverPoints', async (t) => {
  await t.test('returns null when no index is hovered', () => {
    assert.equal(spark.hoverPoints(null, [1, 2], [3, 4], 10), null);
  });

  await t.test('returns null when neither series has a value at that index', () => {
    assert.equal(spark.hoverPoints(0, [null], [null], 10), null);
  });

  await t.test('includes both docker and host points when both have data', () => {
    const p = spark.hoverPoints(0, [5], [8], 10);
    assert.ok(p.docker);
    assert.ok(p.host);
    assert.equal(p.x, p.docker.x);
  });

  await t.test('falls back to the host point for x when only the host series has data', () => {
    const p = spark.hoverPoints(0, [null], [8], 10);
    assert.equal(p.docker, null);
    assert.ok(p.host);
    assert.equal(p.x, p.host.x);
  });
});

test('axisTickIndices', async (t) => {
  await t.test('returns an empty array for an empty slots array', () => {
    assert.deepEqual(spark.axisTickIndices([], 4), []);
  });

  await t.test('picks evenly-spaced indices across a fully-populated array', () => {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.deepEqual(spark.axisTickIndices(slots, 4), [0, 3, 6, 9]);
  });

  await t.test('a count of 1 picks only the last index', () => {
    assert.deepEqual(spark.axisTickIndices([1, 2, 3], 1), [2]);
  });

  await t.test('skips still-null (not-yet-populated) slots', () => {
    const slots = [null, null, null, null, null, 6, 7, 8, 9, 10];
    // Desired positions 0/3/6/9 -> only 6 and 9 land on real data.
    assert.deepEqual(spark.axisTickIndices(slots, 4), [6, 9]);
  });

  await t.test('de-dupes when a short real-data run rounds several desired ticks to the same index', () => {
    const slots = [null, null, null, null, null, null, null, null, 9, 10];
    // Desired positions 0/3/6 all round into the null region and get skipped; the middle-to-last
    // desired positions can collapse onto the same real index - only unique indices come back.
    const result = spark.axisTickIndices(slots, 4);
    assert.equal(new Set(result).size, result.length);
    assert.ok(result.every((i) => slots[i] !== null));
  });

  await t.test('an all-null array returns no ticks', () => {
    assert.deepEqual(spark.axisTickIndices([null, null, null], 4), []);
  });
});
