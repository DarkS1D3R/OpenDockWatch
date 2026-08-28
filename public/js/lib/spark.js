// Pure sparkline math shared by the CPU/RAM host-usage tiles (see app.js's cpu*/mem*/host*
// computed properties, and SparkTile once that component exists) - no Vue, no DOM.

// Left-pads a samples array with nulls so it always renders at a fixed width of `len` slots
// (instead of stretching however-many samples currently exist across the full chart width),
// so a fresh poll extends the line in place rather than reflowing every existing point.
export function padSlots(samples, len) {
  const pad = len - samples.length;
  return pad > 0 ? [...Array(pad).fill(null), ...samples] : samples;
}

// x/y (in the 100x30 viewBox) plus the raw value for one sample - shared by sparkPaths (draws
// the whole line) and hoverPoints (one point on demand at whatever index the mouse is over), so
// both agree on exactly the same coordinate mapping.
export function sparkPoint(slots, peak, i) {
  const w = 100;
  const h = 30;
  const topPad = 3;
  const usable = h - topPad;
  const v = slots[i];
  if (v === null || v === undefined) return null;
  const n = slots.length;
  const x = n > 1 ? (i / (n - 1)) * w : w;
  const y = peak ? topPad + usable - (v / peak) * usable : h;
  return { x, y, v };
}

export function sparkPaths(slots, peak) {
  const h = 30;
  const pts = [];
  for (let i = 0; i < slots.length; i++) {
    const p = sparkPoint(slots, peak, i);
    if (p) pts.push(p);
  }
  if (!pts.length) return { line: '', area: '', dot: null };
  const line = 'M' + pts.map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' L');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area = `${line} L${last.x.toFixed(2)},${h} L${first.x.toFixed(2)},${h} Z`;
  return { line, area, dot: { x: last.x, y: last.y } };
}

// One point on each of a tile's two lines at the same hovered index - null fields when a series
// has no value there (before it started sampling, or a remote host with no host-total). Named by
// position, not meaning, since the caller decides: host total behind Docker, tx behind rx, etc.
export function hoverPoints(idx, primarySlots, secondarySlots, peak) {
  if (idx == null) return null;
  const primary = sparkPoint(primarySlots, peak, idx);
  const secondary = sparkPoint(secondarySlots, peak, idx);
  if (!primary && !secondary) return null;
  return { x: (primary || secondary).x, primary, secondary };
}

// Picks up to `count` evenly-spaced indices into a padded slots array for x-axis ticks, skipping
// still-null slots and de-duping - a freshly-selected host would otherwise ask for several ticks
// rounding to the same early index. Returns indices only; the caller decides formatting/mapping.
export function axisTickIndices(slots, count) {
  const n = slots.length;
  if (!n || count < 1) return [];
  const indices = [];
  for (let k = 0; k < count; k++) {
    const i = count > 1 ? Math.round((k / (count - 1)) * (n - 1)) : n - 1;
    if (slots[i] !== null && slots[i] !== undefined && !indices.includes(i)) indices.push(i);
  }
  return indices;
}

// Places bucketed samples at their real position in the window instead of padSlots' count-based
// left-pad, which silently treats a missing bucket as "history hadn't started yet": the server's
// GROUP BY emits no row for a bucket with no samples, so a collector outage shrank the left pad
// and squashed the hole. Falls back to padSlots for an unbucketed series. See public/CLAUDE.md.
export function alignSlots(samples, sampleTimes, slotCount, bucketMs) {
  if (!bucketMs || !samples.length || !sampleTimes || sampleTimes.length !== samples.length) {
    return padSlots(samples, slotCount);
  }
  // The newest bucket holds the right edge, exactly as padSlots put the newest sample there - so
  // the window is anchored to the data, not to a clock this pure function would have to read.
  const anchor = sampleTimes[sampleTimes.length - 1];
  if (!Number.isFinite(anchor)) return padSlots(samples, slotCount);
  const slots = Array(slotCount).fill(null);
  for (let i = 0; i < samples.length; i++) {
    const ts = sampleTimes[i];
    if (!Number.isFinite(ts)) continue;
    const idx = slotCount - 1 - Math.round((anchor - ts) / bucketMs);
    if (idx >= 0 && idx < slotCount) slots[idx] = samples[i];
  }
  return slots;
}

// The time axis alignSlots implies: every slot gets a timestamp, including the ones no sample
// landed in. Ticks then sit at even intervals labelled with the time actually under them, rather
// than being spaced by array index over gap-collapsed data.
export function slotTimes(anchorTs, slotCount, bucketMs) {
  if (!bucketMs || !Number.isFinite(anchorTs)) return [];
  return Array.from({ length: slotCount }, (_, i) => anchorTs - (slotCount - 1 - i) * bucketMs);
}
