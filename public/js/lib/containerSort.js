import { parseMemUsedBytes } from '../format.js';

// How the List view orders the containers inside each compose group. Pure so the ordering rules -
// above all, where a container with nothing to compare goes - are unit-tested, not left to a browser.

export const SORT_KEYS = ['name', 'cpu', 'mem', 'restarts'];

// The direction a key starts in when first picked: a name reads A-Z, the others are "which is worst".
export const DEFAULT_SORT_DIR = { name: 'asc', cpu: 'desc', mem: 'desc', restarts: 'desc' };

// null means "nothing to compare" - a stopped container has no stats row, and a row that arrives
// with an unreadable figure should not be sorted as though it used 0.
export function sortValue(key, container, stat) {
  if (key === 'name') return container.name.toLowerCase();
  if (key === 'restarts') return container.restartCount1h || 0;
  if (!stat) return null;
  if (key === 'cpu') {
    const n = parseFloat(stat.cpuPerc);
    return Number.isFinite(n) ? n : null;
  }
  if (key === 'mem') {
    const n = parseMemUsedBytes(stat.memUsage);
    return Number.isFinite(n) && stat.memUsage ? n : null;
  }
  return null;
}

// A new array in the requested order, or `items` itself when no sort is chosen (docker's own order).
// Containers with no value always go last, in either direction - flipping to ascending must not
// float the stopped ones to the top. Ties fall back to name so the order is stable between polls.
export function sortContainers(items, sort, stats = {}) {
  if (!sort || !SORT_KEYS.includes(sort.key)) return items;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const byName = (a, b) => a.name.localeCompare(b.name);
  return items
    .map((c) => ({ c, v: sortValue(sort.key, c, stats[c.id]) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) {
        if (a.v === b.v) return byName(a.c, b.c);
        return a.v === null ? 1 : -1;
      }
      const cmp = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
      return cmp ? cmp * sign : byName(a.c, b.c);
    })
    .map((x) => x.c);
}

// Whatever came out of storage, as a sort the list can use - or null. Hand-editable, so anything
// that is not a known key and direction is dropped rather than trusted.
export function normalizeSort(raw) {
  if (!raw || typeof raw !== 'object' || !SORT_KEYS.includes(raw.key)) return null;
  return { key: raw.key, dir: raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : DEFAULT_SORT_DIR[raw.key] };
}

const STORAGE_KEY = 'odw:list:sort';

// localStorage rather than sessionStorage: how someone likes their list ordered is a standing
// preference, unlike the Logs tab's "what I was just reading" selection.
export function loadSort(storage = globalThis.localStorage) {
  try {
    return normalizeSort(JSON.parse(storage.getItem(STORAGE_KEY)));
  } catch {
    return null;
  }
}

export function saveSort(sort, storage = globalThis.localStorage) {
  try {
    if (sort) storage.setItem(STORAGE_KEY, JSON.stringify(sort));
    else storage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable - the sort just won't be remembered */
  }
}
