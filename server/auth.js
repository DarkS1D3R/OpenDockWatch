const bcrypt = require('bcryptjs');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  return res.redirect('/login');
}

async function verifyLogin(username, password) {
  const expectedUser = process.env.AUTH_USER;
  const expectedHash = process.env.AUTH_PASS_HASH;
  if (!expectedUser || !expectedHash) {
    throw new Error('AUTH_USER / AUTH_PASS_HASH not configured in .env');
  }
  if (username !== expectedUser) return false;
  return bcrypt.compare(password, expectedHash);
}

module.exports = { requireAuth, verifyLogin };
