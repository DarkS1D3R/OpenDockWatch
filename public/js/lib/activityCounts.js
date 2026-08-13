// Counts for the Activity tab's header badges: how many of each kind of alert (by rule) and each
// kind of event (by action) are in the list being shown. Pure, so it's unit-tested rather than
// only syntax-checked - see CLAUDE.md on what earns a place in lib/.

// Groups by keyOf and counts, highest first. The `|| a.key.localeCompare(b.key)` tie-break is the
// part that matters: without it two kinds on the same count swap places as new rows stream in, and
// a row of badges that reshuffles while you read it is worse than no badges. `limit` keeps a busy
// host from turning the header into a wall - the remainder comes back as `hidden` for a "+N" badge.
export function groupCounts(items, keyOf, { limit = 6, metaOf = null } = {}) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null || key === '') continue;
    let entry = map.get(key);
    if (!entry) {
      entry = { key, count: 0, meta: metaOf ? metaOf(item) : null };
      map.set(key, entry);
    }
    entry.count++;
  }
  const all = [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const hidden = all.slice(limit);
  return {
    shown: all.slice(0, limit),
    hidden,
    hiddenTotal: hidden.reduce((sum, e) => sum + e.count, 0),
    total: items.length,
  };
}
