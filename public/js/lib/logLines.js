import { detectLogLevel, stripAnsi, highlightLine, parseLineTsMs } from '../format.js';

// Per-line work for the log views, split into the part done once (decorateLine, at append) and
// the part that depends on the current filter (selectLines). See CLAUDE.md for the perf numbers
// behind why this exists - the ContainerDetail regression that made it worth fixing everywhere.

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

// Filter + render over lines already through decorateLine. With no filter, every line reuses its
// cached baseHtml; with one, highlightLine reruns only for actual matches - never for a line kept
// only by hideNonMatching:false, which reuses baseHtml same as the no-filter case. A line whose
// level was never detected is always kept. An invalid regex matches everything (not nothing) so a
// half-typed pattern doesn't blank the pane. `hideNonMatching:false` keeps every line (LogViewer's
// "reveal" mode, after clicking a hit - see CLAUDE.md) while still reporting `isMatch` per line, so
// the hits box and the click-to-reveal behavior can tell an actual hit from context around it.
export function selectLines(lines, { levels = null, filterText = '', regexMode = false, testRegex = null, hideNonMatching = true } = {}) {
  const filtering = filterText.length > 0;
  const filterLower = filterText.toLowerCase();
  const highlightRegex = regexMode && !!testRegex;
  const out = [];
  for (const line of lines) {
    if (line.level && levels && !levels[line.level]) continue;
    const isMatch = filtering && (regexMode ? !testRegex || testRegex.test(line.text) : line.text.toLowerCase().includes(filterLower));
    if (filtering && hideNonMatching && !isMatch) continue;
    out.push({
      id: line.id,
      html: isMatch ? highlightLine(line.text, filterText, highlightRegex) : line.baseHtml,
      tsMs: line.tsMs,
      isMatch,
    });
  }
  return out;
}

// The Log Viewer's search cursor is a line *id*, never a position. A pane tailing at
// MAX_LOG_LINES trims from the front, so every drop shifts an index by one and it silently comes
// to name a different line - the highlight walks the hit list on its own. See CLAUDE.md.
export function hitIndexFor(lines, activeId) {
  if (!lines.length) return -1;
  if (activeId == null) return 0;
  const i = lines.findIndex((l) => l.id === activeId);
  // The parked-on line aged out of the buffer or was filtered away - fall back to the first hit,
  // which is at least somewhere the user can see, rather than to whatever now sits at its index.
  return i === -1 ? 0 : i;
}

// Steps the cursor by delta with wraparound, returning the newly selected line id (null when
// there are no hits to move between). Reads the current position through hitIndexFor, so stepping
// off a hit that just aged out continues from the fallback rather than from a stale index.
export function stepHitId(lines, activeId, delta) {
  if (!lines.length) return null;
  const next = (hitIndexFor(lines, activeId) + delta + lines.length) % lines.length;
  return lines[next].id;
}
