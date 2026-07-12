const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// public/js/*.js are ES modules (loaded via <script type="module"> in the browser) with no
// bundler in this project - require() can't load them directly, so they're imported dynamically
// once here and shared across every test below via the module cache. pathToFileURL rather than a
// plain relative string: import()'s relative-specifier resolution expects forward slashes, so a
// path.join'd path breaks on Windows where it comes out backslash-separated.
let format;
before(async () => {
  format = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'format.js')));
});

test('stateEmoji', async (t) => {
  await t.test('running/restarting/paused/stopped each render a distinct icon', () => {
    const running = format.stateEmoji('running');
    const restarting = format.stateEmoji('restarting');
    const paused = format.stateEmoji('paused');
    const stopped = format.stateEmoji('stopped');
    assert.notEqual(running, restarting);
    assert.notEqual(running, paused);
    assert.notEqual(running, stopped);
    assert.ok(restarting.includes('state-icon-spin'), 'restarting is the only state with a spinner');
    assert.ok(!running.includes('state-icon-spin'));
  });

  await t.test('unrecognized state falls back to the stopped icon', () => {
    assert.equal(format.stateEmoji('exited'), format.stateEmoji('stopped'));
    assert.equal(format.stateEmoji(undefined), format.stateEmoji('stopped'));
  });
});

test('iconFor', async (t) => {
  await t.test('matches a known service keyword in the image name', () => {
    assert.deepEqual(format.iconFor('postgres:17-alpine', undefined), { text: 'Pg', bg: '#336791' });
  });

  await t.test('also matches against composeService, not just image', () => {
    assert.deepEqual(format.iconFor('myorg/custom-app:latest', 'redis-cache'), { text: 'Re', bg: '#d82c20' });
  });

  await t.test('falls back to the composeService initial when nothing matches', () => {
    assert.deepEqual(format.iconFor('myorg/custom-app:latest', 'worker'), { text: 'W', bg: '#4f8cff' });
  });

  await t.test('falls back to the image initial when there is no composeService', () => {
    assert.deepEqual(format.iconFor('Zookeeper:latest', undefined), { text: 'Z', bg: '#4f8cff' });
  });

  await t.test('falls back to "?" when both are empty', () => {
    assert.deepEqual(format.iconFor('', ''), { text: '?', bg: '#4f8cff' });
  });
});

test('parseMemUsedBytes', async (t) => {
  await t.test('parses the "used" side of a MemUsage string', () => {
    assert.equal(format.parseMemUsedBytes('512MiB / 2GiB'), 512 * 1024 ** 2);
  });

  await t.test('returns 0 for empty or unparseable input', () => {
    assert.equal(format.parseMemUsedBytes(''), 0);
    assert.equal(format.parseMemUsedBytes(undefined), 0);
    assert.equal(format.parseMemUsedBytes('not a size'), 0);
  });
});

test('formatGB', () => {
  assert.equal(format.formatGB(1e9), '1.0 GB');
  assert.equal(format.formatGB(2.5e9), '2.5 GB');
});

test('formatRate', async (t) => {
  await t.test('null renders as a flat 0 B/s, not a placeholder', () => {
    assert.equal(format.formatRate(null), '0 B/s');
    assert.equal(format.formatRate(undefined), '0 B/s');
  });

  await t.test('picks the largest unit the value clears', () => {
    assert.equal(format.formatRate(0), '0 B/s');
    assert.equal(format.formatRate(999), '999 B/s');
    assert.equal(format.formatRate(1500), '1.5 kB/s');
    assert.equal(format.formatRate(2_500_000), '2.5 MB/s');
    assert.equal(format.formatRate(3_000_000_000), '3.0 GB/s');
  });
});

test('formatRatePair', () => {
  assert.equal(format.formatRatePair(1500, null), '1.5 kB/s / 0 B/s');
});

test('parsePublishedPorts', async (t) => {
  await t.test('extracts only "->" (published) ports, deduping IPv4/IPv6', () => {
    assert.equal(format.parsePublishedPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp'), ':8080');
  });

  await t.test('shows up to two ports comma-separated', () => {
    assert.equal(format.parsePublishedPorts('0.0.0.0:8080->80/tcp, 0.0.0.0:9090->90/tcp'), ':8080, :9090');
  });

  await t.test('truncates with an ellipsis beyond two ports', () => {
    const ports = '0.0.0.0:1->1/tcp, 0.0.0.0:2->2/tcp, 0.0.0.0:3->3/tcp';
    assert.equal(format.parsePublishedPorts(ports), ':1, :2…');
  });

  await t.test('returns empty string when nothing is published', () => {
    assert.equal(format.parsePublishedPorts('443/tcp'), '');
    assert.equal(format.parsePublishedPorts(''), '');
    assert.equal(format.parsePublishedPorts(undefined), '');
  });
});

test('healthColor / healthLabel', async (t) => {
  await t.test('known health states', () => {
    assert.equal(format.healthColor('healthy'), '#3fb950');
    assert.equal(format.healthColor('unhealthy'), '#f85149');
    assert.equal(format.healthLabel('starting'), 'health: starting');
    assert.equal(format.healthLabel('healthy'), 'healthy');
  });

  await t.test('unknown/absent health', () => {
    assert.equal(format.healthColor(null), null);
    assert.equal(format.healthLabel(null), '');
  });
});

test('detectLogLevel', async (t) => {
  await t.test('detects each level case-insensitively', () => {
    assert.equal(format.detectLogLevel('ERROR: connection refused'), 'error');
    assert.equal(format.detectLogLevel('a warning was logged'), 'warn');
    assert.equal(format.detectLogLevel('INFO starting up'), 'info');
    assert.equal(format.detectLogLevel('trace: entering function'), 'debug');
  });

  await t.test('error outranks info when a line matches both', () => {
    assert.equal(format.detectLogLevel('info: retrying after error'), 'error');
  });

  await t.test('returns null when nothing matches', () => {
    assert.equal(format.detectLogLevel('server listening on :3000'), null);
  });
});

test('escapeHtml', () => {
  assert.equal(format.escapeHtml(`<script>alert("x & y")</script>`), '&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;');
});

test('stripAnsi', async (t) => {
  await t.test('removes ANSI SGR escape codes', () => {
    assert.equal(format.stripAnsi('\x1b[34mINFO\x1b[0m starting'), 'INFO starting');
  });

  await t.test('leaves plain text untouched', () => {
    assert.equal(format.stripAnsi('plain text'), 'plain text');
  });
});

test('parseAnsiSegments', async (t) => {
  await t.test('a line with no ANSI codes is a single unstyled segment', () => {
    assert.deepEqual(format.parseAnsiSegments('plain text'), [{ text: 'plain text', color: null, bold: false }]);
  });

  await t.test('a color code tints the following text until reset', () => {
    const segs = format.parseAnsiSegments('\x1b[34mINFO\x1b[0m plain');
    assert.deepEqual(segs, [
      { text: 'INFO', color: '#58a6ff', bold: false },
      { text: ' plain', color: null, bold: false },
    ]);
  });

  await t.test('bold (1) and default-fg (39) are tracked independently of color', () => {
    const segs = format.parseAnsiSegments('\x1b[1;34mBOLD BLUE\x1b[39mBOLD ONLY');
    assert.deepEqual(segs, [
      { text: 'BOLD BLUE', color: '#58a6ff', bold: true },
      { text: 'BOLD ONLY', color: null, bold: true },
    ]);
  });

  await t.test('an unrecognized code (e.g. a background color) is a no-op', () => {
    const segs = format.parseAnsiSegments('\x1b[34m\x1b[41mstill blue on unrecognized bg');
    assert.deepEqual(segs, [{ text: 'still blue on unrecognized bg', color: '#58a6ff', bold: false }]);
  });
});

test('splitDockerTimestamp', async (t) => {
  await t.test('splits a docker --timestamps prefix to HH:MM:SS.mmm', () => {
    assert.deepEqual(format.splitDockerTimestamp('2026-07-10T17:03:33.492059335Z hello world'), {
      ts: '17:03:33.492',
      rest: 'hello world',
    });
  });

  await t.test('lines without the prefix pass through unchanged', () => {
    assert.deepEqual(format.splitDockerTimestamp('hello world'), { ts: null, rest: 'hello world' });
  });
});

test('highlightLine', async (t) => {
  await t.test('wraps a literal filter match in <mark>, case-insensitively', () => {
    assert.equal(
      format.highlightLine('Connection ERROR occurred', 'error'),
      'Connection <mark class="log-highlight">ERROR</mark> occurred'
    );
  });

  await t.test('regex mode compiles the filter as a pattern', () => {
    assert.equal(format.highlightLine('port 8080 in use', '\\d+', true), 'port <mark class="log-highlight">8080</mark> in use');
  });

  await t.test('an invalid regex falls back to no highlighting instead of throwing', () => {
    assert.equal(format.highlightLine('hello world', '(unterminated', true), 'hello world');
  });

  await t.test('ANSI color and highlight compose in the same line', () => {
    const out = format.highlightLine('\x1b[34mfound error here\x1b[0m', 'error');
    assert.equal(out, '<span style="color:#58a6ff">found <mark class="log-highlight">error</mark> here</span>');
  });

  await t.test('body text is HTML-escaped even when highlighted', () => {
    assert.equal(format.highlightLine('<b>error</b>', 'error'), '&lt;b&gt;<mark class="log-highlight">error</mark>&lt;/b&gt;');
  });

  await t.test('the docker timestamp prefix is pulled out into its own span first', () => {
    const out = format.highlightLine('2026-07-10T17:03:33.492059335Z error here', 'error');
    assert.equal(out, '<span class="log-ts">17:03:33.492</span><mark class="log-highlight">error</mark> here');
  });
});
