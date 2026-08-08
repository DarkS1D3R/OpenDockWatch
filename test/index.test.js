const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

// server/index.js reads AUTH_USER/AUTH_PASS_HASH/VIEWER_USER/VIEWER_PASS_HASH at request time
// (verifyLogin) but SESSION_SECRET at require time (the session() middleware factory runs as
// soon as the module loads) - all four have to be set before the require() below either way.
// dotenv's config() call inside index.js never overrides a variable that's already set, so this
// doesn't get clobbered by whatever's in the real .env.
const ADMIN_USER = 'index-test-admin';
const ADMIN_PASSWORD = 'index-test-admin-pw';
const VIEWER_USER = 'index-test-viewer';
const VIEWER_PASSWORD = 'index-test-viewer-pw';
process.env.AUTH_USER = ADMIN_USER;
process.env.AUTH_PASS_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);
process.env.VIEWER_USER = VIEWER_USER;
process.env.VIEWER_PASS_HASH = bcrypt.hashSync(VIEWER_PASSWORD, 4);
process.env.SESSION_SECRET = 'index-test-session-secret';

// Route through an isolated temp file rather than the real data/opendockwatch.db - this file is
// also the one a running container has open in WAL mode, and mixing a native-Windows process's
// handle on it with a WSL2-mounted container's handle on the same path can wedge the container's
// SQLite connection (SQLITE_IOERR_SHMOPEN) even though this test never intends to write anything
// that matters. Set before the require() below, same reasoning as the AUTH_* vars above.
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-index-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const request = require('supertest');
const { app, api, requestTimeout } = require('../server/index');
const express = require('express');
const { requireAdmin } = require('../server/auth');
const db = require('../server/db');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  }
});

// A hostId that can't collide with anything in the real config/hosts.json this process happens
// to load - every request below that reaches a requireHost-gated route uses this, so it 404s
// before ever shelling out to docker.
const FAKE_HOST_ID = '__index_test_nonexistent_host__';
// An alert id this large is never going to match a real row, so acknowledging it is a genuine
// no-op UPDATE (0 rows changed) rather than a mutation of real data - safe to actually execute as
// part of the admin-can-reach-the-handler sanity check below.
const FAKE_ALERT_ID = 999999999;

// Structural check, not a hand-maintained list: walks every route actually registered on the api
// router and asserts requireAdmin is in its middleware stack for every non-GET method. This is
// what would have caught the bug that prompted this file - POST /alerts/:id/ack and
// POST /alerts/ack-all shipped without requireAdmin while every other mutating route had it - and
// unlike a list of routes copied out of index.js by hand, it keeps working when someone adds a
// new mutating route six months from now and simply forgets the middleware, which is exactly how
// the original gap happened.
test('every non-GET /api route has requireAdmin in its middleware stack', () => {
  const checked = [];
  for (const layer of api.stack) {
    if (!layer.route) continue; // skips api.use(requireAuth) and the router's own path-matching layers
    const { path, methods, stack } = layer.route;
    for (const method of Object.keys(methods)) {
      if (method === 'get' || method === 'head') continue;
      const label = `${method.toUpperCase()} /api${path}`;
      checked.push(label);
      assert.ok(
        stack.some((s) => s.handle === requireAdmin),
        `${label} mutates state but has no requireAdmin middleware`
      );
    }
  }
  // Guards the check above against silently checking nothing - if a future Express upgrade
  // changes Route's internal shape (.methods/.stack), this fails loudly instead of the loop above
  // just finding zero routes and the test passing for the wrong reason.
  assert.ok(checked.length >= 10, `expected to find at least 10 non-GET /api routes, found ${checked.length}: ${checked.join(', ')}`);
});

async function loginAs(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/login').send({ username, password });
  assert.equal(res.status, 200, `login as ${username} failed: ${JSON.stringify(res.body)}`);
  return agent;
}

// Container log output reaches the DOM through v-html, so script-src is what keeps a crafted log
// line from becoming code - and it only helps if it's actually on every response, including the
// static assets and the login page a browser reaches before it has a session.
test('security headers are set on every response', async (t) => {
  await t.test('the login page carries the CSP and the rest of the header set', async () => {
    const res = await request(app).get('/login');
    assert.equal(res.status, 200);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'no Content-Security-Policy header');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });

  await t.test('static assets carry them too', async () => {
    const res = await request(app).get('/assets/js/login.js');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-security-policy']);
  });

  // script-src carries 'unsafe-eval' (Vue's in-browser template compiler needs it) but must never
  // carry 'unsafe-inline' - that's the directive standing between an <img onerror=…> in a log line
  // and code execution, and it's the whole reason login.html's handler was moved to a file.
  await t.test('script-src allows eval but never inline scripts', async () => {
    const csp = (await request(app).get('/login')).headers['content-security-policy'];
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src'));
    assert.ok(scriptSrc, 'no script-src directive');
    assert.equal(scriptSrc.includes("'unsafe-inline'"), false, 'script-src must not allow inline scripts');
    // Present deliberately, and load-bearing - see CLAUDE.md. Asserted so removing it "to tighten
    // the CSP" fails here rather than silently rendering every component blank in a browser.
    assert.match(scriptSrc, /'unsafe-eval'/);
  });

  // login.html used to carry its submit handler in an inline <script>, which script-src blocks
  // outright without 'unsafe-inline' - the CSP above is only honest if it really is an external file.
  await t.test('login.html has no inline script for the CSP to block', async () => {
    const res = await request(app).get('/login');
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(res.text), false, 'login.html still contains an inline <script>');
    assert.match(res.text, /<script src="\/assets\/js\/login\.js">/);
  });
});

test('GET /metrics', async (t) => {
  const original = process.env.METRICS_TOKEN;
  t.after(() => {
    if (original === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = original;
  });

  // The response lists every container name, compose project and usage figure across every host.
  // Unset used to mean "served to anyone who can reach the port"; it has to mean "not served".
  await t.test('404s when no METRICS_TOKEN is configured, rather than serving unauthenticated', async () => {
    delete process.env.METRICS_TOKEN;
    const res = await request(app).get('/metrics');
    assert.equal(res.status, 404);
    assert.equal(res.text.includes('opendockwatch_'), false, 'metrics body leaked on the unconfigured path');
  });

  await t.test('401s on a wrong or missing token once one is configured', async () => {
    process.env.METRICS_TOKEN = 'test-metrics-token';
    assert.equal((await request(app).get('/metrics')).status, 401);
    assert.equal((await request(app).get('/metrics?token=wrong')).status, 401);
    assert.equal((await request(app).get('/metrics').set('Authorization', 'Bearer wrong')).status, 401);
  });

  await t.test('serves the exposition format for a correct token, by query or bearer header', async () => {
    process.env.METRICS_TOKEN = 'test-metrics-token';
    const viaQuery = await request(app).get('/metrics?token=test-metrics-token');
    assert.equal(viaQuery.status, 200);
    assert.match(viaQuery.text, /# TYPE opendockwatch_container_cpu_percent gauge/);
    const viaHeader = await request(app).get('/metrics').set('Authorization', 'Bearer test-metrics-token');
    assert.equal(viaHeader.status, 200);
  });
});

test('GET /healthz is reachable with no session and reflects the real sqlite connection', async () => {
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.text, 'ok');
});

test('role gating over real HTTP requests', async (t) => {
  await t.test('no session: requireAuth blocks both a read and a write route', async () => {
    assert.equal((await request(app).get('/api/session')).status, 401);
    assert.equal((await request(app).post(`/api/alerts/${FAKE_ALERT_ID}/ack`)).status, 401);
  });

  await t.test('viewer session: blocked from every mutating route this session was written to fix', async () => {
    const viewer = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    // The regression this whole file exists for: these two shipped without requireAdmin.
    assert.equal((await viewer.post(`/api/alerts/${FAKE_ALERT_ID}/ack`)).status, 403);
    assert.equal((await viewer.post(`/api/alerts/ack-all?hostId=${FAKE_HOST_ID}`)).status, 403);
    // requireAdmin runs before requireHost in the middleware chain, so a viewer is blocked here
    // even though the host doesn't exist - a 404 would mean the ordering regressed.
    assert.equal((await viewer.post(`/api/hosts/${FAKE_HOST_ID}/containers/abc/start`)).status, 403);
  });

  await t.test('viewer session: not blocked from read-only routes (role gating should not over-restrict)', async () => {
    const viewer = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    assert.equal((await viewer.get('/api/hosts')).status, 200);
    assert.equal((await viewer.get('/api/session')).status, 200);
  });

  await t.test('admin session: reaches the real handler past requireAdmin on both route kinds', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    // A no-op UPDATE (id doesn't exist) - proves requireAdmin let it through without mutating
    // anything real.
    assert.equal((await admin.post(`/api/alerts/${FAKE_ALERT_ID}/ack`)).status, 200);
    // 404 (from requireHost, past requireAdmin) rather than 403 - proves admin cleared the
    // requireAdmin gate the viewer above was stopped at, without ever shelling out to docker for
    // a host that doesn't exist.
    assert.equal((await admin.post(`/api/hosts/${FAKE_HOST_ID}/containers/abc/start`)).status, 404);
  });
});

// A request that never answers is worse than one that fails: over HTTP/1.1 a browser has about
// six connections per origin, and this app permanently holds some of them open for its SSE
// streams - so requests that hang until Node's 300s default eventually leave the tab unable to
// issue any request at all, which is the "site is hung, restart the container" state. These
// exercise the middleware directly against a throwaway app, since no real route can be made to
// hang without a docker daemon behind it.
// Without regenerate() the id survives the login, so a session id planted before sign-in is still
// valid after it. Two logins on one agent is the observable form: the second must be issued a new
// id, where an un-regenerated session would keep (and not even re-send) the first.
test('login issues a fresh session id rather than upgrading the existing one', async () => {
  const sidFrom = (res) => {
    const cookies = res.headers['set-cookie'] || [];
    const match = cookies.map((c) => /connect\.sid=([^;]+)/.exec(c)).find(Boolean);
    return match ? match[1] : null;
  };

  const agent = request.agent(app);
  const first = await agent.post('/login').send({ username: ADMIN_USER, password: ADMIN_PASSWORD });
  assert.equal(first.status, 200);
  const firstSid = sidFrom(first);
  assert.ok(firstSid, 'first login set no session cookie');

  const second = await agent.post('/login').send({ username: ADMIN_USER, password: ADMIN_PASSWORD });
  assert.equal(second.status, 200);
  const secondSid = sidFrom(second);
  assert.ok(secondSid, 'second login set no session cookie - the session id was reused');
  assert.notEqual(secondSid, firstSid);

  // The regenerated session is a working one, not just a new id.
  assert.equal((await agent.get('/api/session')).status, 200);
});

test('requestTimeout', async (t) => {
  function appWith(handler, { ms = 40, path: routePath = '/api/thing' } = {}) {
    const testApp = express();
    testApp.use(requestTimeout(ms));
    testApp.get(routePath, handler);
    return testApp;
  }

  await t.test('answers 504 rather than hanging when a handler never responds', async () => {
    const res = await request(appWith(() => {})).get('/api/thing');
    assert.equal(res.status, 504);
    assert.match(res.body.error, /timed out/);
  });

  await t.test('a handler that answers in time is untouched', async () => {
    const res = await request(appWith((req, r) => r.json({ ok: true }))).get('/api/thing');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  await t.test('a late response after the 504 is dropped, not thrown', async () => {
    // The handler is still running when the 504 goes out and will eventually try to send its own
    // response. That second send must be a no-op: unguarded it throws ERR_HTTP_HEADERS_SENT,
    // which express routes to the error handler, which destroys a connection that was already
    // answered correctly.
    let lateSendThrew = null;
    const testApp = appWith((req, r) => {
      setTimeout(() => {
        try {
          r.status(502).json({ error: 'docker finally failed' });
        } catch (err) {
          lateSendThrew = err;
        }
      }, 120);
    });
    const res = await request(testApp).get('/api/thing');
    assert.equal(res.status, 504, 'the client must still get the timeout response');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lateSendThrew, null, 'the handler must not blow up when it finally answers');
  });

  await t.test('leaves SSE routes alone - a stream still open past the timeout is working', async () => {
    let cleared = false;
    const testApp = express();
    testApp.use(requestTimeout(40));
    testApp.get('/api/hosts/h/containers/c/logs', (req, r) => {
      r.set({ 'Content-Type': 'text/event-stream' });
      r.flushHeaders();
      setTimeout(() => {
        cleared = true;
        r.write('data: line\n\n');
        r.end();
      }, 120);
    });
    const res = await request(testApp).get('/api/hosts/h/containers/c/logs');
    assert.equal(res.status, 200);
    assert.equal(cleared, true);
    assert.match(res.text, /data: line/);
  });
});
