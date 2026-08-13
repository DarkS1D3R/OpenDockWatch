// Structured single-line audit/debug logging to stdout/stderr - Docker captures that as the
// container's log for free. Plain "key=value" text (not JSON) so it reads directly in `docker
// logs`, tagged [INFO]/[WARN]/[ERROR] so the app's own Log Viewer level filters pick it up too.
function formatFields(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const s = String(v);
      return /\s/.test(s) ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`;
    })
    .join(' ');
}

function write(level, event, fields) {
  const suffix = fields && Object.keys(fields).length ? ' ' + formatFields(fields) : '';
  const line = `[opendockwatch] [${level}] ${event}${suffix}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

// Boot banner. Deliberately the one thing here that isn't a tagged single-line event: it's a
// visual marker for where a restart begins when scrolling back through `docker logs`, and the
// app.started line carrying the actual data follows it immediately. See CLAUDE.md.
const BANNER = String.raw`
    ____  ____ _       __
   / __ \/ __ \ |     / /   OpenDockWatch
  / / / / / / / | /| / /    %s
 / /_/ / /_/ /| |/ |/ /     %s
 \____/_____/ |__/|__/
`;

function banner(version, subtitle) {
  // Two separate replaces, not replaceAll - the placeholders are filled in order, one per line.
  const line = BANNER.replace('%s', `v${version}`).replace('%s', subtitle);
  // Straight to console, not write(): the banner is art, not a tagged event. It's the only such
  // write in the server - everything else goes through write() above.
  console.log(line);
}

module.exports = {
  info: (event, fields) => write('INFO', event, fields),
  warn: (event, fields) => write('WARN', event, fields),
  error: (event, fields) => write('ERROR', event, fields),
  banner,
};
