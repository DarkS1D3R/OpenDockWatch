// Pure helpers for panning a bucketed history chart (host card fullscreen, container metrics
// modal) back and forward by one window. `untilMs` is the window's exclusive end; null means the
// window ends now and keeps following live data. See docs/architecture/frontend.md.

// One whole window per step, landing on bucket boundaries so consecutive pages tile exactly.
// A step that would reach the present returns null, back to the live-following window.
export function panUntil(untilMs, direction, windowMs, bucketMs, nowMs) {
  if (!windowMs || !bucketMs || !Number.isFinite(nowMs)) return null;
  const end = untilMs == null ? Math.ceil(nowMs / bucketMs) * bucketMs : untilMs;
  const next = end + Math.sign(direction) * windowMs;
  return next >= nowMs ? null : next;
}

// The bucket timestamp the chart's right edge stands for: the last whole bucket before untilMs.
// Null for a live window, which keeps anchoring on its newest sample instead.
export function windowAnchorTs(untilMs, bucketMs) {
  if (untilMs == null || !bucketMs) return null;
  return untilMs - bucketMs;
}

// "09:00 – 10:00, 1 Nov" style text for the pan strip; the day is spelled out on both sides
// only when the window crosses midnight.
export function windowLabel(untilMs, windowMs, locale) {
  if (untilMs == null) return 'Now';
  const start = new Date(untilMs - windowMs);
  const end = new Date(untilMs);
  const time = { hour: '2-digit', minute: '2-digit' };
  const day = { day: 'numeric', month: 'short' };
  if (start.toDateString() === end.toDateString()) {
    return `${start.toLocaleTimeString(locale, time)} – ${end.toLocaleTimeString(locale, time)}, ${end.toLocaleDateString(locale, day)}`;
  }
  const both = { ...day, ...time };
  return `${start.toLocaleString(locale, both)} – ${end.toLocaleString(locale, both)}`;
}
