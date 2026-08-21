// The Activity tab's two columns each filter on two independent things, and the whole point of
// this module is that they stay independent. `search` is the free-text box: a case-insensitive
// substring match across a few fields. `rule`/`action` is a badge click: an exact match on the one
// field the badges group by. See public/CLAUDE.md for why folding the second into the first didn't work.

// Both return { searched, shown }. `searched` is the text search alone - what the badges are
// counted off, so every badge stays visible and clickable while one of them is active. `shown` is
// that narrowed by the badge filter, and is what the list renders.
function split(items, search, matchesSearch, key, keyOf) {
  const q = search.trim().toLowerCase();
  const searched = q ? items.filter((item) => matchesSearch(item, q)) : items;
  return { searched, shown: key ? searched.filter((item) => keyOf(item) === key) : searched };
}

export function filterAlerts(alerts, { search = '', rule = '' } = {}) {
  return split(
    alerts,
    search,
    (a, q) =>
      (a.rule || '').toLowerCase().includes(q) ||
      (a.message || '').toLowerCase().includes(q) ||
      (a.containerName || '').toLowerCase().includes(q),
    rule,
    (a) => a.rule
  );
}

export function filterEvents(events, { search = '', action = '' } = {}) {
  return split(
    events,
    search,
    (e, q) => (e.containerName || e.containerId || '').toLowerCase().includes(q) || (e.action || '').toLowerCase().includes(q),
    action,
    (e) => e.action
  );
}
