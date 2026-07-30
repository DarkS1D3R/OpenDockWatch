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
const { app, api } = require('../server/index');
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
