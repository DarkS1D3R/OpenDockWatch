// Shared EventSource-backed log line stream: connection lifecycle, non-reactive line buffering,
// rAF-batched flush, hidden-tab suspension, and the loading-spinner timer. Caller owns the
// reactive line array; onFlush(batch) hands over {id, text} to append. See CLAUDE.md.
const defaultSchedule = (cb) => requestAnimationFrame(cb);
const defaultDoc = typeof document === 'undefined' ? null : document;

// EventSource reconnects forever, and the server spawns a `docker logs` process per connection -
// for a deleted container that's a permanent reconnect loop leaking child processes. Genuine
// restarts reconnect within budget (any line resets the count); only a totally silent stream gives up.
const MAX_CONSECUTIVE_ERRORS = 5;

// How long the tab stays hidden before an open stream gives up its connection - a backgrounded
// tab otherwise holds a browser connection and a server-side `docker logs -f` child indefinitely.
// Not immediate: resuming resets the pane (re-tails), so a brief tab-glance shouldn't cost that.
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

  // Gives the connection back without tearing the stream down - stays "started" so it knows to
  // come back. Not routed through the error path: a suspend isn't a disconnect and must not
  // count against MAX_CONSECUTIVE_ERRORS, or background/foreground cycles would kill a healthy stream.
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
