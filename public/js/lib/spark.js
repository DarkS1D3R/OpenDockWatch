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

// One point on the Docker line and one on the host-total line at the same hovered index - null
// fields (rather than a null point) when a series has no value there, e.g. hovering an index
// from before host-total sampling started, or on a remote host with no host data at all.
export function hoverPoints(idx, dockerSlots, hostSlots, peak) {
  if (idx == null) return null;
  const docker = sparkPoint(dockerSlots, peak, idx);
  const host = sparkPoint(hostSlots, peak, idx);
  if (!docker && !host) return null;
  return { x: (docker || host).x, docker, host };
}
