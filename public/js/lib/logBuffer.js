// The append-and-cap the log panes do in three places: the visible line array, the off-screen
// buffer a paused pane holds new lines in, and the drain of one into the other on resume. Pure and
// shared rather than written out three times, because the invariant across all three is the point.

// Pushes every item, then trims from the front so the newest `max` survive - oldest-out, which is
// what a tailing log wants. Mutates and returns `buffer` (the callers own long-lived arrays and a
// copy per flush would be the expensive part of appending at MAX_LOG_LINES).
export function pushCapped(buffer, items, max) {
  for (const item of items) buffer.push(item);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
  return buffer;
}
