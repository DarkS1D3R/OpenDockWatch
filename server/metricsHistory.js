const { computeRate } = require('./docker');

// Floors `ts` to its `@bucketMs`-wide window for GROUP BY. Written with `%` not `(ts/@bucketMs)*
// @bucketMs`: better-sqlite3 binds numbers as REAL and SQLite's `/` is float division then, so
// that form divides and re-multiplies back to `ts`, grouping nothing. See CLAUDE.md for the gotcha.
const BUCKET_EXPR = 'ts - (ts % @bucketMs)';

// container_metrics's net/block columns are cumulative counters, not per-poll deltas - plotted
// raw they only ever rise. `rows` is bucketed history ordered by `bucket` ASC; elapsed time comes
// from the real gap between buckets so a data hole doesn't invent a spike. See CLAUDE.md.
const COUNTERS = [
  ['netRxTotal', 'netRxRate'],
  ['netTxTotal', 'netTxRate'],
  ['blockReadTotal', 'blockReadRate'],
  ['blockWriteTotal', 'blockWriteRate'],
];

function withIoRates(rows) {
  return rows.map((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const elapsedSec = prev ? (row.bucket - prev.bucket) / 1000 : null;
    const out = { ...row };
    for (const [totalKey, rateKey] of COUNTERS) {
      out[rateKey] = prev ? computeRate(row[totalKey], prev[totalKey], elapsedSec) : null;
    }
    return out;
  });
}

module.exports = { withIoRates, BUCKET_EXPR };
