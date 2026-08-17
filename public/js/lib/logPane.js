// The log pane's pure chrome logic, pulled out of LogViewer.js so it can be unit-tested: the
// match strip's resize arithmetic, the space-to-pause predicate, and the status badge. None of it
// touches the DOM - callers measure and pass the numbers in. See CLAUDE.md.

// Clamped and rounded to whole pixels. Order matters and matches what the drag always did: the
// floor is applied first, so a window too short to satisfy both bounds yields maxHeight rather
// than a strip taller than the space that exists for it.
export function clampPaneHeight(height, { minHeight, maxHeight }) {
  return Math.round(Math.min(maxHeight, Math.max(minHeight, height)));
}

// How tall the strip may grow right now: what it already occupies, plus what the log body can give
// up above minBodyHeight. Measured rather than declared in CSS - neither a px nor a vh cap can be
// right for both panel modes, and the body yields to zero on its own. See CLAUDE.md.
export function maxPaneHeight({ paneHeight, bodyHeight, minBodyHeight }) {
  return paneHeight + Math.max(0, bodyHeight - minBodyHeight);
}

// The strip is anchored to the bottom of the panel and dragged by its TOP edge, so moving the
// pointer up has to make it taller - the delta is subtracted, not added. Getting this backwards is
// exactly why the browser's native bottom-right resize corner was the wrong affordance here.
export function dragHeight({ startHeight, startY, clientY, minHeight, maxHeight }) {
  return clampPaneHeight(startHeight - (clientY - startY), { minHeight, maxHeight });
}

const TYPING_TAGS = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'];

// The listener is on `document` so a pane needs no focus first, which is why this has to be
// careful: it is the only thing stopping space from failing to type in the filter box, failing to
// press a focused button, or scrolling the page out from under the log.
export function shouldTogglePause(event, { multiPane = false, hovered = false } = {}) {
  if (event.key !== ' ' && event.code !== 'Space') return false;
  // Any modifier held means the user meant something else entirely.
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  if (target && (target.isContentEditable || TYPING_TAGS.includes(target.tagName))) return false;
  // Every open pane carries the listener, so in multi-pane the hovered one takes the press - one
  // space would otherwise pause all four at once. A lone pane needs no hover.
  return !multiPane || hovered;
}

// One badge, always rendered: "active" only reads as a state because it sits where the paused ones
// do. Manual pause outranks suspension - if the user paused it, that is the answer to "why isn't
// this moving".
export function statusBadge({ paused, suspended, pendingCount = 0 }) {
  if (paused) {
    return {
      cls: 'log-status-paused',
      text: `⏸ paused${pendingCount ? ' · ' + pendingCount + ' held' : ''}`,
      title: 'Paused - new lines are being held. Press space (or click Resume) to catch up.',
    };
  }
  if (suspended) {
    return {
      cls: 'log-status-suspended',
      text: '⏸ suspended',
      title: 'Paused while this tab was in the background - it resumes from the latest lines when you come back',
    };
  }
  return { cls: 'log-status-active', text: '▶ active', title: 'Streaming live - press space to pause' };
}
