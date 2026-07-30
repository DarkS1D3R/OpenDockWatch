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

// EventSource reconnects on its own after any disconnect, forever, and the server side of this
// spawns a `docker logs` process per connection. For a container that no longer exists that's a
// loop with no exit: the CLI finds nothing and quits, the server ends the response, the browser
// reconnects a few seconds later, repeat for as long as the panel stays open - a permanent drip
// of child processes and a connection slot never released. Genuine restarts reconnect inside
// this budget (any line received resets the count); only a stream that can't produce a single
// line across this many attempts is given up on.
const MAX_CONSECUTIVE_ERRORS = 5;

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
  let errorCount = 0;

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
    errorCount = 0;
    onLoadingChange(true);
    // A container with no log output at all would otherwise never clear the spinner, since that
    // only happens once a line actually arrives.
    loadingTimer = setTimeout(() => onLoadingChange(false), loadingTimeoutMs);
    source = new EventSourceImpl(url);
    source.onmessage = (e) => {
      errorCount = 0;
      queueLine(e.data);
    };
    source.onerror = () => {
      errorCount++;
      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        queueLine('[opendockwatch] log stream stopped after repeated disconnects - reopen to retry');
        // Only the source, not stop() - that discards the buffer, taking the line just queued
        // above with it, and the user would be left with a silently dead pane and no explanation.
        closeSource();
        return;
      }
      queueLine('[opendockwatch] log stream disconnected');
    };
  }

  function closeSource() {
    clearTimeout(loadingTimer);
    if (source) {
      source.close();
      source = null;
    }
  }

  function stop() {
    buffer = [];
    flushPending = false;
    closeSource();
  }

  return { start, stop };
}
