const test = require('node:test');
const assert = require('node:assert/strict');

// public/js/api.js is browser code, but it touches the DOM in exactly one place - apiFetch's 401
// redirect - so a two-property window stand-in is the whole shim it needs. Set before the import
// so nothing can read a missing global at module scope. See public/CLAUDE.md.
const win = { location: { href: '' } };
globalThis.window = win;

let api;
test.before(async () => {
  api = await import('../public/js/api.js');
});

const originalFetch = global.fetch;
function stubFetch(t, impl) {
  const calls = [];
  global.fetch = (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  t.after(() => {
    global.fetch = originalFetch;
    win.location.href = '';
  });
  return calls;
}

// reportClientError is called from window.onerror / unhandledrejection, so every property here is
// about not becoming the failure it exists to report. The contrast tests against apiFetch are the
// point: each one shows the behaviour it deliberately does not inherit.
test('reportClientError', async (t) => {
  // Awaited, not asserted in the same tick: apiFetch's redirect lands a microtask after the call,
  // so a same-tick assertion passes even when this is routed through apiFetch after all.
  await t.test('does not redirect on 401 the way apiFetch does', async (t) => {
    stubFetch(t, async () => ({ status: 401 }));
    api.reportClientError({ message: 'boom' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(win.location.href, '', 'a report on an expired session navigated the page away mid-session');
  });

  await t.test('apiFetch really does redirect on 401 - so the line above is not vacuous', async (t) => {
    stubFetch(t, async () => ({ status: 401 }));
    await assert.rejects(() => api.apiGetSession(), /unauthenticated/);
    assert.equal(win.location.href, '/login');
  });

  await t.test('does not throw when fetch throws synchronously', (t) => {
    stubFetch(t, () => {
      throw new TypeError('Failed to fetch');
    });
    assert.doesNotThrow(() => api.reportClientError({ message: 'boom' }), 'a failed report became an error of its own');
  });

  await t.test('does not throw when the request rejects', async (t) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    stubFetch(t, async () => {
      throw new Error('offline');
    });
    assert.doesNotThrow(() => api.reportClientError({ message: 'boom' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'the report left an unhandled rejection behind');
  });

  await t.test('is fire-and-forget - it hands back nothing to await or catch', (t) => {
    stubFetch(t, async () => ({ status: 204 }));
    assert.equal(api.reportClientError({ message: 'boom' }), undefined, 'returning a promise invites a caller to await or .catch it');
  });

  await t.test('sends exactly one request - never a retry', (t) => {
    const calls = stubFetch(t, async () => ({ status: 500 }));
    api.reportClientError({ message: 'boom' });
    assert.equal(calls.length, 1);
  });

  await t.test('sets keepalive so a report survives the unload that caused it', (t) => {
    const calls = stubFetch(t, async () => ({ status: 204 }));
    api.reportClientError({ message: 'boom' });
    assert.equal(calls[0].opts.keepalive, true);
  });

  // The structural proof that it bypasses apiFetch: apiFetch always attaches an AbortSignal, so
  // its absence here means this request was issued directly and inherits none of apiFetch's rules.
  await t.test('does not go through apiFetch', (t) => {
    const calls = stubFetch(t, async () => ({ status: 204 }));
    api.reportClientError({ message: 'boom' });
    assert.equal(calls[0].opts.signal, undefined, 'the report went through apiFetch - it must not');
    assert.equal(calls[0].url, '/api/client-error');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { message: 'boom' });
  });

  await t.test('apiFetch really does attach a signal - so the line above is not vacuous', async (t) => {
    const calls = stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await api.apiGetSession();
    assert.ok(calls[0].opts.signal, 'apiFetch stopped attaching a timeout signal - reportClientError needs a new bypass proof');
  });
});

test('apiFetch', async (t) => {
  await t.test('names the timeout instead of surfacing "signal is aborted without reason"', async (t) => {
    stubFetch(t, async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    await assert.rejects(() => api.apiGetSession(), /request timed out after 15s/);
  });

  await t.test('surfaces the server error body rather than the status text', async (t) => {
    stubFetch(t, async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'invalid container action' }),
    }));
    await assert.rejects(() => api.apiGetSession(), /invalid container action/);
  });

  await t.test('falls back to the status text when the body is not JSON', async (t) => {
    stubFetch(t, async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    await assert.rejects(() => api.apiGetSession(), /Bad Gateway/);
  });
});
