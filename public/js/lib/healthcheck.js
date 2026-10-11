// Wording for a container's healthcheck (server/docker.js parseHealthcheck) in the detail panel.
// Pure, so it is unit-tested without a component.

// "500ms", "5s", "1m 30s" - healthcheck intervals and run times are seconds, not the minutes
// formatDuration rounds to.
export function shortDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

// { text, tone } for the section heading; tone is 'ok' | 'warn' | 'bad' | 'muted'.
export function healthcheckSummary(hc) {
  if (!hc) return null;
  const streak = hc.failingStreak || 0;
  const inARow = streak === 1 ? 'last check failed' : `${streak} checks failed in a row`;
  if (hc.status === 'unhealthy') return { text: streak ? `Failing - ${inARow}` : 'Failing', tone: 'bad' };
  if (hc.status === 'healthy') return streak ? { text: `Passing, but ${inARow}`, tone: 'warn' } : { text: 'Passing', tone: 'ok' };
  if (hc.status === 'starting') return { text: streak ? `Starting - ${inARow}` : 'Starting', tone: 'warn' };
  return { text: 'No results yet', tone: 'muted' };
}

// "Every 30s, 5s timeout, unhealthy after 3 failures" (+ the start period when there is one).
export function healthcheckSchedule(hc) {
  if (!hc) return '';
  const parts = [
    `Every ${shortDuration(hc.intervalMs)}`,
    `${shortDuration(hc.timeoutMs)} timeout`,
    `unhealthy after ${hc.retries} failure${hc.retries === 1 ? '' : 's'}`,
  ];
  if (hc.startPeriodMs) parts.push(`${shortDuration(hc.startPeriodMs)} grace at start`);
  return parts.join(', ');
}

// Docker records a timed-out check as exit code -1 with its own message as the output.
export function checkResult(entry) {
  if (entry.exitCode === 0) return { text: 'Passed', tone: 'ok' };
  if (entry.exitCode === -1 || /^Health check exceeded timeout/.test(entry.output || '')) return { text: 'Timed out', tone: 'bad' };
  return { text: `Failed (exit ${entry.exitCode})`, tone: 'bad' };
}

// How long one check ran, from docker's nanosecond timestamps (Date.parse keeps the milliseconds).
export function checkRunTime(entry) {
  const ms = Date.parse(entry.end) - Date.parse(entry.start);
  return Number.isFinite(ms) && ms >= 0 ? shortDuration(ms) : '—';
}

export function checkAgo(entry, now = Date.now()) {
  const at = Date.parse(entry.start);
  if (!Number.isFinite(at)) return '';
  const ms = Math.max(0, now - at);
  return ms < 1000 ? 'just now' : `${shortDuration(ms)} ago`;
}
