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

// The Log Viewer's search cursor. These exist because the obvious implementation - a positional
// index - is silently wrong in the one state the pane spends most of its life in: tailing at
// MAX_LOG_LINES, where every appended line drops one off the front and shifts every index by one.
test('hitIndexFor', async (t) => {
  const hits = (...ids) => ids.map((id) => ({ id }));

  await t.test('a null cursor means the first hit', () => {
    assert.equal(logLines.hitIndexFor(hits(10, 11, 12), null), 0);
    assert.equal(logLines.hitIndexFor(hits(10, 11, 12), undefined), 0);
  });

  await t.test('returns -1 when there are no hits at all', () => {
    assert.equal(logLines.hitIndexFor([], null), -1);
    assert.equal(logLines.hitIndexFor([], 11), -1);
  });

  await t.test('finds the selected line by id', () => {
    assert.equal(logLines.hitIndexFor(hits(10, 11, 12), 12), 2);
  });

  // The regression this whole change is about: with a positional cursor, trimming the front of the
  // buffer left the highlight on a different line than the one the user parked on, with no user
  // action and no visible cause. By id it follows its line to the new position instead.
  await t.test('follows its line when older lines are trimmed off the front', () => {
    const before = hits(10, 11, 12, 13);
    assert.equal(logLines.hitIndexFor(before, 13), 3);
    const afterTrim = hits(12, 13, 14, 15);
    assert.equal(logLines.hitIndexFor(afterTrim, 13), 1, 'cursor did not follow its line through a trim');
  });

  await t.test('falls back to the first hit when the selected line is gone entirely', () => {
    assert.equal(logLines.hitIndexFor(hits(20, 21), 11), 0);
  });
});

test('stepHitId', async (t) => {
  const hits = (...ids) => ids.map((id) => ({ id }));

  await t.test('steps forward and back from the current line', () => {
    assert.equal(logLines.stepHitId(hits(10, 11, 12), 11, 1), 12);
    assert.equal(logLines.stepHitId(hits(10, 11, 12), 11, -1), 10);
  });

  await t.test('wraps at both ends', () => {
    assert.equal(logLines.stepHitId(hits(10, 11, 12), 12, 1), 10);
    assert.equal(logLines.stepHitId(hits(10, 11, 12), 10, -1), 12);
  });

  await t.test('steps off the implicit first hit when nothing is selected yet', () => {
    assert.equal(logLines.stepHitId(hits(10, 11, 12), null, 1), 11);
    assert.equal(logLines.stepHitId(hits(10, 11, 12), null, -1), 12);
  });

  await t.test('returns null with no hits to move between', () => {
    assert.equal(logLines.stepHitId([], null, 1), null);
    assert.equal(logLines.stepHitId([], 11, -1), null);
  });

  // A trim between rendering the hits box and pressing Enter must not step from a stale position.
  await t.test('steps from where the vanished line fell back to, not from a stale index', () => {
    assert.equal(logLines.stepHitId(hits(20, 21, 22), 11, 1), 21);
  });

  await t.test('a single hit steps to itself rather than off the end', () => {
    assert.equal(logLines.stepHitId(hits(10), 10, 1), 10);
    assert.equal(logLines.stepHitId(hits(10), 10, -1), 10);
  });
});
