const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { requireAuth, requireAdmin, verifyLogin } = require('../server/auth');

function withEnv(t, vars) {
  const originals = {};
  for (const [key, value] of Object.entries(vars)) {
    originals[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function mockRes() {
  const res = { statusCode: null, body: null, redirectedTo: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.redirect = (to) => {
    res.redirectedTo = to;
    return res;
  };
  return res;
}

test('verifyLogin', async (t) => {
  const adminHash = bcrypt.hashSync('adminpass', 4);
  const viewerHash = bcrypt.hashSync('viewerpass', 4);

  await t.test('accepts the admin account and returns role admin', async () => {
    withEnv(t, { AUTH_USER: 'admin', AUTH_PASS_HASH: adminHash, VIEWER_USER: undefined, VIEWER_PASS_HASH: undefined });
    assert.deepEqual(await verifyLogin('admin', 'adminpass'), { username: 'admin', role: 'admin' });
  });

  await t.test('rejects a wrong admin password', async () => {
    withEnv(t, { AUTH_USER: 'admin', AUTH_PASS_HASH: adminHash });
    assert.equal(await verifyLogin('admin', 'wrong'), null);
  });

  await t.test('accepts the viewer account and returns role viewer', async () => {
    withEnv(t, { AUTH_USER: 'admin', AUTH_PASS_HASH: adminHash, VIEWER_USER: 'viewer', VIEWER_PASS_HASH: viewerHash });
    assert.deepEqual(await verifyLogin('viewer', 'viewerpass'), { username: 'viewer', role: 'viewer' });
  });

  await t.test('rejects the viewer username when no viewer account is configured', async () => {
    withEnv(t, { AUTH_USER: 'admin', AUTH_PASS_HASH: adminHash, VIEWER_USER: undefined, VIEWER_PASS_HASH: undefined });
    assert.equal(await verifyLogin('viewer', 'viewerpass'), null);
  });

  await t.test('throws when AUTH_USER / AUTH_PASS_HASH are not configured', async () => {
    withEnv(t, { AUTH_USER: undefined, AUTH_PASS_HASH: undefined });
    await assert.rejects(() => verifyLogin('admin', 'adminpass'));
  });
});

test('requireAuth', async (t) => {
  await t.test('calls next() for an authenticated session', () => {
    let called = false;
    requireAuth({ session: { authenticated: true }, originalUrl: '/api/hosts' }, mockRes(), () => (called = true));
    assert.equal(called, true);
  });

  await t.test('returns 401 JSON for an unauthenticated /api request (originalUrl, not the router-relative path)', () => {
    const res = mockRes();
    // Inside the api sub-router, req.path would already have the /api prefix
    // stripped (e.g. '/hosts') - originalUrl is what still has it.
    requireAuth({ session: {}, path: '/hosts', originalUrl: '/api/hosts' }, res, () => {});
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'unauthenticated' });
  });

  await t.test('redirects to /login for an unauthenticated page request', () => {
    const res = mockRes();
    requireAuth({ session: {}, path: '/', originalUrl: '/' }, res, () => {});
    assert.equal(res.redirectedTo, '/login');
  });
});

test('requireAdmin', async (t) => {
  await t.test('calls next() for an admin session', () => {
    let called = false;
    requireAdmin({ session: { role: 'admin' } }, mockRes(), () => (called = true));
    assert.equal(called, true);
  });

  await t.test('returns 403 for a viewer session', () => {
    const res = mockRes();
    requireAdmin({ session: { role: 'viewer' } }, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  await t.test('returns 403 with no session role at all', () => {
    const res = mockRes();
    requireAdmin({ session: {} }, res, () => {});
    assert.equal(res.statusCode, 403);
  });
});
