const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { withIoRates, BUCKET_EXPR } = require('../server/metricsHistory');

// Bucket rows as db.js's containerMetricsHistory returns them: ordered by bucket ASC, each I/O
// field the cumulative counter's value at the end of that bucket.
function row(bucket, { netRx = 0, netTx = 0, blockRead = 0, blockWrite = 0 } = {}) {
  return { bucket, cpuPerc: 1, netRxTotal: netRx, netTxTotal: netTx, blockReadTotal: blockRead, blockWriteTotal: blockWrite };
}

const SEC = 1000;

const FIXED_NOW = 1_700_000_000_000;

// Wall-clock timestamps don't land on bucket boundaries, so a run of samples from an arbitrary
// base straddles one and splits unevenly. That's correct behaviour, but it makes the assertions
// about arithmetic rather than about bucketing - so the tests below start from an aligned base.
function alignedBase(bucketMs) {
  return FIXED_NOW - (FIXED_NOW % bucketMs);
}

// Against a throwaway in-memory database rather than data/opendockwatch.db - the thing under test
// is the SQL expression itself, which only SQLite can answer for. It has to be exercised the same
// way db.js uses it (a bound @bucketMs parameter), because that binding is exactly what broke the
// division-based version this replaced: better-sqlite3 binds JS numbers as REAL, `/` then does
// float division, and `(ts / @bucketMs) * @bucketMs` came back as plain `ts` - so GROUP BY grouped
// nothing and every raw sample was its own bucket. Asserting on rows *collapsing* is the point.
function bucketRows(timestamps, bucketMs) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE m (ts INTEGER NOT NULL, v REAL)');
  const insert = db.prepare('INSERT INTO m (ts, v) VALUES (?, ?)');
  for (const ts of timestamps) insert.run(ts, 1);
  const rows = db.prepare(`SELECT ${BUCKET_EXPR} AS bucket, COUNT(*) AS n FROM m GROUP BY bucket ORDER BY bucket ASC`).all({ bucketMs });
  db.close();
  return rows;
}

test('BUCKET_EXPR', async (t) => {
  await t.test('collapses samples inside one window into a single bucket', () => {
    // 12 samples 5s apart across a minute, bucketed at 15s -> 4 buckets of 3. The base is aligned
    // to the bucket width first, or the run straddles a boundary and splits 2/3/3/3/1 - true of
    // the expression, but it would be testing arithmetic rather than the collapsing.
    const base = alignedBase(15 * SEC);
    const timestamps = Array.from({ length: 12 }, (_, i) => base + i * 5 * SEC);
    const rows = bucketRows(timestamps, 15 * SEC);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((r) => r.n),
      [3, 3, 3, 3]
    );
  });

  await t.test('floors each bucket to a multiple of the bucket width', () => {
    const rows = bucketRows([1_784_818_723_476], 15 * SEC);
    assert.equal(rows[0].bucket, 1_784_818_710_000);
    assert.equal(rows[0].bucket % (15 * SEC), 0);
  });

  await t.test('works at the wider bucket widths the 24h and 7d ranges use', () => {
    // Two hours of samples one minute apart, bucketed at 30 minutes -> 4 buckets of 30.
    const base = alignedBase(30 * 60 * SEC);
    const timestamps = Array.from({ length: 120 }, (_, i) => base + i * 60 * SEC);
    const rows = bucketRows(timestamps, 30 * 60 * SEC);
    assert.equal(rows.length, 4);
    for (const r of rows) assert.equal(r.bucket % (30 * 60 * SEC), 0);
  });

  await t.test('leaves samples in different windows in different buckets', () => {
    const base = alignedBase(15 * SEC);
    const rows = bucketRows([base, base + 15 * SEC], 15 * SEC);
    assert.equal(rows.length, 2);
  });
});

test('withIoRates', async (t) => {
  await t.test('returns an empty array unchanged', () => {
    assert.deepEqual(withIoRates([]), []);
  });

  await t.test('leaves the first row with null rates - nothing to diff against', () => {
    const [first] = withIoRates([row(0, { netRx: 5000 })]);
    assert.equal(first.netRxRate, null);
    assert.equal(first.netTxRate, null);
    assert.equal(first.blockReadRate, null);
    assert.equal(first.blockWriteRate, null);
  });

  await t.test('divides the counter delta by the elapsed seconds between buckets', () => {
    const rows = withIoRates([row(0, { netRx: 1000 }), row(15 * SEC, { netRx: 4000 })]);
    // 3000 bytes over 15s
    assert.equal(rows[1].netRxRate, 200);
  });

  await t.test('computes all four counters independently', () => {
    const rows = withIoRates([
      row(0, { netRx: 100, netTx: 200, blockRead: 300, blockWrite: 400 }),
      row(10 * SEC, { netRx: 1100, netTx: 2200, blockRead: 3300, blockWrite: 4400 }),
    ]);
    assert.equal(rows[1].netRxRate, 100);
    assert.equal(rows[1].netTxRate, 200);
    assert.equal(rows[1].blockReadRate, 300);
    assert.equal(rows[1].blockWriteRate, 400);
  });

  await t.test('reports null when a counter goes backwards (container restarted, counters reset)', () => {
    const rows = withIoRates([row(0, { netRx: 900_000 }), row(15 * SEC, { netRx: 1200 })]);
    assert.equal(rows[1].netRxRate, null);
  });

  await t.test('uses the real gap between buckets, so a hole in the data is not read as a spike', () => {
    // An hour with no samples (server down) followed by a bucket whose counter has grown by 3600
    // bytes: that is 1 B/s over the hour that actually passed, not 240 B/s over one 15s bucket.
    const rows = withIoRates([row(0, { netRx: 0 }), row(3600 * SEC, { netRx: 3600 })]);
    assert.equal(rows[1].netRxRate, 1);
  });

  await t.test('carries the rest of each row through untouched', () => {
    const rows = withIoRates([row(0), row(15 * SEC)]);
    assert.equal(rows[0].cpuPerc, 1);
    assert.equal(rows[1].bucket, 15 * SEC);
    assert.equal(rows[1].netRxTotal, 0);
  });

  await t.test('does not mutate the rows it was given', () => {
    const input = [row(0), row(15 * SEC, { netRx: 150 })];
    withIoRates(input);
    assert.equal('netRxRate' in input[1], false);
  });
});
