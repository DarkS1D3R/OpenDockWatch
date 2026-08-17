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
const { app, api, requestTimeout, requireHost, clientErrorStatus, slowThresholdFor } = require('../server/index');
const { loadHosts } = require('../server/hosts');
const express = require('express');
const { requireAdmin } = require('../server/auth');
const db = require('../server/db');
const metricsCollector = require('../server/metricsCollector');

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
// Exemptions are a map, not a skip, so each one carries its reason and a stale entry fails loudly
// rather than quietly widening the check's blind spot. Two properties are required to be in here:
// the route changes no state, and there is a real reason a non-admin must reach it.
const ADMIN_EXEMPT = new Map([
  [
    'post /client-error',
    'writes one log line and no state; a viewer’s browser breaks like an admin’s, so it must work for both. Rate-limited instead.',
  ],
]);

test('every non-GET /api route has requireAdmin in its middleware stack', () => {
  const checked = [];
  const usedExemptions = new Set();
  for (const layer of api.stack) {
    if (!layer.route) continue; // skips api.use(requireAuth) and the router's own path-matching layers
    const { path, methods, stack } = layer.route;
    for (const method of Object.keys(methods)) {
      if (method === 'get' || method === 'head') continue;
      const label = `${method.toUpperCase()} /api${path}`;
      checked.push(label);
      const key = `${method} ${path}`;
      if (ADMIN_EXEMPT.has(key)) {
        usedExemptions.add(key);
        continue;
      }
      assert.ok(
        stack.some((s) => s.handle === requireAdmin),
        `${label} mutates state but has no requireAdmin middleware`
      );
    }
  }
  // A route that gets renamed or removed must not leave its exemption behind waiting to silently
  // cover something else that later takes the same path.
  for (const key of ADMIN_EXEMPT.keys()) {
    assert.ok(usedExemptions.has(key), `stale admin exemption for "${key}" - no such route is registered any more`);
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
    // Matched loosely on the prefix because the asset paths are version-pinned on the way out -
    // what this test is about is that the handler is an external file at all, not where it lives.
    assert.match(res.text, /<script src="\/assets\/[^"]*\/js\/login\.js">/);
  });
});

// express defines req.host as a getter-only property returning the Host header, so `req.host = obj`
// silently no-ops and every handler downstream gets a string. hostArgs() reads `.dockerHost` off it,
// finds undefined, and falls back to the local socket - a remote host's routes hit the wrong daemon.
test('requireHost hands the handler the host object, not express own req.host string', async () => {
  const configured = loadHosts();
  assert.ok(configured.length, 'no hosts configured - hosts.js should fall back to hosts.example.json');
  const hostId = configured[0].id;

  const seen = [];
  const probe = express();
  probe.get('/hosts/:hostId/probe', requireHost, (req, res) => {
    seen.push(req.odwHost);
    res.json({ ok: true });
  });
  const res = await request(probe).get(`/hosts/${hostId}/probe`);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  // A string here means the host went out under a name express owns and the object was dropped:
  // hostArgs() then reads no .dockerHost and every remote host silently targets the local socket.
  assert.equal(typeof seen[0], 'object', 'requireHost handed the handler a string, not the host object');
  assert.equal(seen[0].id, hostId);

  // The reason the workaround is needed. If express ever makes this writable, this flips and the
  // rename can be reconsidered - until then, assigning req.host is a silent no-op.
  const probe2 = express();
  probe2.get('/probe', (req, res) => {
    req.host = { id: 'sentinel' };
    res.json({ type: typeof req.host });
  });
  assert.equal((await request(probe2).get('/probe')).body.type, 'string', 'express.request.host became writable');
});

// A NaN bound into `WHERE id = ?` matches no row and reports success, so an unvalidated id makes
// the API answer 200 to a request that did nothing at all - same class as intParam's guard.
test('container-rules routes reject an unusable id rather than no-op with a 200', async (t) => {
  const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
  const body = { matchType: 'name', matchValue: 'x' };

  await t.test('400s on a non-numeric id', async () => {
    assert.equal((await agent.delete('/api/settings/container-rules/abc')).status, 400);
    assert.equal((await agent.put('/api/settings/container-rules/abc').send(body)).status, 400);
  });

  await t.test('404s on a well-formed id that no rule has', async () => {
    assert.equal((await agent.delete('/api/settings/container-rules/999999')).status, 404);
    assert.equal((await agent.put('/api/settings/container-rules/999999').send(body)).status, 404);
  });

  await t.test('still round-trips a real rule through add, update and delete', async () => {
    const added = await agent.post('/api/settings/container-rules').send(body);
    assert.equal(added.status, 200);
    const id = added.body[added.body.length - 1].id;
    assert.equal((await agent.put(`/api/settings/container-rules/${id}`).send({ ...body, cpuThreshold: 150 })).status, 200);
    const updated = (await agent.get('/api/settings/container-rules')).body.find((r) => r.id === id);
    assert.equal(updated.cpuThreshold, 150, 'a CPU threshold over 100 is valid - docker CPU% is per-core cumulative');
    assert.equal((await agent.delete(`/api/settings/container-rules/${id}`)).status, 200);
  });
});

test('default view (landing tab) setting', async (t) => {
  await t.test('rejects a value outside list/flow/logs/activity', async () => {
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await agent.put('/api/settings/default-view').send({ defaultView: 'nonsense' })).status, 400);
  });

  await t.test('save/clear round-trip, and GET /session reflects it for every role', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);

    const saved = await admin.put('/api/settings/default-view').send({ defaultView: 'flow' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { defaultView: 'flow', overridden: true });

    const viewer = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    assert.equal((await viewer.get('/api/session')).body.defaultView, 'flow', 'a viewer session should see the same configured default');

    const cleared = await admin.delete('/api/settings/default-view');
    assert.deepEqual(cleared.body, { defaultView: 'list', overridden: false });
    assert.equal((await admin.get('/api/session')).body.defaultView, 'list');
  });

  await t.test('only an admin can change it, though any role can read the resolved value via /session', async () => {
    const viewer = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    assert.equal((await viewer.put('/api/settings/default-view').send({ defaultView: 'logs' })).status, 403);
    assert.equal((await viewer.get('/api/session')).status, 200);
  });

  await t.test('a stored value outside the valid set is ignored, not handed to the client', async () => {
    // PUT can't produce this, but a hand-edited row or one written by a release that still had a
    // view this one dropped can - and an unknown view renders a blank page with no tab active,
    // so it must never leave the server. `overridden` reports the override in effect, so an
    // unusable row reads as false.
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    db.setSetting('defaultView', 'nonsense');
    try {
      assert.equal((await admin.get('/api/session')).body.defaultView, 'list');
      assert.deepEqual((await admin.get('/api/settings/default-view')).body, { defaultView: 'list', overridden: false });
    } finally {
      db.deleteSetting('defaultView');
    }
  });
});

test('clientErrorStatus', async (t) => {
  await t.test('a stalled client gets 408, not 400', () => {
    // headersTimeout (30s) and requestTimeout (60s) are both set on the server, and Node surfaces
    // both through clientError as ERR_HTTP_REQUEST_TIMEOUT - its own default answers those 408.
    // Overriding the event means owning that: a flat 400 tells a merely slow client it sent
    // garbage, which behind a reverse proxy is a materially different signal.
    assert.equal(clientErrorStatus('ERR_HTTP_REQUEST_TIMEOUT'), '408 Request Timeout');
  });

  await t.test('anything genuinely malformed still gets 400', () => {
    for (const code of ['HPE_INVALID_METHOD', 'HPE_HEADER_OVERFLOW', 'ECONNRESET', undefined]) {
      assert.equal(clientErrorStatus(code), '400 Bad Request', `${code} should stay a 400`);
    }
  });
});

test('slowThresholdFor', async (t) => {
  await t.test('ordinary routes use the plain threshold', () => {
    assert.equal(slowThresholdFor('/hosts/local/containers'), 5000);
    assert.equal(slowThresholdFor('/session'), 5000);
  });

  await t.test('routes that are legitimately slow are held to their own timeout instead', () => {
    // A `docker stop` waiting out SIGTERM routinely takes ten-plus seconds while working exactly
    // as designed, and `docker system df` was measured at 40-75s cold. Warning about those every
    // time is noise, and noise is what stopped the last real signal being noticed.
    for (const p of ['/hosts/local/containers/abc123/stop', '/hosts/local/containers/abc/restart', '/hosts/local/containers/x/start']) {
      assert.ok(slowThresholdFor(p) > 5000, `${p} should not warn at the ordinary threshold`);
    }
    assert.ok(slowThresholdFor('/hosts/local/disk-usage') > 5000);
    assert.ok(slowThresholdFor('/hosts/local/disk-usage/images') > 5000);
  });

  await t.test('a route that merely mentions a slow word is not exempted', () => {
    // The overrides are anchored, so an unrelated route can't inherit a 30-120s grace by accident.
    assert.equal(slowThresholdFor('/hosts/local/containers/abc/stop/extra'), 5000);
    assert.equal(slowThresholdFor('/disk-usage-summary'), 5000);
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

  // A GET, so the structural walk at the top of this file cannot see it - that one only covers
  // mutating methods. The audit log is who ran what, and its `error` column carries raw docker/ssh
  // stderr, so it sits behind requireAdmin for the same reason inspect masks Config.Env.
  await t.test('viewer session: blocked from the audit log, which the structural walk cannot cover', async () => {
    const viewer = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    assert.equal((await viewer.get('/api/audit')).status, 403);
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await admin.get('/api/audit')).status, 200, 'gating it must not lock out the role that needs it');
  });

  // requireHostQuery, the same middleware DELETE /alerts already had: a typo'd id used to come
  // back 200 {count: 0}, and "there was nothing to acknowledge" is not "no such host".
  await t.test('admin session: ack-all 404s for an unknown host instead of reporting a no-op success', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await admin.post(`/api/alerts/ack-all?hostId=${FAKE_HOST_ID}`)).status, 404);
    assert.equal((await admin.post('/api/alerts/ack-all')).status, 400, 'a missing hostId stays a 400');
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

// :action is written into the audit row and into the *event name* of a log line before
// containerAction ever sees it, and express URL-decodes path params - so an unvalidated one left a
// phantom audit row for an action that never ran, and a newline in it forged a second, perfectly
// well-formed line in `docker logs` and in the app's own Log Viewer. Both are integrity problems
// rather than access ones: requireAdmin already runs first, so only an admin could reach it.
test('container action validation', async (t) => {
  const hostId = loadHosts()[0].id;
  const CONTAINER = 'abcabcabcabc';
  const auditRows = () => db.client.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;

  await t.test('400s on an unsupported action rather than failing out of the docker call as a 502', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const res = await admin.post(`/api/hosts/${hostId}/containers/${CONTAINER}/pause`);
    assert.equal(res.status, 400, 'an unsupported action is a bad request, not a bad gateway');
    assert.match(res.body.error, /invalid container action/);
  });

  // The forging case, encoded exactly as it would arrive over the wire. Rejected at the route, so
  // req.params.action never reaches logger.write - whose event name, unlike its field values, is
  // interpolated raw and would carry the newline straight through into a second log line.
  await t.test('rejects an action carrying a newline before it can forge a log line', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const forged = 'stop%0A%5Bopendockwatch%5D%20%5BINFO%5D%20auth.success%20user=admin';
    const res = await admin.post(`/api/hosts/${hostId}/containers/${CONTAINER}/${forged}`);
    assert.equal(res.status, 400);
  });

  // The audit log is the record of what was actually asked for. A rejected action must leave
  // nothing in it, or the table grows rows for actions that were never attempted.
  await t.test('writes no audit row for an action it rejected', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const before = auditRows();
    await admin.post(`/api/hosts/${hostId}/containers/${CONTAINER}/destroy`);
    assert.equal(auditRows(), before, 'a rejected action still wrote to the audit log');
  });

  // The gate must not have been drawn so tight that it rejects the three real ones. These get past
  // it and are stopped by the unknown host instead, which is as far as this can go without a daemon.
  await t.test('lets the three supported actions through to the host lookup', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    for (const action of ['start', 'stop', 'restart']) {
      const res = await admin.post(`/api/hosts/${FAKE_HOST_ID}/containers/${CONTAINER}/${action}`);
      assert.equal(res.status, 404, `${action} was rejected by the action gate instead of reaching requireHost`);
    }
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

test('POST /api/client-error', async (t) => {
  await t.test('accepts a report from a viewer, not just an admin', async () => {
    // The whole point: a viewer's browser fails the same way an admin's does, and a blank page is
    // exactly what the person least able to describe it is looking at.
    const viewer = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    const res = await viewer.post('/api/client-error').send({ kind: 'vue', message: 'boom', source: 'render function', line: 12 });
    assert.equal(res.status, 204);
    assert.equal(res.text, '', 'fire-and-forget: nothing for the client to parse or fail on');
  });

  await t.test('still requires a session', async () => {
    assert.equal((await request(app).post('/api/client-error').send({ message: 'x' })).status, 401);
  });

  await t.test('survives a junk or empty body rather than 500ing', async () => {
    // It's called from a global error handler, so a report that itself errors would loop.
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await agent.post('/api/client-error').send({})).status, 204);
    assert.equal((await agent.post('/api/client-error').send({ kind: null, message: 12345, line: 'nope' })).status, 204);
  });

  await t.test('a huge message is truncated rather than becoming a megabyte log line', async () => {
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const lines = [];
    const logger = require('../server/logger');
    const realWarn = logger.warn;
    logger.warn = (event, fields) => lines.push({ event, fields });
    try {
      await agent.post('/api/client-error').send({ message: 'x'.repeat(50_000), source: 'y'.repeat(50_000) });
      const rec = lines.find((l) => l.event === 'client.error');
      assert.ok(rec, 'should have logged');
      assert.equal(rec.fields.message.length, 300);
      assert.equal(rec.fields.source.length, 200);
    } finally {
      logger.warn = realWarn;
    }
  });
});

// The four fields of /dashboard are the four routes the poll loop used to call one after another.
// They share builder functions precisely so the bundle can't drift from them - these assert that
// it hasn't, field by field, which is the failure this consolidation could actually cause: a
// change to /containers that never reaches the response the app is now reading instead.
//
// The snapshot is stubbed so nothing here shells out to docker, keeping this file's existing
// property that `npm test` never spawns a CLI. Note the bundle deliberately excludes topology -
// that one can shell out, so it stays its own route and the client runs it in parallel instead.
test('GET /hosts/:hostId/dashboard', async (t) => {
  // Whichever host this checkout's config actually has - the example config in CI and a real
  // hosts.json locally both work, and hardcoding an id would pass in one and 404 in the other.
  const hostId = loadHosts()[0].id;
  const SNAPSHOT = {
    reachable: true,
    statsTs: Date.now(),
    containers: [
      { id: 'aaaaaaaaaaaa', name: 'web', state: 'running', image: 'nginx', composeProject: 'shop' },
      { id: 'bbbbbbbbbbbb', name: 'db', state: 'exited', image: 'postgres', composeProject: 'shop' },
    ],
    stats: { aaaaaaaaaaaa: { cpuPerc: '1.5%', memUsage: '10MiB / 1GiB', memPerc: '1.0%', netRxBytes: 12 } },
    hostInfo: { ncpu: 4, memTotalBytes: 1e9 },
  };

  const withSnapshot = (t2) => t2.mock.method(metricsCollector, 'getSnapshot', () => SNAPSHOT);

  // Seeded, and this is load-bearing rather than incidental: against an empty database every
  // parity assertion below compares two empty arrays and passes no matter what the bundle asked
  // for. Verified by mutation - pointing metricsHistory at the 24h range, and dropping the host
  // scope from the alerts read, both survived the whole suite until these rows existed. So the
  // history spans the 1h boundary and the alerts span two hosts, giving each one something to be
  // wrong about.
  const now = Date.now();
  const OTHER_HOST = '__index_test_other_host__';
  for (const agoMs of [60_000, 120_000, 5 * 3_600_000]) {
    db.insertHostMetric({
      hostId,
      ts: now - agoMs,
      cpuPercent: 12.5,
      memUsedBytes: 1024,
      systemCpuPercent: null,
      systemMemUsedBytes: null,
      systemMemTotalBytes: null,
    });
  }
  for (const [h, rule] of [
    [hostId, 'container_cpu'],
    [hostId, 'container_mem'],
    [OTHER_HOST, 'container_cpu'],
  ]) {
    db.insertAlert({
      ts: now - 60_000,
      hostId: h,
      containerId: 'aaaaaaaaaaaa',
      containerName: 'web',
      rule,
      severity: 'warning',
      message: `${rule} on ${h}`,
    });
  }

  await t.test('carries exactly the four fields, and not topology', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const res = await agent.get(`/api/hosts/${hostId}/dashboard`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['alerts', 'containers', 'metricsHistory', 'stats']);
  });

  await t.test('its containers match GET /containers exactly', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const bundle = await agent.get(`/api/hosts/${hostId}/dashboard`);
    const single = await agent.get(`/api/hosts/${hostId}/containers`);
    assert.equal(single.status, 200);
    assert.deepEqual(bundle.body.containers, single.body);
    // Not just equal to each other but actually built: the restart count is the field /containers
    // adds on top of the snapshot, and two empty arrays would satisfy a bare deepEqual.
    assert.equal(bundle.body.containers.length, 2);
    assert.ok('restartCount1h' in bundle.body.containers[0]);
  });

  await t.test('its stats match GET /stats exactly', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const bundle = await agent.get(`/api/hosts/${hostId}/dashboard`);
    const single = await agent.get(`/api/hosts/${hostId}/stats`);
    assert.equal(single.status, 200);
    assert.deepEqual(bundle.body.stats, single.body);
    assert.equal(bundle.body.stats.aaaaaaaaaaaa.cpuPerc, '1.5%');
  });

  // The bundle hardcodes the 1h range because that is the window the host card's live tiles draw;
  // if the route's default ever moved, the two would quietly start returning different buckets.
  await t.test('its history matches GET /metrics/history at the 1h range', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const bundle = await agent.get(`/api/hosts/${hostId}/dashboard`);
    const single = await agent.get(`/api/hosts/${hostId}/metrics/history?range=1h`);
    assert.equal(single.status, 200);
    assert.deepEqual(bundle.body.metricsHistory, single.body);
    // Two of the three seeded rows are inside the hour and one is five hours out. Compared by
    // window rather than by row count: both ranges happen to bucket those three into two rows
    // each (15s vs 5min buckets), so a length comparison discriminates nothing.
    const wider = await agent.get(`/api/hosts/${hostId}/metrics/history?range=24h`);
    const anHourAgo = Date.now() - 3_600_000;
    assert.ok(bundle.body.metricsHistory.length > 0, 'nothing to compare - the seed did not land');
    assert.ok(
      bundle.body.metricsHistory.every((r) => r.bucket >= anHourAgo - 60_000),
      'the bundle returned buckets older than an hour, so it is not pinned to the 1h range'
    );
    assert.ok(
      wider.body.some((r) => r.bucket < anHourAgo),
      'the 24h range returned nothing older than an hour, so the check above proves nothing'
    );
  });

  await t.test('its alerts match GET /alerts for the same host and limit', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const bundle = await agent.get(`/api/hosts/${hostId}/dashboard`);
    const single = await agent.get(`/api/alerts?hostId=${encodeURIComponent(hostId)}&limit=100`);
    assert.equal(single.status, 200);
    assert.deepEqual(bundle.body.alerts, single.body);
    assert.ok(bundle.body.alerts.length > 0, 'nothing to compare - the seed did not land');
  });

  // It is scoped to one host, unlike /alerts which serves every host when given no hostId - and
  // the seed puts an alert on a second host specifically so an unscoped read would show up here.
  await t.test('its alerts are scoped to the host in the path', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const bundle = await agent.get(`/api/hosts/${hostId}/dashboard`);
    const allHosts = await agent.get('/api/alerts?limit=100');
    for (const a of bundle.body.alerts) assert.equal(a.host_id, hostId);
    assert.ok(allHosts.body.length > bundle.body.alerts.length, 'the unscoped read returned no more, so scoping proves nothing here');
  });

  await t.test('a viewer can read it - it replaced four routes a viewer could already read', async (t2) => {
    withSnapshot(t2);
    const agent = await loginAs(VIEWER_USER, VIEWER_PASSWORD);
    assert.equal((await agent.get(`/api/hosts/${hostId}/dashboard`)).status, 200);
  });

  await t.test('an unknown host 404s rather than building an empty bundle', async () => {
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await agent.get(`/api/hosts/${FAKE_HOST_ID}/dashboard`)).status, 404);
  });

  await t.test('it needs a session', async () => {
    assert.equal((await request(app).get(`/api/hosts/${hostId}/dashboard`)).status, 401);
  });
});

// The Activity tab's "Clear" buttons over HTTP: that each route reaches the right db call for the
// host it was given, and answers a bad one properly. What a clear does to the rows - soft, scoped,
// and what stays visible to the cooldown and the restart counters - is db.test.js's job, not a
// second copy here. Auth is covered structurally: see the requireAdmin walk at the top of the file.
test('DELETE /alerts and DELETE /hosts/:hostId/events clear stored rows', async (t) => {
  const hostId = loadHosts()[0].id;
  const now = Date.now();

  await t.test('DELETE /alerts 400s without a hostId - a Clear button acts on one host, never all of them', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await admin.delete('/api/alerts')).status, 400);
  });

  await t.test('admin clears alerts and events for the host, and reports what it cleared', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    db.insertAlert({
      ts: now,
      hostId,
      containerId: 'aaaaaaaaaaaa',
      containerName: 'web',
      rule: 'container_cpu',
      severity: 'warning',
      message: 'x',
    });
    db.insertEvent({ hostId, containerId: 'aaaaaaaaaaaa', containerName: 'web', action: 'start', ts: now, rawJson: '{}' });

    // Other test blocks in this file seed alerts on the real host too, so the pre-clear count
    // isn't necessarily just the one inserted above - read it rather than assume it.
    const beforeCount = (await admin.get(`/api/alerts?hostId=${hostId}`)).body.length;
    assert.ok(beforeCount >= 1, 'nothing to clear - the seed above did not land');

    const clearAlerts = await admin.delete(`/api/alerts?hostId=${hostId}`);
    assert.equal(clearAlerts.status, 200);
    assert.equal(clearAlerts.body.count, beforeCount);
    assert.equal((await admin.get(`/api/alerts?hostId=${hostId}`)).body.length, 0);

    const beforeEventCount = (await admin.get(`/api/hosts/${hostId}/events`)).body.length;
    assert.ok(beforeEventCount >= 1, 'nothing to clear - the seed above did not land');

    const clearEvents = await admin.delete(`/api/hosts/${hostId}/events`);
    assert.equal(clearEvents.status, 200);
    assert.equal(clearEvents.body.count, beforeEventCount);
    assert.equal((await admin.get(`/api/hosts/${hostId}/events`)).body.length, 0);
  });

  // The two clears scope their host differently - a path segment for events, ?hostId= for alerts -
  // and used to answer an unknown host differently with it: 404 from requireHost, versus a 200 and
  // a count of 0 for a typo'd id that matched no rows because no such host was ever monitored.
  await t.test('both clears 404 for an unknown host', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal((await admin.delete(`/api/hosts/${FAKE_HOST_ID}/events`)).status, 404);
    assert.equal((await admin.delete(`/api/alerts?hostId=${FAKE_HOST_ID}`)).status, 404);
  });

  // cleared_at records when a clear happened; only the audit log records who, and it is the one
  // table a clear doesn't touch. The subtest above already issued one of each as ADMIN_USER.
  await t.test('both clears leave an audit row naming the admin who ran them', async () => {
    const admin = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const rows = (await admin.get(`/api/audit?hostId=${hostId}`)).body;
    for (const action of ['clear_alerts', 'clear_events']) {
      const row = rows.find((r) => r.action === action);
      assert.ok(row, `no audit row for ${action}`);
      assert.equal(row.username, ADMIN_USER);
      assert.equal(row.result, 'ok');
      assert.equal(row.container_id, null, 'a clear is host-wide, not about one container');
    }
  });

  // The manual-stop/start suppression in alerts.js reads the same table by action, and a clear
  // row that landed in either count would suppress a real crash_loop or container_crashed alert.
  await t.test('a clear row cannot be read as a manual container action', () => {
    assert.equal(db.countManualStopsSince(hostId, 'aaaaaaaaaaaa', 0), 0);
    assert.equal(db.countManualStartsSince(hostId, 'aaaaaaaaaaaa', 0), 0);
  });
});

// A page load is ~44 separate requests because there is no build step, and every one of them used
// to be a conditional round trip. These cover the two halves of the fix: assets are cacheable
// forever under a version-pinned URL, and the HTML that points at them never is.
test('asset caching', async (t) => {
  const { version } = require('../package.json');
  const PREFIX = `/assets/v${version}`;

  await t.test('a version-pinned asset is immutable and cacheable for a year', async () => {
    const res = await request(app).get(`${PREFIX}/js/app.js`);
    assert.equal(res.status, 200);
    const cc = res.headers['cache-control'];
    assert.match(cc, /max-age=31536000/, `expected a year of max-age, got "${cc}"`);
    assert.match(cc, /immutable/, `expected immutable, got "${cc}"`);
  });

  await t.test('vendor scripts get it too - they are the bulk of the bytes', async () => {
    const res = await request(app).get(`${PREFIX}/vendor/vue.global.prod.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers['cache-control'], /immutable/);
  });

  // The whole approach rests on this: relative imports resolve against the importing module's own
  // URL, so pointing the HTML at the pinned prefix pulls the entire module graph under it. If the
  // nested path did not resolve, 34 of the 35 modules would quietly fall back to the bare mount.
  await t.test('nested modules resolve under the prefix, which is what pins the whole graph', async () => {
    for (const p of ['/js/format.js', '/js/components/LogViewer.js', '/js/lib/logStream.js', '/style.css']) {
      const res = await request(app).get(PREFIX + p);
      assert.equal(res.status, 200, `${p} is not served under the version prefix`);
      assert.match(res.headers['cache-control'], /immutable/);
    }
  });

  // A browser still holding the previous release's index.html must keep working rather than 404
  // its way to a blank page, so the bare paths stay served - just not cached anywhere near as long.
  await t.test('the bare path still serves, and is not immutable', async () => {
    const res = await request(app).get('/assets/js/app.js');
    assert.equal(res.status, 200);
    assert.equal(/immutable/.test(res.headers['cache-control'] || ''), false, 'the unversioned path must stay revalidatable');
  });

  await t.test('a stale version prefix 404s rather than serving something', async () => {
    assert.equal((await request(app).get('/assets/v0.0.0-not-a-release/js/app.js')).status, 404);
  });

  // The HTML is the pointer to everything above. Serve a stale copy and the browser keeps loading
  // the previous release's assets out of its own cache, indefinitely and with no way to notice.
  await t.test('the HTML pages are never cached', async () => {
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    for (const [label, res] of [
      ['login', await request(app).get('/login')],
      ['index', await agent.get('/')],
    ]) {
      assert.equal(res.status, 200);
      assert.match(res.headers['cache-control'] || '', /no-cache/, `${label} is cacheable`);
      assert.doesNotMatch(res.headers['cache-control'] || '', /max-age=[1-9]/, `${label} carries a real max-age`);
    }
  });

  await t.test('both pages point at the version-pinned prefix, not the bare one', async () => {
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    for (const [label, res] of [
      ['login', await request(app).get('/login')],
      ['index', await agent.get('/')],
    ]) {
      assert.match(res.text, new RegExp(PREFIX.replace(/\./g, '\\.')), `${label} references no pinned asset`);
      // No bare /assets/ reference may survive the rewrite, or that asset alone would be served
      // from the short-lived mount while everything around it is pinned.
      assert.doesNotMatch(res.text, /"\/assets\/(?!v)/, `${label} still references an unpinned /assets/ path`);
    }
  });

  await t.test('the index page still carries the module entry point and every vendor script', async () => {
    const agent = await loginAs(ADMIN_USER, ADMIN_PASSWORD);
    const res = await agent.get('/');
    assert.match(res.text, new RegExp(`<script type="module" src="${PREFIX.replace(/\./g, '\\.')}/js/app\\.js"`));
    for (const v of ['vue.global.prod.js', 'cytoscape.min.js', 'dagre.min.js', 'html2canvas-pro.min.js']) {
      assert.ok(res.text.includes(`${PREFIX}/vendor/${v}`), `${v} is not loaded from the pinned prefix`);
    }
  });
});
