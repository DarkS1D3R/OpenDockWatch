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
  if (username === expectedUser && (await bcrypt.compare(password, expectedHash))) {
    return { username, role: 'admin' };
  }

  const viewerUser = process.env.VIEWER_USER;
  const viewerHash = process.env.VIEWER_PASS_HASH;
  if (viewerUser && viewerHash && username === viewerUser && (await bcrypt.compare(password, viewerHash))) {
    return { username, role: 'viewer' };
  }

  return null;
}

module.exports = { requireAuth, requireAdmin, verifyLogin };
