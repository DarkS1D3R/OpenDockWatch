const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '../config');
const HOSTS_FILE = path.join(CONFIG_DIR, 'hosts.json');
const EXAMPLE_FILE = path.join(CONFIG_DIR, 'hosts.example.json');

let cache = null;

function readHostsFile() {
  const file = fs.existsSync(HOSTS_FILE) ? HOSTS_FILE : EXAMPLE_FILE;
  if (file === EXAMPLE_FILE) {
    console.warn(`[opendockwatch] config/hosts.json not found, using config/hosts.example.json - copy it to hosts.json and edit for real use.`);
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

// Invalidate on any change under config/ - covers editing hosts.json in place
// and hosts.json being created/removed (which switches the active file) -
// so config changes apply without restarting the process. unref() so this
// background watcher alone doesn't keep the process (or a test run
// requiring this module) alive.
try {
  fs.watch(CONFIG_DIR, () => {
    cache = null;
  }).unref();
} catch (err) {
  console.warn(`[opendockwatch] could not watch ${CONFIG_DIR} for changes: ${err.message}`);
}

module.exports = { loadHosts, getHost };
