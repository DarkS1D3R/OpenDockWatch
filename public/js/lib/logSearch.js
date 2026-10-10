import { buildLineMatcher, highlightLine, parseLineTsMs } from '../format.js';

// The Logs tab's compose-wide search (LogSearchPanel): how far back to look. The server caps it at
// 7 days; an hour is the default because tracing a request usually starts from something recent.
export const SEARCH_WINDOWS = [
  { minutes: 15, label: 'Last 15 min' },
  { minutes: 60, label: 'Last hour' },
  { minutes: 360, label: 'Last 6 hours' },
  { minutes: 1440, label: 'Last 24 hours' },
  { minutes: 10080, label: 'Last 7 days' },
];
export const DEFAULT_SEARCH_MINUTES = 60;

// One row per match, oldest first as the server sends them, with the query highlighted. The
// matcher is built once for the whole list, the same as LogViewer's own filter does per render.
export function searchRows(matches, query) {
  const matcher = buildLineMatcher(query);
  return matches.map((m, i) => ({
    id: i,
    containerId: m.containerId,
    containerName: m.containerName,
    tsMs: parseLineTsMs(m.line),
    html: highlightLine(m.line, query, false, matcher),
  }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;
const containers = (n) => `${n} container${n === 1 ? '' : 's'}`;

// The line above the results: how much matched, and whether the list is the whole answer.
export function searchSummary(result) {
  if (!result.matched) return `No matches in ${containers(result.searched)}`;
  const head = `${plural(result.matched, 'match')} in ${containers(result.searched)}`;
  return result.truncated ? `${head} - showing the newest ${result.matches.length}` : head;
}

// What the results can't vouch for: a container that failed outright has no matches listed at all,
// and one that timed out only has the matches it reached before the deadline.
export function searchWarnings(result) {
  const out = [];
  for (const f of result.failed || []) out.push(`${f.containerName}: ${f.error}`);
  if ((result.timedOut || []).length) out.push(`Timed out before finishing, results may be partial: ${result.timedOut.join(', ')}`);
  return out;
}
