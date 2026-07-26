const { computeRate } = require('./docker');

// Floors a `ts` column to the start of its `@bucketMs`-wide window, for the history queries'
// GROUP BY. Written with `%` rather than the obvious `(ts / @bucketMs) * @bucketMs` for a reason
// worth knowing: better-sqlite3 binds every JavaScript number as REAL (`typeof(@bucketMs)` is
// 'real', not 'integer'), and SQLite's `/` is float division the moment either operand is REAL -
// so the division-based form divides and immediately re-multiplies back to exactly `ts`, and the
// GROUP BY silently groups nothing. That made every raw 5s sample its own "bucket": a 7d query
// answered with every sample in the retention window (~120k rows) instead of 336, and the host
// sparkline's 120 slots covered 10 minutes rather than the 30 its bucket width implies. `%` is
// immune - SQLite coerces both operands to INTEGER before applying it, however they were bound.
const BUCKET_EXPR = 'ts - (ts % @bucketMs)';

// `container_metrics`'s net_rx/net_tx/block_read/block_write columns hold docker stats' *cumulative*
// byte counters, not per-poll deltas - a month-old container just reads a larger number every poll
// forever. Averaging or plotting them directly produces a line that only ever rises, which says
// nothing about what the container was actually doing at any given moment. The signal is the rate
// of change between consecutive buckets, which is what this adds.
//
// `rows` is a bucketed history result ordered by `bucket` ASC (see db.js's
// containerMetricsHistory), each row carrying the counter's value at the end of its bucket
// (`MAX(...)`). Elapsed time comes from the real gap between bucket timestamps rather than the
// nominal bucket width, so a hole in the data - server restarted, host was unreachable - divides by
// the time that actually passed instead of inventing a spike out of a large delta over one bucket.
//
// computeRate is reused from docker.js rather than reimplemented: it already returns null for a
// negative delta, which here means the container restarted and its counters reset. Null is the
// honest answer for that bucket (and for the first row, which has nothing to diff against) - the
// sparkline skips null slots rather than drawing a fabricated zero or a negative rate.
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
