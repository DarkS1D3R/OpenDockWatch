import { ACCENT, MUTED, STATE_COLORS } from './theme.js';
import { LOGOS } from './lib/logos.js';

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

// Keyword -> badge lookup, checked in order against "<image> <composeService>" (lowercase); first
// match wins, so specific before generic and base-OS images last. `logo` names a lib/logos.js glyph
// (colours come from there); no `logo` keeps a text badge on `bg`. Ordering rules: public/CLAUDE.md.
export const SERVICE_BADGES = [
  [/opendockwatch/, { text: 'OD', logo: 'opendockwatch' }],
  // pgAdmin's logo is white "pg" on a blue rounded square - no Simple Icons glyph, but a text tile
  // is the logo, so it's drawn as one rather than as a lettered circle.
  [/pgadmin/, { text: 'pg', bg: '#336791', tile: true }],
  // No Simple Icons glyph for these - text badges.
  [/dozzle/, { text: 'Dz', bg: '#fcc419', fg: '#1d2027' }], // yellow needs dark text
  [/valkey/, { text: 'Vk', bg: '#6983ff' }],
  [/activemq/, { text: 'Mq', bg: '#a2122e' }],
  [/camel/, { text: 'Cm', bg: '#d04437' }],
  [/haproxy/, { text: 'Hp', bg: '#106da9' }],
  [/memcached/, { text: 'Mc', bg: '#268d7c' }],
  [/mosquitto/, { text: 'Mt', bg: '#3c5280' }],
  [/zookeeper/, { text: 'Zk', bg: '#8e6a3c' }],
  [/\bloki\b/, { text: 'Lk', bg: '#f46800' }],
  [/cadvisor/, { text: 'cA', bg: '#326ce5' }],
  // Databases and stores.
  [/timescale/, { text: 'Ts', logo: 'timescale' }],
  [/postgres|postgis/, { text: 'Pg', logo: 'postgresql' }],
  [/mariadb/, { text: 'Ma', logo: 'mariadb' }],
  [/phpmyadmin/, { text: 'PM', logo: 'phpmyadmin' }],
  [/mysql/, { text: 'My', logo: 'mysql' }],
  [/mongo/, { text: 'Mo', logo: 'mongodb' }],
  [/redis/, { text: 'Re', logo: 'redis' }],
  [/cassandra/, { text: 'Ca', logo: 'apachecassandra' }],
  [/couchdb/, { text: 'Co', logo: 'apachecouchdb' }],
  [/cockroach/, { text: 'Cr', logo: 'cockroachlabs' }],
  [/clickhouse/, { text: 'CH', logo: 'clickhouse' }],
  [/influx/, { text: 'If', logo: 'influxdb' }],
  [/neo4j/, { text: 'N4', logo: 'neo4j' }],
  [/minio/, { text: 'Mi', logo: 'minio' }],
  [/\betcd\b/, { text: 'Et', logo: 'etcd' }],
  [/adminer/, { text: 'Ad', logo: 'adminer' }],
  // Messaging and search.
  [/rabbitmq/, { text: 'Rb', logo: 'rabbitmq' }],
  [/kafka/, { text: 'Kf', logo: 'apachekafka' }],
  [/elasticsearch/, { text: 'Es', logo: 'elasticsearch' }],
  [/kibana/, { text: 'Kb', logo: 'kibana' }],
  [/logstash/, { text: 'Ls', logo: 'logstash' }],
  [/opensearch/, { text: 'Os', logo: 'opensearch' }],
  [/meilisearch/, { text: 'Me', logo: 'meilisearch' }],
  [/\bsolr\b/, { text: 'So', logo: 'apachesolr' }],
  [/temporalio/, { text: 'Tp', logo: 'temporal' }],
  // Proxies, networking, auth.
  [/nginx-proxy-manager|nginxproxymanager|jc21\//, { text: 'NP', logo: 'nginxproxymanager' }],
  [/nginx/, { text: 'Nx', logo: 'nginx' }],
  [/traefik/, { text: 'Tf', logo: 'traefikproxy' }],
  [/caddy/, { text: 'Cd', logo: 'caddy' }],
  [/envoy/, { text: 'Ev', logo: 'envoyproxy' }],
  [/\bkong\b/, { text: 'Kg', logo: 'kong' }],
  [/cloudflared/, { text: 'Cf', logo: 'cloudflare' }],
  [/tailscale/, { text: 'Tc', logo: 'tailscale' }],
  [/wireguard/, { text: 'Wg', logo: 'wireguard' }],
  [/certbot|letsencrypt/, { text: 'Le', logo: 'letsencrypt' }],
  [/pi-?hole/, { text: 'Ph', logo: 'pihole' }],
  [/adguard/, { text: 'Ag', logo: 'adguard' }],
  [/keycloak/, { text: 'Kc', logo: 'keycloak' }],
  [/authelia/, { text: 'Al', logo: 'authelia' }],
  [/authentik/, { text: 'Ak', logo: 'authentik' }],
  [/vaultwarden/, { text: 'Vw', logo: 'vaultwarden' }],
  [/bitwarden/, { text: 'Bw', logo: 'bitwarden' }],
  [/\bvault\b/, { text: 'Vt', logo: 'vault' }],
  [/consul/, { text: 'Cs', logo: 'consul' }],
  // Observability.
  [/grafana/, { text: 'Gf', logo: 'grafana' }],
  [/prometheus|node-exporter|alertmanager|\bprom\//, { text: 'Pr', logo: 'prometheus' }],
  [/jaeger/, { text: 'Jg', logo: 'jaeger' }],
  [/otel|opentelemetry/, { text: 'OT', logo: 'opentelemetry' }],
  [/uptime-?kuma/, { text: 'UK', logo: 'uptimekuma' }],
  [/umami/, { text: 'Um', logo: 'umami' }],
  [/metabase/, { text: 'Mb', logo: 'metabase' }],
  // Dev tooling and container management.
  [/portainer/, { text: 'Pt', logo: 'portainer' }],
  [/watchtower/, { text: 'Wt', logo: 'watchtower' }],
  [/gethomepage/, { text: 'Hm', logo: 'homepage' }],
  [/jenkins/, { text: 'Jk', logo: 'jenkins' }],
  [/gitlab/, { text: 'GL', logo: 'gitlab' }],
  [/forgejo/, { text: 'Fj', logo: 'forgejo' }],
  [/gitea/, { text: 'Gt', logo: 'gitea' }],
  [/sonatype|nexus/, { text: 'Nx', logo: 'sonatype' }],
  [/node-?red/, { text: 'NR', logo: 'nodered' }],
  [/\bn8n\b/, { text: 'n8', logo: 'n8n' }],
  // Self-hosted apps.
  [/nextcloud/, { text: 'Nc', logo: 'nextcloud' }],
  [/wordpress/, { text: 'Wp', logo: 'wordpress' }],
  [/\bghost\b/, { text: 'Gh', logo: 'ghost' }],
  [/mattermost/, { text: 'Mm', logo: 'mattermost' }],
  [/rocket\.?chat/, { text: 'RC', logo: 'rocketdotchat' }],
  [/jellyfin/, { text: 'Jf', logo: 'jellyfin' }],
  [/plexinc|\bplex\b/, { text: 'Px', logo: 'plex' }],
  [/immich/, { text: 'Im', logo: 'immich' }],
  [/home-?assistant/, { text: 'HA', logo: 'homeassistant' }],
  [/syncthing/, { text: 'St', logo: 'syncthing' }],
  [/sonarr/, { text: 'Sn', logo: 'sonarr' }],
  [/radarr/, { text: 'Rd', logo: 'radarr' }],
  [/qbittorrent/, { text: 'qB', logo: 'qbittorrent' }],
  // Runtimes and web servers.
  [/tomcat/, { text: 'Tc', logo: 'apachetomcat' }],
  [/spring/, { text: 'Sp', logo: 'springboot' }],
  [/openjdk|temurin|corretto|zulu|\bjdk\b|\bjre\b/, { text: 'Jv', logo: 'openjdk' }],
  [/(^|\/)node(:|@|\s|$)/, { text: 'Nd', logo: 'nodedotjs' }],
  [/python/, { text: 'Py', logo: 'python' }],
  [/\bphp\b/, { text: 'Ph', logo: 'php' }],
  [/(^|\/)rust(:|@|\s|$)/, { text: 'Rs', logo: 'rust' }],
  [/dotnet/, { text: '.N', logo: 'dotnet' }],
  [/httpd|apache/, { text: 'Ap', logo: 'apache' }],
  [/(^|\/)docker(:|@|\s|$)|\bdind\b/, { text: 'Dk', logo: 'docker' }],
  // Base-OS images - last, since "postgres:17-alpine" carries an OS name in its tag.
  [/(^|\/)alpine(:|@|\s|$)/, { text: 'Al', logo: 'alpinelinux' }],
  [/(^|\/)ubuntu(:|@|\s|$)/, { text: 'Ub', logo: 'ubuntu' }],
  [/(^|\/)debian(:|@|\s|$)/, { text: 'Db', logo: 'debian' }],
];

// Memoised on the raw inputs: the List view calls this per row per render (every 5s poll) and the
// table above is ~100 regexes. Results are frozen since every caller for a key shares one object.
const iconCache = new Map();

// override is the container's `opendockwatch.icon` label and beats everything; hint is the server's
// runtime guess from env var names (docker.js RUNTIME_ENV_HINTS), used only when no pattern above
// matched - an image name is a statement about the container, an inherited JAVA_HOME is a guess.
export function iconFor(image, composeService, override, hint) {
  const key = [image, composeService, override, hint].map((v) => v || '').join('\u0000');
  let icon = iconCache.get(key);
  if (!icon) {
    icon = Object.freeze(resolveIcon(image, composeService, override, hint));
    iconCache.set(key, icon);
  }
  return icon;
}

function resolveIcon(image, composeService, override, hint) {
  if (override && LOGOS[override]) return logoIcon(override);
  const haystack = `${image || ''} ${composeService || ''}`.toLowerCase();
  for (const [pattern, badge] of SERVICE_BADGES) {
    if (!pattern.test(haystack)) continue;
    if (!badge.logo) return textIcon(badge);
    return logoIcon(badge.logo, badge);
  }
  if (hint && LOGOS[hint]) return logoIcon(hint);
  const initial = (composeService || image || '?').trim().charAt(0).toUpperCase() || '?';
  return { text: initial, bg: ACCENT };
}

// Only the fields a text badge actually set, so an unset fg/tile doesn't appear as an undefined key.
function textIcon(badge) {
  const icon = { text: badge.text, bg: badge.bg };
  if (badge.fg) icon.fg = badge.fg;
  if (badge.tile) icon.tile = true;
  return icon;
}

// A badge entry may re-colour a borrowed glyph (pgAdmin wears the Postgres elephant on its own green).
function logoIcon(slug, badge = {}) {
  const logo = LOGOS[slug];
  const text = badge.text || logo.title.slice(0, 2);
  return { text, bg: badge.bg || logo.bg, fg: badge.fg || logo.fg, logo: slug };
}

// A badge's inner markup - the logo glyph, else the text escaped (the fallback initial comes from a
// docker/compose name). Shared by the flow-view templates and the List view; svgExport.js has its own.
export function badgeInnerHtml(icon) {
  const logo = icon.logo && LOGOS[icon.logo];
  if (logo)
    return `<svg class="svc-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="${icon.fg || logo.fg}" d="${logo.path}"/></svg>`;
  // Text colour is set per badge only when it isn't the stylesheet's white (a yellow badge needs dark).
  return icon.fg ? `<span style="color:${icon.fg}">${escapeHtml(icon.text)}</span>` : escapeHtml(icon.text);
}

// Product name for a logo badge's hover title; '' for the text fallback.
export function badgeTitle(icon) {
  return (icon.logo && LOGOS[icon.logo]?.title) || '';
}

// True for a badge whose real logo is itself a rounded square - our own mark, or a text tile like
// pgAdmin's "pg" - rendered full-bleed via .svc-tile rather than inside the usual circle.
export function badgeIsTile(icon) {
  return Boolean(icon.tile || (icon.logo && LOGOS[icon.logo]?.tile));
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
