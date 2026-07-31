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
// A stream also suspends itself while the tab is in the background - see HIDDEN_SUSPEND_GRACE_MS
// below. That's here rather than in each component because this factory is the one thing every log
// stream in the app already goes through.
//
// EventSourceImpl, schedule and doc are injectable so this - otherwise only exercisable in a real
// browser - gets a node unit test with a stub source, a synchronous scheduler and a fake document.
const defaultSchedule = (cb) => requestAnimationFrame(cb);
const defaultDoc = typeof document === 'undefined' ? null : document;

// EventSource reconnects on its own after any disconnect, forever, and the server side of this
// spawns a `docker logs` process per connection. For a container that no longer exists that's a
// loop with no exit: the CLI finds nothing and quits, the server ends the response, the browser
// reconnects a few seconds later, repeat for as long as the panel stays open - a permanent drip
// of child processes and a connection slot never released. Genuine restarts reconnect inside
// this budget (any line received resets the count); only a stream that can't produce a single
// line across this many attempts is given up on.
const MAX_CONSECUTIVE_ERRORS = 5;

// How long the tab has to stay hidden before an open stream gives up its connection. A backgrounded
// tab otherwise holds one browser connection *and* one server-side `docker logs -f` child per open
// stream indefinitely - and a dashboard is exactly the kind of page left open in a tab for days.
// The poll loop already stops itself when hidden (app.js's pollTick); this is the same idea for the
// streams.
//
// Not immediate, because resuming is not free: `docker logs --tail N` re-sends the tail, so a
// resume resets the pane (see onReset). Suspending the moment you glance at another tab would throw
// away four scroll-synced panes' positions for a two-second detour. A minute of genuine absence is
// a different thing, and by then the reset is what you'd want anyway.
const HIDDEN_SUSPEND_GRACE_MS = 60_000;

export function createLogStream({
  url,
  onFlush,
  onLoadingChange,
  onReset = () => {},
  onSuspendChange = () => {},
  EventSourceImpl = EventSource,
  schedule = defaultSchedule,
  doc = defaultDoc,
  loadingTimeoutMs = 2000,
  hiddenGraceMs = HIDDEN_SUSPEND_GRACE_MS,
}) {
  let buffer = [];
  let flushPending = false;
  let nextId = 0;
  let loadingTimer = null;
  let source = null;
  let errorCount = 0;
  let started = false;
  let suspended = false;
  let hiddenTimer = null;

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

  function openSource() {
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

  function start() {
    stop();
    started = true;
    attachVisibility();
    openSource();
  }

  // Gives the connection back without tearing the stream down - it stays "started", so it knows to
  // come back when the tab does. Deliberately not routed through the error path: a suspend is not a
  // disconnect and must not count against MAX_CONSECUTIVE_ERRORS, or a few background/foreground
  // cycles would permanently kill a perfectly healthy stream.
  function suspend() {
    if (!started || suspended) return;
    suspended = true;
    closeSource();
    onSuspendChange(true);
  }

  function resume() {
    if (!started || !suspended) return;
    suspended = false;
    // `docker logs --tail N` starts from the tail again, so whatever the caller is holding is about
    // to be duplicated by the reconnect. It clears first (and ids restart from 0 in openSource, so
    // they stay unique against an emptied list).
    buffer = [];
    flushPending = false;
    onReset();
    openSource();
    onSuspendChange(false);
  }

  function onVisibilityChange() {
    if (!doc) return;
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
    if (doc.hidden) {
      hiddenTimer = setTimeout(suspend, hiddenGraceMs);
    } else {
      resume();
    }
  }

  function attachVisibility() {
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibilityChange);
  }

  function detachVisibility() {
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibilityChange);
  }

  function stop() {
    started = false;
    suspended = false;
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
    detachVisibility();
    buffer = [];
    flushPending = false;
    closeSource();
  }

  return { start, stop, suspend, resume, isSuspended: () => suspended };
}
