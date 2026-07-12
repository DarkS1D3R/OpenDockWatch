// Structured single-line audit/debug logging, written to stdout/stderr like the rest of the
// app's console output - Docker already captures that as the container's log with zero extra
// config. Kept as plain "key=value" text rather than JSON so it reads directly in `docker logs`,
// and tagged [INFO]/[WARN]/[ERROR] so it's picked up by the app's own Log Viewer level filters
// when watching this container's logs through itself.
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

module.exports = {
  info: (event, fields) => write('INFO', event, fields),
  warn: (event, fields) => write('WARN', event, fields),
  error: (event, fields) => write('ERROR', event, fields),
};
