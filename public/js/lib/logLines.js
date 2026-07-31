import { detectLogLevel, stripAnsi, highlightLine, parseLineTsMs } from '../format.js';

// Per-line work for the log views, split into the part that can be done once and the part that
// genuinely depends on the current filter.
//
// The reason this exists: LogViewer's `filteredLines` used to derive a line's level, timestamp and
// highlighted HTML on every recompute, and a recompute happens every time a line arrives - so a
// pane holding MAX_LOG_LINES re-derived all of it for 3000 lines several times a second. Measured
// against the real format.js at 3000 lines: highlightLine 2.32ms, parseLineTsMs 0.99ms,
// detectLogLevel(stripAnsi()) 0.55ms, ~4.4ms per recompute all told - which four panes streaming
// side by side turns into ~17.7ms a frame, past the 16.7ms a 60fps frame has to spend. None of the
// three depends on the filter, and none of them can change for the life of a line, so they belong
// at append time instead: decorateLine pays for a line once, when it arrives.
//
// ContainerDetail had a worse version of the same problem - it called highlightLine from a *method*
// in its template, so the work re-ran on every render of the component, including the one the 5s
// stats poll triggers, whether or not a single log line had arrived.
//
// Pure and dependency-free (format.js is itself pure), so it's unit-tested directly rather than
// only exercised through a browser - see CLAUDE.md on preferring public/js/lib/ for logic pulled
// out of components.

// `baseHtml` is the no-filter rendering, which is what the overwhelming majority of renders want:
// you type a filter occasionally, you watch logs stream constantly.
export function decorateLine(line) {
  return {
    id: line.id,
    text: line.text,
    tsMs: parseLineTsMs(line.text),
    level: detectLogLevel(stripAnsi(line.text)),
    baseHtml: highlightLine(line.text, '', false),
  };
}

export function decorateLines(lines) {
  return lines.map(decorateLine);
}

// Filter + render, over lines already through decorateLine.
//
// With no filter text every surviving line reuses its cached baseHtml and nothing is recomputed.
// With a filter, highlightLine has to run again (the <mark> spans depend on the search term) - but
// only for the lines that actually matched, which is the small set by definition. `levels` is the
// level→boolean map the viewer's level toggles produce; a line whose level was never detected
// (null) is always kept, since there's no toggle it could belong to.
//
// An invalid regex (testRegex null while regexMode is on) deliberately matches everything rather
// than nothing - the viewer shows an "Invalid regex" warning next to the input, and blanking the
// pane while someone is halfway through typing a pattern would be worse than leaving it be.
export function selectLines(lines, { levels = null, filterText = '', regexMode = false, testRegex = null } = {}) {
  const filtering = filterText.length > 0;
  const filterLower = filterText.toLowerCase();
  const highlightRegex = regexMode && !!testRegex;
  const out = [];
  for (const line of lines) {
    if (line.level && levels && !levels[line.level]) continue;
    if (filtering) {
      if (regexMode) {
        if (testRegex && !testRegex.test(line.text)) continue;
      } else if (!line.text.toLowerCase().includes(filterLower)) continue;
    }
    out.push({
      id: line.id,
      html: filtering ? highlightLine(line.text, filterText, highlightRegex) : line.baseHtml,
      tsMs: line.tsMs,
    });
  }
  return out;
}
