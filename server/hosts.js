const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CONFIG_DIR = path.join(__dirname, '../config');
const HOSTS_FILE = path.join(CONFIG_DIR, 'hosts.json');
const EXAMPLE_FILE = path.join(CONFIG_DIR, 'hosts.example.json');

let cache = null;

function readHostsFile() {
  const file = fs.existsSync(HOSTS_FILE) ? HOSTS_FILE : EXAMPLE_FILE;
  if (file === EXAMPLE_FILE) {
    logger.warn('hosts.config.missing', { using: 'config/hosts.example.json', hint: 'copy it to config/hosts.json and edit for real use' });
  }
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadHosts() {
  if (!cache) cache = readHostsFile();
  return cache;
}

function getHost(id) {
  return loadHosts().find((h) => h.id === id);
}

// Always writes hosts.json (even if the process booted from hosts.example.json), so the first
// GUI-added host is what promotes a fresh install off the example file for good.
function saveHosts(list) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  cache = list;
}

const HOST_ID_RE = /^[a-zA-Z0-9_-]+$/;

function isValidHostId(id) {
  return typeof id === 'string' && HOST_ID_RE.test(id);
}

// A blank dockerHost means "local socket", which is always valid - only a non-blank value needs
// to actually be a well-formed ssh:// URL (the only remote transport the docker CLI supports here).
function isValidDockerHostUrl(url) {
  if (!url) return true;
  try {
    return new URL(url).protocol === 'ssh:';
  } catch {
    return false;
  }
}

// Two hosts both pointing at the local socket would just monitor the same daemon twice under
// different ids - excludeId lets an edit check against every *other* host without tripping on
// itself when it was already the local one.
function hasLocalHost(hosts, excludeId = null) {
  return hosts.some((h) => !h.dockerHost && h.id !== excludeId);
}

// Invalidate on any change under config/ - covers editing hosts.json in place and it being
// created/removed (which switches the active file) - so config changes apply live. unref() so
// this background watcher alone doesn't keep the process (or a test requiring this module) alive.
try {
  fs.watch(CONFIG_DIR, () => {
    cache = null;
  }).unref();
} catch (err) {
  logger.warn('hosts.config.watch_failed', { dir: CONFIG_DIR, error: err.message });
}

module.exports = { loadHosts, getHost, saveHosts, isValidHostId, isValidDockerHostUrl, hasLocalHost };
