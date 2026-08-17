// Pure binary search backing the Logs tab's multi-pane scroll sync: given a chronologically
// sorted array of epoch-ms timestamps (entries may be null - unparseable/synthetic lines), find
// the index closest to `target`. Kept separate from LogViewer.js so this off-by-one-risky logic is unit-tested.
export function closestIndexByTs(tsMsArray, target) {
  if (!tsMsArray.length || target == null) return -1;

  let lo = 0;
  let hi = tsMsArray.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = tsMsArray[mid];
    if (v == null || v < target) lo = mid + 1;
    else hi = mid;
  }

  // lo is the first index whose value is >= target - but that value, and the one before it, may
  // themselves be null, so both directions need a nearest-non-null scan. "after" starts at lo
  // (inclusive), "before" at lo - 1, so an exact match at lo is never double-counted.
  const before = nearestNonNull(tsMsArray, lo - 1, -1);
  const after = nearestNonNull(tsMsArray, lo, 1);

  if (before === -1) return after;
  if (after === -1) return before;
  const beforeDist = Math.abs(target - tsMsArray[before]);
  const afterDist = Math.abs(tsMsArray[after] - target);
  return afterDist < beforeDist ? after : before;
}

function nearestNonNull(arr, fromIndex, step) {
  for (let i = fromIndex; i >= 0 && i < arr.length; i += step) {
    if (arr[i] != null) return i;
  }
  return -1;
}

// The other half of the same feature: closestIndexByTs answers "where do I scroll to", this
// answers "where am I now". Given the rendered line boxes' offsets, the last one that starts at or
// above scrollTop - i.e. the line at the top of the viewport, whose timestamp is what a pane
// broadcasts to its siblings. Returns -1 when nothing is rendered.
//
// Takes a lazy `offsetAt(i)` rather than an array because it runs on every frame of a drag scroll
// over a pane holding up to MAX_LOG_LINES lines: materialising the offsets would turn an O(log n)
// probe into an O(n) copy per frame, which is the cost this binary search exists to avoid.
export function topIndexByOffset(length, offsetAt, scrollTop) {
  if (!length) return -1;
  let lo = 0;
  let hi = length - 1;
  // Upper mid (`+ 1`), unlike closestIndexByTs above: this loop moves `lo` to `mid` rather than
  // `mid + 1`, so a lower mid would leave lo === mid when hi === lo + 1 and spin forever.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsetAt(mid) <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
