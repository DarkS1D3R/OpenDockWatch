const ICON_RUNNING = `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="5" fill="none" stroke="#3fb950" stroke-width="1.4"/><circle cx="6" cy="6" r="2.2" fill="#3fb950"/></svg>`;
const ICON_RESTARTING = `<svg class="state-icon state-icon-spin" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 4.5A4 4 0 1 0 10 6.5" fill="none" stroke="#4f8cff" stroke-width="1.4" stroke-linecap="round"/><path d="M9.5 2v2.5H7" fill="none" stroke="#4f8cff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_PAUSED = `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="2" width="2" height="8" rx="0.6" fill="#8b909c"/><rect x="7" y="2" width="2" height="8" rx="0.6" fill="#8b909c"/></svg>`;
const ICON_STOPPED = `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="#8b909c" stroke-width="1.4"/></svg>`;

export function stateEmoji(state) {
  if (state === 'running') return ICON_RUNNING;
  if (state === 'restarting') return ICON_RESTARTING;
  if (state === 'paused') return ICON_PAUSED;
  return ICON_STOPPED;
}

// Keyword -> badge lookup, checked in order against "<image> <composeService>" (lowercase).
// First match wins, so more specific keywords are listed before generic ones.
const SERVICE_BADGES = [
  [/pgadmin/, { text: 'PA', bg: '#6d9f3d' }],
  [/postgres|postgis/, { text: 'Pg', bg: '#336791' }],
  [/mariadb/, { text: 'Ma', bg: '#c0765a' }],
  [/mysql/, { text: 'My', bg: '#4479a1' }],
  [/mongo/, { text: 'Mo', bg: '#47a248' }],
  [/redis/, { text: 'Re', bg: '#d82c20' }],
  [/rabbitmq/, { text: 'Rb', bg: '#ff6600' }],
  [/activemq/, { text: 'Mq', bg: '#a2122e' }],
  [/camel/, { text: 'Cm', bg: '#d04437' }],
  [/nginx/, { text: 'Nx', bg: '#269639' }],
  [/traefik/, { text: 'Tf', bg: '#24a1c1' }],
  [/grafana/, { text: 'Gf', bg: '#f46800' }],
  [/prometheus/, { text: 'Pr', bg: '#e6522c' }],
  [/elasticsearch/, { text: 'Es', bg: '#005571' }],
  [/kibana/, { text: 'Kb', bg: '#005571' }],
  [/spring/, { text: 'Sp', bg: '#6db33f' }],
  [/openjdk|temurin|corretto|zulu|\bjdk\b|\bjre\b/, { text: 'Jv', bg: '#f89820' }],
  [/node/, { text: 'Nd', bg: '#339933' }],
  [/python/, { text: 'Py', bg: '#3776ab' }],
  [/httpd|apache/, { text: 'Ap', bg: '#d22128' }],
];

export function iconFor(image, composeService) {
  const haystack = `${image || ''} ${composeService || ''}`.toLowerCase();
  for (const [pattern, badge] of SERVICE_BADGES) {
    if (pattern.test(haystack)) return badge;
  }
  const initial = (composeService || image || '?').trim().charAt(0).toUpperCase() || '?';
  return { text: initial, bg: '#4f8cff' };
}

const MEM_UNIT_BYTES = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 };

export function parseMemUsedBytes(memUsageStr) {
  if (!memUsageStr) return 0;
  const used = memUsageStr.split('/')[0].trim();
  const m = used.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  const mult = MEM_UNIT_BYTES[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}

export function formatGB(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

const HEALTH_COLOR = { healthy: '#3fb950', unhealthy: '#f85149', starting: '#d29922' };

export function healthColor(health) {
  return HEALTH_COLOR[health] || null;
}

export function healthLabel(health) {
  if (!health) return '';
  return health === 'starting' ? 'health: starting' : health;
}

// Checked in order (most severe first) since a line can contain more than one of these words
// incidentally - e.g. an info line mentioning "retrying after error" should still read as info
// in ambiguous cases, but in practice explicit level tags (ERROR/WARN/...) dominate real logs.
const LEVEL_PATTERNS = [
  ['error', /\b(error|fatal|severe)\b/i],
  ['warn', /\b(warn|warning)\b/i],
  ['info', /\b(info|notice)\b/i],
  ['debug', /\b(debug|trace|verbose)\b/i],
];

export function detectLogLevel(line) {
  for (const [level, re] of LEVEL_PATTERNS) {
    if (re.test(line)) return level;
  }
  return null;
}

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Escapes the line for safe innerHTML use, then wraps case-insensitive matches of
// `filterText` in <mark> so v-html can render the highlight.
export function highlightLine(line, filterText) {
  const escaped = escapeHtml(line);
  if (!filterText) return escaped;
  const re = new RegExp(escapeRegExp(filterText), 'gi');
  return escaped.replace(re, (match) => `<mark class="log-highlight">${match}</mark>`);
}
