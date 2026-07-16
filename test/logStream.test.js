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
