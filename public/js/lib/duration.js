// Pure display formatting for the Uptime report - see public/js/components/UptimeReport.js. Split
// out of the component for the same reason format.js's other formatters are: no DOM dependency,
// so it's unit-tested directly instead of only reachable through a mounted component.

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms === 0) return '0m';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  // Minutes are dropped once the duration spans whole days - "2d 14m" is noise nobody reads a
  // 30-day rollup to the minute for, and it would make the column width unpredictable.
  if (!days && minutes) parts.push(`${minutes}m`);
  return parts.length ? parts.join(' ') : '0m';
}

export function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}
