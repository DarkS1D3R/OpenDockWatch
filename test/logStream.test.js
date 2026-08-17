const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let logStream;
before(async () => {
  logStream = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logStream.js')));
});

// Minimal stub standing in for the browser's EventSource - captures the url it was constructed
// with and lets a test fire onmessage/onerror/close manually.
class StubEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    StubEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}
StubEventSource.instances = [];

function makeSync() {
  // Runs the scheduled flush immediately rather than waiting for a real animation frame, so
  // tests don't need a browser or fake timers for rAF.
  return (cb) => cb();
}

test('createLogStream', async (t) => {
  t.beforeEach(() => {
    StubEventSource.instances = [];
  });

  await t.test('start() connects to the given url', () => {
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: () => {},
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    assert.equal(StubEventSource.instances.length, 1);
    assert.equal(StubEventSource.instances[0].url, 'http://x/logs');
  });

  await t.test('signals loading true on start, then false once the first batch flushes', () => {
    const loadingChanges = [];
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: () => {},
      onLoadingChange: (loading) => loadingChanges.push(loading),
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    const source = StubEventSource.instances[0];
    source.onmessage({ data: 'hello' });
    assert.deepEqual(loadingChanges, [true, false]);
  });

  await t.test('batches queued lines into one onFlush call with monotonic ids', () => {
    const batches = [];
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: (lines) => batches.push(lines),
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    const source = StubEventSource.instances[0];
    source.onmessage({ data: 'line 1' });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], [{ id: 0, text: 'line 1' }]);
  });

  await t.test('an EventSource error queues a disconnect notice as a line', () => {
    const batches = [];
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: (lines) => batches.push(lines),
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    StubEventSource.instances[0].onerror();
    assert.equal(batches[0][0].text, '[opendockwatch] log stream disconnected');
  });

  await t.test('stop() closes the underlying source', () => {
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: () => {},
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    const source = StubEventSource.instances[0];
    stream.stop();
    assert.equal(source.closed, true);
  });

  await t.test('start() while already running closes the old source before opening a new one', () => {
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: () => {},
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    const first = StubEventSource.instances[0];
    stream.start();
    assert.equal(first.closed, true);
    assert.equal(StubEventSource.instances.length, 2);
  });

  await t.test('gives up after repeated disconnects with no line in between', () => {
    // EventSource reconnects on its own forever, and each reconnect spawns a `docker logs` on the
    // server - for a container that no longer exists that's an unbounded drip of child processes
    // and a connection slot never released.
    const flushed = [];
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: (lines) => flushed.push(...lines.map((l) => l.text)),
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    const source = StubEventSource.instances[0];

    for (let i = 0; i < 5; i++) source.onerror();

    assert.equal(source.closed, true, 'must close the source so it stops reconnecting');
    // The explanatory line has to survive - closing via stop() would discard the buffer holding
    // it, leaving a silently dead pane.
    assert.match(flushed.at(-1), /stopped after repeated disconnects/);
  });

  await t.test('a line arriving resets the disconnect budget', () => {
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: () => {},
      onLoadingChange: () => {},
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
    });
    stream.start();
    const source = StubEventSource.instances[0];

    // A container that genuinely restarts disconnects and reconnects repeatedly over a long
    // session; as long as it keeps producing output, the stream must stay open indefinitely.
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 4; i++) source.onerror();
      source.onmessage({ data: 'still alive' });
    }
    assert.equal(source.closed, false);
  });

  await t.test('the loading timer clears the spinner if no line ever arrives', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const loadingChanges = [];
      const stream = logStream.createLogStream({
        url: 'http://x/logs',
        onFlush: () => {},
        onLoadingChange: (loading) => loadingChanges.push(loading),
        EventSourceImpl: StubEventSource,
        schedule: makeSync(),
        loadingTimeoutMs: 2000,
      });
      stream.start();
      mock.timers.tick(2000);
      assert.deepEqual(loadingChanges, [true, false]);
    } finally {
      mock.timers.reset();
    }
  });
});

// A stand-in for `document` that only needs the two things logStream uses: a `hidden` flag and
// visibilitychange listener registration.
class StubDoc {
  constructor() {
    this.hidden = false;
    this.listeners = [];
  }
  addEventListener(type, fn) {
    if (type === 'visibilitychange') this.listeners.push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  // Flip visibility and fire the event, the way a real browser does on tab switch.
  setHidden(hidden) {
    this.hidden = hidden;
    for (const fn of [...this.listeners]) fn();
  }
}

// Backgrounded-tab suspension. A dashboard is exactly the kind of page left open in a tab for days,
// and each open stream costs a browser connection (of which there are ~6 per origin) plus a
// server-side `docker logs -f` child for as long as it's held.
test('createLogStream suspension', async (t) => {
  const GRACE = 60_000;

  function build(overrides = {}) {
    StubEventSource.instances = [];
    const doc = new StubDoc();
    const events = { flushed: [], resets: 0, suspendChanges: [] };
    const stream = logStream.createLogStream({
      url: 'http://x/logs',
      onFlush: (lines) => events.flushed.push(...lines.map((l) => l.text)),
      onLoadingChange: () => {},
      onReset: () => events.resets++,
      onSuspendChange: (s) => events.suspendChanges.push(s),
      EventSourceImpl: StubEventSource,
      schedule: makeSync(),
      doc,
      hiddenGraceMs: GRACE,
      ...overrides,
    });
    return { stream, doc, events };
  }

  await t.test('hiding the tab does not suspend until the grace period elapses', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { stream, doc } = build();
      stream.start();
      const source = StubEventSource.instances[0];

      doc.setHidden(true);
      mock.timers.tick(GRACE - 1);
      assert.equal(source.closed, false, 'a quick tab switch must not tear four synced panes down');
      assert.equal(stream.isSuspended(), false);

      mock.timers.tick(2);
      assert.equal(source.closed, true);
      assert.equal(stream.isSuspended(), true);
    } finally {
      mock.timers.reset();
    }
  });

  await t.test('coming back before the grace elapses cancels the pending suspend entirely', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { stream, doc, events } = build();
      stream.start();
      const source = StubEventSource.instances[0];

      doc.setHidden(true);
      mock.timers.tick(GRACE / 2);
      doc.setHidden(false);
      mock.timers.tick(GRACE * 2);

      assert.equal(source.closed, false, 'the original connection must survive untouched');
      assert.equal(StubEventSource.instances.length, 1, 'and must not be replaced by a reconnect');
      assert.deepEqual(events.suspendChanges, [], 'nothing to report - it never suspended');
      assert.equal(events.resets, 0, 'and the pane must not have been cleared');
    } finally {
      mock.timers.reset();
    }
  });

  await t.test('returning after a suspend reconnects and resets the caller first', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { stream, doc, events } = build();
      stream.start();
      doc.setHidden(true);
      mock.timers.tick(GRACE + 1);

      doc.setHidden(false);
      assert.equal(StubEventSource.instances.length, 2, 'a fresh connection on return');
      assert.equal(stream.isSuspended(), false);
      // `docker logs --tail N` replays the tail on reconnect, so the caller has to drop what it is
      // holding or every resume duplicates it.
      assert.equal(events.resets, 1);
      assert.deepEqual(events.suspendChanges, [true, false]);
    } finally {
      mock.timers.reset();
    }
  });

  await t.test('a suspend does not count against the reconnect budget', () => {
    // Otherwise a few background/foreground cycles would permanently kill a healthy stream: the
    // give-up counter is meant to catch a container that cannot produce a line, not a tab switch.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { stream, doc } = build();
      stream.start();

      for (let cycle = 0; cycle < 4; cycle++) {
        doc.setHidden(true);
        mock.timers.tick(GRACE + 1);
        doc.setHidden(false);
      }

      const latest = StubEventSource.instances.at(-1);
      assert.equal(latest.closed, false, 'still connected after four full cycles');
      // Four more errors would exceed MAX_CONSECUTIVE_ERRORS (5) if the suspends had counted.
      for (let i = 0; i < 4; i++) latest.onerror();
      assert.equal(latest.closed, false);
    } finally {
      mock.timers.reset();
    }
  });

  await t.test('stop() detaches the visibility listener so a stopped stream stays stopped', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { stream, doc } = build();
      stream.start();
      stream.stop();
      assert.equal(doc.listeners.length, 0);

      const before = StubEventSource.instances.length;
      doc.setHidden(true);
      mock.timers.tick(GRACE * 2);
      doc.setHidden(false);
      assert.equal(StubEventSource.instances.length, before, 'a torn-down stream must not resurrect');
    } finally {
      mock.timers.reset();
    }
  });

  await t.test('suspend()/resume() are no-ops before start and idempotent after', () => {
    const { stream, events } = build();
    stream.suspend();
    stream.resume();
    assert.deepEqual(events.suspendChanges, []);

    stream.start();
    stream.suspend();
    stream.suspend();
    stream.resume();
    stream.resume();
    assert.deepEqual(events.suspendChanges, [true, false]);
  });
});

// Every test above injects hiddenGraceMs so it doesn't have to wait a real minute, which means the
// value that actually ships was never exercised by any of them - a mutation setting it to 0
// survived the whole suite. These assert the defaults themselves, in the same spirit as the
// watchdog's recovery-budget guard.
test('shipped defaults', async (t) => {
  await t.test('the hidden-tab grace is long enough that a glance at another tab costs nothing', () => {
    // Resuming re-tails and resets the pane, so a short grace turns every alt-tab into a visible
    // flush of every open log pane.
    assert.ok(
      logStream.HIDDEN_SUSPEND_GRACE_MS >= 30_000,
      `${logStream.HIDDEN_SUSPEND_GRACE_MS}ms would re-tail every pane on a brief tab switch`
    );
  });

  await t.test('the grace is not so long that a backgrounded tab holds its connection all day', () => {
    // The other half of the trade: the stream holds one of the browser's ~6 per-origin
    // connections and a server-side `docker logs -f` child for the whole grace.
    assert.ok(logStream.HIDDEN_SUSPEND_GRACE_MS <= 300_000);
  });

  await t.test('the reconnect budget is finite - EventSource retries forever on its own', () => {
    assert.ok(Number.isFinite(logStream.MAX_CONSECUTIVE_ERRORS));
    assert.ok(logStream.MAX_CONSECUTIVE_ERRORS >= 1 && logStream.MAX_CONSECUTIVE_ERRORS <= 20);
  });

  await t.test('a caller that injects no grace gets the shipped one wired into the timer', () => {
    // Guards the wiring, not just the constant: if the default stopped being referenced, the
    // bounds asserted above would keep passing while the shipped behaviour changed underneath.
    // Captures what delay the hidden-tab timer is actually scheduled at.
    let onVisibility = null;
    const doc = {
      hidden: false,
      addEventListener: (_event, fn) => (onVisibility = fn),
      removeEventListener() {},
    };
    const delays = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => {
      delays.push(ms);
      return realSetTimeout(() => {}, 0); // never actually fire - this test only cares about the delay
    };
    let stream;
    try {
      stream = logStream.createLogStream({
        url: '/x',
        onFlush() {},
        onLoadingChange() {},
        EventSourceImpl: StubEventSource,
        schedule: makeSync(),
        doc,
      });
      stream.start();
      delays.length = 0; // drop the loading-spinner timer, it isn't what's under test
      doc.hidden = true;
      onVisibility();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      if (stream) stream.stop();
    }
    assert.deepEqual(delays, [logStream.HIDDEN_SUSPEND_GRACE_MS], 'the hidden timer should use the default grace');
  });
});
