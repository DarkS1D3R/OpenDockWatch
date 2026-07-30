export const POLL_MS = 5000;
// Ceiling for the poll loop's failure backoff. A host that has been unreachable for an hour is
// not worth six requests every five seconds, and the retries are what keep the connection pool
// churning while nothing can succeed - but the loop must never stop entirely, or the dashboard
// would sit on stale data after the host comes back.
export const MAX_POLL_BACKOFF_MS = 60_000;
// How often the loop re-checks while the tab is in the background. It does no fetching at all
// then (visibilitychange wakes it the moment the tab is looked at again); this is only so a tab
// that was hidden before a host was selected still comes to life on its own.
export const HIDDEN_POLL_MS = 30_000;
export const MAX_LOG_LINES = 3000;
export const PREVIEW_TAIL = 100;
export const METRICS_HISTORY_LEN = 24;
export const HOST_METRICS_HISTORY_LEN = 120;
export const MAX_ACTIVITY_EVENTS = 500;

// How many buckets each history range covers, i.e. its window divided by its bucket width - these
// mirror HISTORY_RANGES in server/index.js and have to be kept in step with it. Used as the
// metrics modal's chart width in slots, so a series shorter than the window (a container created
// ten minutes ago) draws in the right-hand part of the chart instead of stretching across the
// whole of it.
export const HISTORY_RANGE_SLOTS = {
  '1h': 240, // 1h / 15s
  '24h': 288, // 24h / 5m
  '7d': 336, // 7d / 30m
};
