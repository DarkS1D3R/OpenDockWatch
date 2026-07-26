export const POLL_MS = 5000;
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
