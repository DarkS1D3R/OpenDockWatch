import { ACCENT, MUTED, STATE_COLORS } from './theme.js';

// Values from theme.js, but the *mapping* lives here: docker's health axis says "healthy", the
// state axis says "running", and they are one colour. Declared up here rather than beside
// healthColor so the icons below can build from it at load - a const is in its TDZ until then.
const HEALTH_COLOR = { healthy: STATE_COLORS.running, unhealthy: STATE_COLORS.unhealthy, starting: STATE_COLORS.starting };

// Running is the only state with a second axis worth showing - health. Same dot shape, colored per
// HEALTH_COLOR rather than one flat green, so "running" stops reading as "fine" for a container
// that's still starting or has failed its healthcheck. Stopped/exited stay the plain gray square -
// there's no health to report once a container isn't running.
function runningIcon(color) {
  return `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="5" fill="none" stroke="${color}" stroke-width="1.4"/><circle cx="6" cy="6" r="2.2" fill="${color}"/></svg>`;
}
const ICON_RUNNING = runningIcon(HEALTH_COLOR.healthy);
const ICON_RUNNING_STARTING = runningIcon(HEALTH_COLOR.starting);
const ICON_RUNNING_UNHEALTHY = runningIcon(HEALTH_COLOR.unhealthy);
const ICON_RESTARTING = `<svg class="state-icon state-icon-spin" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 4.5A4 4 0 1 0 10 6.5" fill="none" stroke="${ACCENT}" stroke-width="1.4" stroke-linecap="round"/><path d="M9.5 2v2.5H7" fill="none" stroke="${ACCENT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_PAUSED = `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="2" width="2" height="8" rx="0.6" fill="${MUTED}"/><rect x="7" y="2" width="2" height="8" rx="0.6" fill="${MUTED}"/></svg>`;
const ICON_STOPPED = `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="${STATE_COLORS.stopped}" stroke-width="1.4"/></svg>`;
// Same square as ICON_STOPPED but dashed and in the created colour, not the stopped one: a
// container that was `docker create`d but never started is not the same fact as one that ran and
// exited, and the two used to be indistinguishable (both fell into the generic "else" branch below).
const ICON_CREATED = `<svg class="state-icon" width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="${STATE_COLORS.created}" stroke-width="1.4" stroke-dasharray="2 1.5"/></svg>`;

export function stateEmoji(state, health) {
  if (state === 'running') {
    if (health === 'unhealthy') return ICON_RUNNING_UNHEALTHY;
    if (health === 'starting') return ICON_RUNNING_STARTING;
    return ICON_RUNNING;
  }
  if (state === 'restarting') return ICON_RESTARTING;
  if (state === 'paused') return ICON_PAUSED;
  if (state === 'created') return ICON_CREATED;
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
  return { text: initial, bg: ACCENT };
}

// Forked from docker.js's BYTE_UNIT_MULT (CJS/ESM can't share a module here) - kept identical by
// test/sharedConstants.test.js rather than by hand. Exported so that test can reach it.
export const MEM_UNIT_BYTES = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 };

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

const BYTE_UNITS = [
  [1e9, 'GB'],
  [1e6, 'MB'],
  [1e3, 'kB'],
];

// Auto-scaling counterpart to formatGB, for figures that aren't reliably host-sized - a
// container using 412 MB reads as "0.4 GB" through formatGB, losing the digits that matter.
// Host totals stay GB-scale via formatGB; same unit table shape as formatRate below.
export function formatBytes(bytes) {
  if (bytes == null) return '—';
  for (const [threshold, unit] of BYTE_UNITS) {
    if (bytes >= threshold) return `${(bytes / threshold).toFixed(1)} ${unit}`;
  }
  return `${Math.round(bytes)} B`;
}

const RATE_UNITS = [
  [1e9, 'GB/s'],
  [1e6, 'MB/s'],
  [1e3, 'kB/s'],
];

// bytesPerSec is null with no prior poll to diff against yet (just started, restarted, or a
// hiccuped poll) - shown as a flat 0 B/s rather than flickering between that and a "—"
// placeholder every time a poll happens to come back without one.
export function formatRate(bytesPerSec) {
  if (bytesPerSec == null) return '0 B/s';
  for (const [threshold, unit] of RATE_UNITS) {
    if (bytesPerSec >= threshold) return `${(bytesPerSec / threshold).toFixed(1)} ${unit}`;
  }
  return `${Math.round(bytesPerSec)} B/s`;
}

export function formatRatePair(a, b) {
  return `${formatRate(a)} / ${formatRate(b)}`;
}

// Docker's Ports string ("0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp") - only "->" entries
// are published; IPv4/IPv6 dedup to one. Returns each as docker run's "host:container" notation
// (e.g. "8080:80") since showing only the host side is wrong whenever they differ. Not truncated.
export function parsePublishedPorts(portsStr) {
  if (!portsStr) return '';
  const mappings = [...new Set([...portsStr.matchAll(/:(\d+)->(\d+)\/\w+/g)].map((m) => `${m[1]}:${m[2]}`))];
  return mappings.join(', ');
}

// HEALTH_COLOR itself is declared at the top of this file - see the note there for why.
export function healthColor(health) {
  return HEALTH_COLOR[health] || null;
}

export function healthLabel(health) {
  if (!health) return '';
  return health === 'starting' ? 'health: starting' : health;
}

// Docker container event actions mapped onto the same severity vocabulary the alert rows already
// use, so one colour language covers both Activity columns. Anything unlisted stays neutral on
// purpose: exec_create/attach/commit/resize and friends are routine noise, and colouring them too
// would drown the handful of rows worth spotting. See ActivityView.js.
const EVENT_SEVERITY = {
  die: 'critical',
  oom: 'critical',
  kill: 'critical',
  stop: 'warning',
  restart: 'warning',
  pause: 'warning',
  destroy: 'warning',
  start: 'ok',
  create: 'ok',
  unpause: 'ok',
};

export function eventSeverity(action) {
  if (!action) return null;
  // Health events arrive as "health_status: healthy"/"health_status: unhealthy". Test the negative
  // first - "unhealthy" contains "healthy", so the obvious order gets it exactly backwards.
  if (action.startsWith('health_status:')) return action.includes('unhealthy') ? 'critical' : 'ok';
  return EVENT_SEVERITY[action] || null;
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

// Many containers (color-aware console apps) emit raw ANSI SGR escapes like "\x1b[34mINFO" -
// fine in a terminal, garbage once piped through a non-terminal reader. Maps the common 8/16-color
// foreground codes; anything else (background, cursor moves) is simply dropped.
// Deliberately NOT built from theme.js, despite 31/32/33 happening to hold the same three hexes:
// this is a terminal palette reproducing what the container meant by "red", not this app's state
// vocabulary. Repointing it at STATE_COLORS would tie log rendering to the dashboard's design.
const ANSI_COLOR_MAP = {
  30: '#6e7681',
  31: '#f85149',
  32: '#3fb950',
  33: '#d29922',
  34: '#58a6ff',
  35: '#bc8cff',
  36: '#39c5cf',
  37: '#c9d1d9',
  90: '#6e7681',
  91: '#ff7b72',
  92: '#56d364',
  93: '#e3b341',
  94: '#79c0ff',
  95: '#d2a8ff',
  96: '#56d4dd',
  97: '#f0f6fc',
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

// Plain-text version with ANSI codes removed - needed wherever a line is matched against a
// word-boundary regex (detectLogLevel's \b), since e.g. "\x1b[34mINFO" has "m" sitting directly
// against "INFO" with no boundary, silently breaking \b there.
export function stripAnsi(str) {
  return str.includes('\x1b[') ? str.replace(ANSI_STRIP_RE, '') : str;
}

// Splits a line on ANSI SGR escape codes into styled segments the caller can turn into
// <span style="..."> chunks. Segments carry the color/bold state active at that point;
// unstyled runs have color:null, bold:false.
export function parseAnsiSegments(line) {
  if (!line.includes('\x1b[')) return [{ text: line, color: null, bold: false }];
  const segments = [];
  let color = null;
  let bold = false;
  let lastIndex = 0;
  ANSI_RE.lastIndex = 0;
  let match;
  while ((match = ANSI_RE.exec(line))) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), color, bold });
    }
    const codes = match[1].length ? match[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        color = null;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = null;
      else if (ANSI_COLOR_MAP[code]) color = ANSI_COLOR_MAP[code];
    }
    lastIndex = ANSI_RE.lastIndex;
  }
  if (lastIndex < line.length) segments.push({ text: line.slice(lastIndex), color, bold });
  return segments;
}

// `docker logs --timestamps` prepends a full-precision RFC3339Nano timestamp
// ("2026-07-10T17:03:33.492059335Z") to every line, trimmed to HH:MM:SS.mmm - still sortable
// and precise to the millisecond, without dwarfing the log message (many apps log their own too).
const DOCKER_TS_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.(\d{3})\d*Z /;

export function splitDockerTimestamp(line) {
  const m = line.match(DOCKER_TS_RE);
  if (!m) return { ts: null, rest: line };
  return { ts: `${m[1]}.${m[2]}`, rest: line.slice(m[0].length) };
}

// Same anchor as splitDockerTimestamp, but keeps the date and returns a real epoch-ms instant
// instead of an HH:MM:SS.mmm display string - for comparing lines from different containers
// (the Logs tab's multi-pane scroll sync), a same-day-only string isn't enough to compare by.
const DOCKER_TS_MS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d*Z /;

export function parseLineTsMs(line) {
  const m = line.match(DOCKER_TS_MS_RE);
  return m ? Date.parse(m[1] + 'Z') : null;
}

// Split out of highlightLine so a caller rendering many lines against the same filter (selectLines,
// once per matching line) can compile the pattern once instead of once per line - constructing a
// RegExp isn't free, and a busy pane can have hundreds of matching lines per render.
export function buildLineMatcher(filterText, isRegex = false) {
  if (!filterText) return null;
  if (isRegex) {
    try {
      return new RegExp(filterText, 'gi');
    } catch {
      return null;
    }
  }
  return new RegExp(escapeRegExp(filterText), 'gi');
}

// Matches against the *raw* segment text and escapes each piece on the way out, rather than
// escaping first and matching the raw filter against the escaped string - which let a match land
// inside an escaped entity, or a search for "<"/"&" themselves highlight nothing. See public/CLAUDE.md.
function escapeAndHighlight(text, matcher) {
  if (!matcher) return escapeHtml(text);
  matcher.lastIndex = 0;
  let html = '';
  let lastIndex = 0;
  let match;
  while ((match = matcher.exec(text))) {
    // A zero-width regex match (e.g. `x*`) is skipped rather than wrapped, and lastIndex advanced
    // by one to guarantee progress - same as native String.replace, without an empty <mark> per char.
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    html += escapeHtml(text.slice(lastIndex, match.index));
    html += `<mark class="log-highlight">${escapeHtml(match[0])}</mark>`;
    lastIndex = match.index + match[0].length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}

// Escapes the line for safe innerHTML, renders ANSI colors as <span>s, and wraps case-insensitive
// `filterText` matches in <mark> for v-html - or, given a pre-built `matcher`, uses that as-is
// instead (see buildLineMatcher). An invalid regex pattern falls back to no highlighting.
export function highlightLine(line, filterText, isRegex = false, matcher = undefined) {
  const { ts, rest } = splitDockerTimestamp(line);
  const tsHtml = ts ? `<span class="log-ts">${ts}</span>` : '';

  const resolvedMatcher = matcher !== undefined ? matcher : buildLineMatcher(filterText, isRegex);

  const bodyHtml = parseAnsiSegments(rest)
    .map((seg) => {
      const html = escapeAndHighlight(seg.text, resolvedMatcher);
      const style = [seg.color ? `color:${seg.color}` : '', seg.bold ? 'font-weight:700' : ''].filter(Boolean).join(';');
      return style ? `<span style="${style}">${html}</span>` : html;
    })
    .join('');

  return tsHtml + bodyHtml;
}
