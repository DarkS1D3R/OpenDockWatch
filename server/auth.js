const bcrypt = require('bcryptjs');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // req.path is relative to the mount point inside the api sub-router (e.g.
  // '/hosts', not '/api/hosts'), so it never starts with '/api' there -
  // req.originalUrl keeps the full path regardless of router nesting.
  if (req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  return res.redirect('/login');
}

// Viewer sessions pass requireAuth (they can look at everything it gates) but
// must not be able to start/stop/restart containers - this guards those
// routes specifically.
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'read-only account - admin required' });
}

async function verifyLogin(username, password) {
  const expectedUser = process.env.AUTH_USER;
  const expectedHash = process.env.AUTH_PASS_HASH;
  if (!expectedUser || !expectedHash) {
    throw new Error('AUTH_USER / AUTH_PASS_HASH not configured in .env');
  }
  // A login POST missing either field is just a failed login, not a server fault - without this
  // bcrypt.compare(undefined, hash) throws and the route answers 500 instead of 401.
  if (typeof username !== 'string' || typeof password !== 'string') {
    return null;
  }

  const viewerUser = process.env.VIEWER_USER;
  const viewerHash = process.env.VIEWER_PASS_HASH;

  // Both bcrypt.compare calls always run rather than short-circuiting on username match first -
  // that would make a wrong-username request return near-instantly while a right-username one
  // pays bcrypt's ~100ms, an observable timing side-channel leaking whether a username is valid.
  const adminMatch = await bcrypt.compare(password, expectedHash);
  const viewerMatch = viewerUser && viewerHash ? await bcrypt.compare(password, viewerHash) : false;

  if (username === expectedUser && adminMatch) {
    return { username, role: 'admin' };
  }
  if (viewerUser && username === viewerUser && viewerMatch) {
    return { username, role: 'viewer' };
  }

  return null;
}

module.exports = { requireAuth, requireAdmin, verifyLogin };
