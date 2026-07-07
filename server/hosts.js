const fs = require('fs');
const path = require('path');

const HOSTS_FILE = path.join(__dirname, '../config/hosts.json');
const EXAMPLE_FILE = path.join(__dirname, '../config/hosts.example.json');

function loadHosts() {
  const file = fs.existsSync(HOSTS_FILE) ? HOSTS_FILE : EXAMPLE_FILE;
  if (file === EXAMPLE_FILE) {
    console.warn(`[opendockwatch] config/hosts.json not found, using config/hosts.example.json - copy it to hosts.json and edit for real use.`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function getHost(id) {
  return loadHosts().find((h) => h.id === id);
}

module.exports = { loadHosts, getHost };
