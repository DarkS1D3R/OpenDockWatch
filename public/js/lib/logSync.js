// Pure binary search backing the Logs tab's multi-pane scroll sync: given a chronologically
// sorted array of epoch-ms timestamps (entries may be null - a line with no parseable docker
// timestamp, e.g. a synthetic "[opendockwatch] log stream disconnected" notice), find the index
// of the entry closest to `target`. Kept separate from LogViewer.js (which owns the DOM reads/
// writes around it) so the actual search logic - the part with real off-by-one risk - is
// unit-tested without a browser.
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

  // lo is the first index whose value is >= target (or the array's end if none is) - but that
  // value, and the one right before it, may themselves be null, so both directions need a
  // nearest-non-null scan rather than assuming lo (or lo - 1) is directly usable. "after" starts
  // its scan at lo itself (inclusive) and "before" at lo - 1, so an exact match at lo is never
  // double-counted as its own "before" candidate.
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
