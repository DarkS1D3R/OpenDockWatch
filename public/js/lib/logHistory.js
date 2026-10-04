import { MAX_LOG_LINES, LOG_PAGE_LINES, LOG_WINDOW_LINES, SEEK_CONTEXT_MS } from '../constants.js';
import { decorateLines } from './logLines.js';

// The pure half of the log viewer's "All" option: how much to ask the stream for, how many lines a
// pane may hold, and how a page of history is spliced into a sliding window over the log.

// "All" starts from one page and pages through the rest; every other option is a plain tail.
export function streamTailFor(tail) {
  return tail === 'all' ? LOG_PAGE_LINES : tail;
}

// The cap has to follow the selection: a fixed 3000 silently trimmed 5000, 10000 and All back to
// 3000 lines, which is what made the larger options look like they fell back to a shorter one.
export function maxLinesFor(tail) {
  return tail === 'all' ? LOG_WINDOW_LINES : Math.max(MAX_LOG_LINES, tail);
}

// The `after` cursor that lands a window on `tsMs` with some context above it. toISOString is
// UTC with milliseconds, which is a valid docker log timestamp as far as the history route goes.
export function seekCursorFor(tsMs) {
  return new Date(tsMs - SEEK_CONTEXT_MS).toISOString();
}

const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) /;

export function timestampOf(text) {
  const m = DOCKER_TS_RE.exec(text);
  return m ? m[1] : null;
}

// The raw docker timestamps at either end of the window - the cursors the history route pages
// from. Null when there is no line, or it carries no timestamp, either of which ends paging there.
export function oldestTimestamp(lines) {
  return lines.length ? timestampOf(lines[0].text) : null;
}

export function newestTimestamp(lines) {
  return lines.length ? timestampOf(lines[lines.length - 1].text) : null;
}

// Ids are derived from the window's own ends rather than counted: the stream numbers its lines up
// from 0, older pages go below the first id and newer ones above the last, so keys stay unique and
// in order however the window has been trimmed or re-attached to the stream.
export function idBelow(lines) {
  return lines.length ? lines[0].id - 1 : -1;
}

export function idAbove(lines) {
  return lines.length ? lines[lines.length - 1].id + 1 : 0;
}

// An older page goes on the front. If that overflows `max`, the *newest* lines are what is dropped
// - the user is reading history, so the live end is the part they can afford to lose - and
// `droppedNewer` tells the caller the window no longer reaches the live tail.
export function prependPage(lines, texts, max) {
  const kept = texts.length > max ? texts.slice(texts.length - max) : texts;
  const base = idBelow(lines) - kept.length + 1;
  const page = decorateLines(kept.map((text, i) => ({ id: base + i, text })));
  const merged = page.concat(lines);
  const droppedNewer = Math.max(0, merged.length - max);
  return { lines: droppedNewer ? merged.slice(0, max) : merged, added: page.length, droppedNewer };
}

// The mirror image: a newer page goes on the back and the *oldest* lines are dropped to fit.
export function appendPage(lines, texts, max) {
  const base = idAbove(lines);
  const page = decorateLines(texts.map((text, i) => ({ id: base + i, text })));
  const merged = lines.concat(page);
  const droppedOlder = Math.max(0, merged.length - max);
  return { lines: droppedOlder ? merged.slice(droppedOlder) : merged, added: page.length, droppedOlder };
}
