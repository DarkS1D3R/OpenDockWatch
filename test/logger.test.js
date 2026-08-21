const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const logger = require('../server/logger');

// formatFields isn't exported, so these go through the real info/warn/error and capture what
// actually reaches the console - which is the thing that matters anyway, since `docker logs` and
// the app's own Log Viewer both read that text and nothing else.
function capture(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (l) => lines.push({ stream: 'stdout', l });
  console.warn = (l) => lines.push({ stream: 'stderr', l });
  console.error = (l) => lines.push({ stream: 'stderr', l });
  try {
    fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

test('logger field formatting', async (t) => {
  // The one that guards the whole format: a value containing a newline must not be able to end
  // the line and start a forged one. This became load-bearing when client-supplied error messages
  // started reaching the log through POST /api/client-error - before that every value was
  // server-generated. A mutation removing the quoting survived the entire suite, which is why
  // this file exists.
  await t.test('a value containing a newline cannot forge a second log line', () => {
    const [{ l }] = capture(() => logger.info('probe', { message: 'first\n[opendockwatch] [ERROR] forged.event user=admin' }));
    assert.equal(l.split('\n').length, 1, 'the whole event must stay on one physical line');
    assert.ok(l.includes('\\n'), 'the newline should be escaped, not emitted raw');
    assert.equal(l.startsWith('[opendockwatch] [INFO] probe '), true);
  });

  await t.test('a value containing spaces is quoted so the key=value split stays unambiguous', () => {
    const [{ l }] = capture(() => logger.warn('probe', { reason: 'Permission denied (publickey)' }));
    assert.match(l, /reason="Permission denied \(publickey\)"/);
  });

  await t.test('a plain value is left unquoted', () => {
    const [{ l }] = capture(() => logger.info('probe', { host: 'local', count: 3 }));
    assert.match(l, /host=local count=3/);
  });

  await t.test('carriage returns and tabs are escaped too, not just \\n', () => {
    const [{ l }] = capture(() => logger.info('probe', { v: 'a\r\nb\tc' }));
    assert.equal(l.split('\n').length, 1);
    assert.equal(l.includes('\r'), false, 'a bare CR can overwrite the line in a terminal');
  });

  await t.test('null, undefined and empty values are dropped rather than logged as noise', () => {
    const [{ l }] = capture(() => logger.info('probe', { a: null, b: undefined, c: '', d: 'kept' }));
    assert.equal(l, '[opendockwatch] [INFO] probe d=kept');
  });

  await t.test('zero and false are kept - they are real values, not absent ones', () => {
    const [{ l }] = capture(() => logger.info('probe', { queued: 0, ok: false }));
    assert.match(l, /queued=0/);
    assert.match(l, /ok=false/);
  });

  await t.test('an event with no fields logs cleanly, with no trailing separator', () => {
    assert.equal(capture(() => logger.info('probe'))[0].l, '[opendockwatch] [INFO] probe');
    assert.equal(capture(() => logger.info('probe', {}))[0].l, '[opendockwatch] [INFO] probe');
  });
});

test('logger levels', async (t) => {
  // The Log Viewer's level filter matches on the [LEVEL] tag, so the tag is part of the contract,
  // not decoration - see server/CLAUDE.md on why nothing in server/ writes to console directly.
  await t.test('each level carries its own tag', () => {
    assert.match(capture(() => logger.info('e'))[0].l, /^\[opendockwatch\] \[INFO\] /);
    assert.match(capture(() => logger.warn('e'))[0].l, /^\[opendockwatch\] \[WARN\] /);
    assert.match(capture(() => logger.error('e'))[0].l, /^\[opendockwatch\] \[ERROR\] /);
  });

  await t.test('warn and error go to stderr, info to stdout', () => {
    assert.equal(capture(() => logger.info('e'))[0].stream, 'stdout');
    assert.equal(capture(() => logger.warn('e'))[0].stream, 'stderr');
    assert.equal(capture(() => logger.error('e'))[0].stream, 'stderr');
  });
});

// A failure that only reaches console.error is invisible to the Log Viewer's level filters, which
// is the entire reason this module exists - so the rule is enforced, not just written down. Raw
// source scan: a comment writing out `console.log(` trips it too, which is a cheap price.
const SERVER_DIR = path.join(__dirname, '..', 'server');
const CONSOLE_CALL_RE = /\bconsole\.\w+\s*\(/g;

test('logger is the only thing in server/ that writes to console', async (t) => {
  const files = fs.readdirSync(SERVER_DIR).filter((name) => name.endsWith('.js'));

  await t.test('no server module calls console directly', () => {
    const offenders = [];
    for (const name of files) {
      // logger.js is the sanctioned writer - it *is* the wrapper the rule points everything at.
      if (name === 'logger.js') continue;
      const source = fs.readFileSync(path.join(SERVER_DIR, name), 'utf8');
      for (const [call] of source.matchAll(CONSOLE_CALL_RE)) offenders.push(`${name}: ${call}`);
    }
    assert.deepEqual(offenders, [], `these bypass logger, so the Log Viewer's level filters never see them: ${offenders.join(', ')}`);
  });

  // Guards the scan against passing because it read nothing - a moved directory or a changed
  // extension would otherwise leave an empty file list quietly asserting an empty offender list.
  await t.test('the scan actually read the server modules', () => {
    assert.ok(files.length > 5, `only found ${files.length} server modules - the scan is looking in the wrong place`);
    assert.ok(files.includes('logger.js'), 'server/logger.js not found by the scan');
  });

  await t.test('logger.js itself still owns every console call', () => {
    const source = fs.readFileSync(path.join(SERVER_DIR, 'logger.js'), 'utf8');
    const calls = [...source.matchAll(CONSOLE_CALL_RE)].map(([c]) => c);
    assert.ok(calls.length > 0, 'logger.js writes to console through something this scan cannot see');
  });
});
