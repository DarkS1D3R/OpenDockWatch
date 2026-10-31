// The tabs the app can land on after login (DEFAULT_VIEW / Settings > General). Its own module so
// test/sharedConstants.test.js can compare it with public/js/constants.js's VIEWS without opening the db.
const VALID_VIEWS = new Set(['overview', 'list', 'flow', 'logs', 'activity', 'uptime', 'resources']);

module.exports = { VALID_VIEWS };
