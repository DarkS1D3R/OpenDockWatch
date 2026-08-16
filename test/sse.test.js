const test = require('node:test');
const assert = require('node:assert/strict');
const { Broadcaster } = require('../server/sse');

// A stand-in for the express response: subscribe() only ever touches these three, so a fake keeps
// this a unit test of the pub/sub rather than an HTTP test that would prove less.
function fakeRes() {
  const res = { headers: null, flushed: false, writes: [] };
  res.set = (h) => (res.headers = h);
  res.flushHeaders = () => (res.flushed = true);
  res.write = (chunk) => res.writes.push(chunk);
  return res;
}

const dataPayloads = (res) => res.writes.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice(6)));

test('Broadcaster', async (t) => {
  await t.test('sets the SSE headers and flushes them before anything is published', () => {
    // Without flushHeaders the browser's EventSource sits waiting and the stream never "opens" -
    // it would look like a hang rather than an idle stream.
    const b = new Broadcaster();
    const res = fakeRes();
    b.subscribe(res, 'local');
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(res.headers['Cache-Control'], 'no-cache');
    assert.equal(res.flushed, true);
  });

  await t.test('delivers a payload to every subscriber of that host', () => {
    const b = new Broadcaster();
    const a = fakeRes();
    const c = fakeRes();
    b.subscribe(a, 'local');
    b.subscribe(c, 'local');
    b.publish('local', { action: 'start' });
    assert.deepEqual(dataPayloads(a), [{ action: 'start' }]);
    assert.deepEqual(dataPayloads(c), [{ action: 'start' }]);
  });

  await t.test('never delivers one host’s events to another host’s subscribers', () => {
    const b = new Broadcaster();
    const local = fakeRes();
    const remote = fakeRes();
    b.subscribe(local, 'local');
    b.subscribe(remote, 'remote');
    b.publish('local', { action: 'die' });
    assert.equal(dataPayloads(local).length, 1);
    assert.equal(dataPayloads(remote).length, 0);
  });

  await t.test('a host id that collides with an EventEmitter builtin does not blow up', () => {
    // Host ids are user-chosen, and EventEmitter treats 'error' specially - emitting it with no
    // listener throws. The channel() prefix is what stops a host called "error" taking the
    // process down, so it is worth a test rather than a comment alone.
    const b = new Broadcaster();
    const res = fakeRes();
    b.subscribe(res, 'error');
    b.publish('error', { action: 'start' });
    assert.equal(dataPayloads(res).length, 1);
    // ...and publishing to a host nobody is watching is a no-op, not a throw.
    assert.doesNotThrow(() => b.publish('error-nobody-listening', { action: 'start' }));
  });

  await t.test('unsubscribing stops delivery and does not disturb the other subscribers', () => {
    const b = new Broadcaster();
    const going = fakeRes();
    const staying = fakeRes();
    const stop = b.subscribe(going, 'local');
    b.subscribe(staying, 'local');
    stop();
    b.publish('local', { action: 'stop' });
    assert.equal(dataPayloads(going).length, 0);
    assert.equal(dataPayloads(staying).length, 1);
  });

  // subscriberCount feeds sseClients on index.js's app.vitals line, which is there to answer
  // "how many connections are held right now" while the UI is unresponsive. A count that silently
  // read zero would make the one number worth having useless.
  await t.test('subscriberCount tracks subscribe/unsubscribe across hosts', () => {
    const b = new Broadcaster();
    assert.equal(b.subscriberCount(), 0);
    const stopA = b.subscribe(fakeRes(), 'local');
    const stopB = b.subscribe(fakeRes(), 'local');
    const stopC = b.subscribe(fakeRes(), 'remote');
    assert.equal(b.subscriberCount(), 3, 'counts across every host, not just one');
    stopA();
    assert.equal(b.subscriberCount(), 2);
    stopB();
    stopC();
    assert.equal(b.subscriberCount(), 0, 'must return to zero, or the vitals line drifts upward forever');
  });

  await t.test('calling the unsubscribe function twice does not double-count down', () => {
    const b = new Broadcaster();
    const stop = b.subscribe(fakeRes(), 'local');
    b.subscribe(fakeRes(), 'local');
    stop();
    stop();
    assert.equal(b.subscriberCount(), 1);
  });
});
