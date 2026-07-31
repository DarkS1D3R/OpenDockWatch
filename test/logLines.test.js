const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let logLines;
before(async () => {
  logLines = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logLines.js')));
});

const TS = '2026-07-31T10:15:22.123456789Z';
const line = (id, text) => ({ id, text });
const decorated = (id, text) => {
  return logLines.decorateLine(line(id, text));
};

test('decorateLine', async (t) => {
  await t.test('derives timestamp, level and base html once per line', () => {
    const d = decorated(1, `${TS} ERROR upstream refused the connection`);
    assert.equal(d.id, 1);
    assert.equal(d.tsMs, Date.parse('2026-07-31T10:15:22.123Z'));
    assert.equal(d.level, 'error');
    assert.match(d.baseHtml, /upstream refused the connection/);
    // The timestamp is split into its own span so the viewer's hide-ts class can suppress it -
    // that's part of the cached html, not something re-derived per render.
    assert.match(d.baseHtml, /class="log-ts"/);
  });

  await t.test('detects level through ANSI colour codes', () => {
    // stripAnsi runs before detection, or an escape sequence between the timestamp and the level
    // word hides the level entirely.
    assert.equal(decorated(1, `${TS} [33mWARN[0m disk almost full`).level, 'warn');
  });

  await t.test('a line with no parseable timestamp or level yields nulls, not throws', () => {
    // Real cases: the synthetic "[opendockwatch] log stream disconnected" notice, and any
    // container logging without a docker timestamp prefix.
    const d = decorated(7, '[opendockwatch] log stream disconnected');
    assert.equal(d.tsMs, null);
    assert.equal(d.level, null);
    assert.ok(d.baseHtml.length);
  });
});

test('selectLines', async (t) => {
  const levels = { error: true, warn: true, info: true, debug: true };
  const sample = () =>
    [`${TS} ERROR boom`, `${TS} WARN careful`, `${TS} INFO all good`, '[opendockwatch] log stream disconnected'].map((text, i) =>
      decorated(i, text)
    );

  await t.test("with no filter, reuses each line's cached html rather than re-rendering", () => {
    const lines = sample();
    const out = logLines.selectLines(lines, { levels });
    assert.equal(out.length, 4);
    for (let i = 0; i < lines.length; i++) {
      // Identity, not just equality - proves highlightLine was not called again.
      assert.equal(out[i].html, lines[i].baseHtml);
      assert.equal(out[i].tsMs, lines[i].tsMs);
    }
  });

  await t.test('drops lines whose level is toggled off, keeps undetected ones', () => {
    const out = logLines.selectLines(sample(), { levels: { ...levels, error: false, info: false } });
    // The level-less "[opendockwatch]" notice survives - there's no toggle it belongs to, and
    // hiding stream notices along with a level filter would be actively misleading.
    assert.deepEqual(
      out.map((l) => l.id),
      [1, 3]
    );
  });

  await t.test('plain-text filter matches case-insensitively and re-renders with highlighting', () => {
    const lines = sample();
    const out = logLines.selectLines(lines, { levels, filterText: 'BOOM' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 0);
    assert.match(out[0].html, /<mark class="log-highlight">boom<\/mark>/, 'a filtered line must be re-rendered with the match marked');
    assert.notEqual(out[0].html, lines[0].baseHtml);
  });

  await t.test('regex mode filters on the compiled pattern', () => {
    const out = logLines.selectLines(sample(), { levels, filterText: '^.*(boom|careful)', regexMode: true, testRegex: /(boom|careful)/i });
    assert.deepEqual(
      out.map((l) => l.id),
      [0, 1]
    );
  });

  await t.test('an invalid regex shows every line rather than blanking the pane', () => {
    // testRegex is null while the user is midway through typing a pattern; the viewer shows an
    // "Invalid regex" warning beside the input, and emptying the pane under them would be worse.
    const out = logLines.selectLines(sample(), { levels, filterText: '[unclosed', regexMode: true, testRegex: null });
    assert.equal(out.length, 4);
  });

  await t.test('level filter and text filter compose', () => {
    const out = logLines.selectLines(sample(), { levels: { ...levels, error: false }, filterText: 'careful' });
    assert.deepEqual(
      out.map((l) => l.id),
      [1]
    );
  });

  await t.test('tolerates being called with no options at all', () => {
    assert.equal(logLines.selectLines(sample()).length, 4);
  });
});
