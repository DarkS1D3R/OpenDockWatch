// Shared EventSource-backed log line stream: connection lifecycle, non-reactive line buffering,
// rAF-batched flush, and the "no output yet" loading-spinner timer. A fast burst of lines (e.g. a
// large tail on open) used to trigger its own reactive push + render per line - on a big backlog
// that was thousands of full-list re-renders in a row and froze the tab. Buffering them and
// flushing once per animation frame turns that into a handful of renders.
//
// The caller owns the reactive line array and scroll behavior - onFlush(batch) hands over
// {id, text} objects to append; trimming to a max line count and following the scroll position
// are the caller's concern, same as before this was extracted.
//
// EventSourceImpl and schedule are injectable so this - otherwise only exercisable in a real
// browser - gets a node unit test with a stub source and a synchronous scheduler.
const defaultSchedule = (cb) => requestAnimationFrame(cb);

export function createLogStream({
  url,
  onFlush,
  onLoadingChange,
  EventSourceImpl = EventSource,
  schedule = defaultSchedule,
  loadingTimeoutMs = 2000,
}) {
  let buffer = [];
  let flushPending = false;
  let nextId = 0;
  let loadingTimer = null;
  let source = null;

  function queueLine(text) {
    buffer.push(text);
    if (flushPending) return;
    flushPending = true;
    schedule(flush);
  }

  function flush() {
    flushPending = false;
    const pending = buffer;
    buffer = [];
    if (!pending.length) return;
    clearTimeout(loadingTimer);
    onLoadingChange(false);
    onFlush(pending.map((text) => ({ id: nextId++, text })));
  }

  function start() {
    stop();
    nextId = 0;
    onLoadingChange(true);
    // A container with no log output at all would otherwise never clear the spinner, since that
    // only happens once a line actually arrives.
    loadingTimer = setTimeout(() => onLoadingChange(false), loadingTimeoutMs);
    source = new EventSourceImpl(url);
    source.onmessage = (e) => queueLine(e.data);
    source.onerror = () => queueLine('[opendockwatch] log stream disconnected');
  }

  function stop() {
    clearTimeout(loadingTimer);
    buffer = [];
    flushPending = false;
    if (source) {
      source.close();
      source = null;
    }
  }

  return { start, stop };
}
