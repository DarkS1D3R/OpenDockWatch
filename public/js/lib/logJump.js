// The Log Viewer's "Go to time" picker: presets, and turning a <input type="datetime-local"> value
// into a timestamp and back. Pure, so it is unit-tested without a component.

export const JUMP_PRESETS = [
  { label: '5m ago', ms: 5 * 60_000 },
  { label: '15m ago', ms: 15 * 60_000 },
  { label: '1h ago', ms: 60 * 60_000 },
  { label: '6h ago', ms: 6 * 60 * 60_000 },
  { label: '24h ago', ms: 24 * 60 * 60_000 },
];

const pad = (n) => String(n).padStart(2, '0');

// "2026-10-12T14:05:09" in the browser's local time - the only form datetime-local accepts.
export function toLocalInputValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// Read as local time, as the picker shows it. Parsed by hand: Date.parse's handling of a string
// with no zone has differed between engines. null for anything that is not a real date and time.
export function parseLocalInputValue(value) {
  const m = LOCAL_RE.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0'] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // Rolls over silently otherwise: 2026-02-31 would become 3 March.
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return date.getTime();
}

// "UTC+02:00" - the picker is in local time while docker's timestamps are UTC, so it says which.
export function utcOffsetLabel(ms) {
  const minutes = -new Date(ms).getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Why a picked time can't be used, or null when it can.
export function jumpError(ms, now = Date.now()) {
  if (ms === null || !Number.isFinite(ms)) return 'Enter a date and time';
  if (ms > now) return 'That time is in the future';
  return null;
}
