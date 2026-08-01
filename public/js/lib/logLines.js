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
// cached baseHtml; with one, highlightLine reruns only for matches. A line whose level was never
// detected is always kept. An invalid regex matches everything (not nothing) so a half-typed pattern doesn't blank the pane.
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
