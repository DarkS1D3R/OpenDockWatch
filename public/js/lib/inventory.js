// Pure helpers for the Resources tab (components/ResourcesView.js), split out so they're
// unit-tested without mounting the component.

export function imageLabel(img) {
  if (!img.repository) return `<none> (${img.id})`;
  return `${img.repository}:${img.tag || '<none>'}`;
}

// Anonymous volumes are named by a 64-hex id; the first 12 are enough to tell them apart.
export function volumeLabel(vol) {
  return /^[0-9a-f]{64}$/.test(vol.name) ? vol.name.slice(0, 12) : vol.name;
}

// Count, total size and what the unused ones add up to. For images the unused figure is their
// unique size - shared layers stay on disk while any other image still needs them.
export function summarize(section, rows) {
  const list = rows || [];
  const unused = list.filter((r) => r.unused);
  const sum = (items, key) => items.reduce((s, r) => s + (r[key] || 0), 0);
  if (section === 'images') {
    return { count: list.length, bytes: sum(list, 'sizeBytes'), unused: unused.length, unusedBytes: sum(unused, 'uniqueBytes') };
  }
  if (section === 'volumes') {
    return { count: list.length, bytes: sum(list, 'sizeBytes'), unused: unused.length, unusedBytes: sum(unused, 'sizeBytes') };
  }
  return { count: list.length, bytes: null, unused: unused.length, unusedBytes: null };
}

function haystack(section, r) {
  if (section === 'images') return [imageLabel(r), r.id];
  if (section === 'volumes') return [r.name, r.composeProject, r.driver];
  return [r.name, r.composeProject, r.driver, ...(r.containers || [])];
}

// Case-insensitive substring over the row's names, the same matching the other tabs' filters use.
export function filterRows(section, rows, { query = '', unusedOnly = false } = {}) {
  const q = query.trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (unusedOnly && !r.unused) return false;
    if (!q) return true;
    return haystack(section, r).some((v) => v && String(v).toLowerCase().includes(q));
  });
}
