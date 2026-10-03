const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as logBuffer's test.
let h, consts;
test.before(async () => {
  h = await import('../public/js/lib/logHistory.js');
  consts = await import('../public/js/constants.js');
});

const TS = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000000000Z`;
const text = (n, s = 'x') => `${TS(n)} ${s}`;
const win = (ids) => ids.map((id) => ({ id, text: text(Math.abs(id) % 60) }));

test('streamTailFor', async (t) => {
  await t.test('passes a numeric tail straight through', () => {
    assert.equal(h.streamTailFor(5000), 5000);
  });
  await t.test('turns All into one page rather than the whole log', () => {
    assert.equal(h.streamTailFor('all'), consts.LOG_PAGE_LINES);
  });
});

test('maxLinesFor', async (t) => {
  await t.test('never holds fewer lines than were asked for - the bug that capped 10000 at 3000', () => {
    for (const tail of [5000, 10000, 20000]) assert.ok(h.maxLinesFor(tail) >= tail, `${tail} would be trimmed`);
  });
  await t.test('keeps the usual cap for a small tail so live lines can still accumulate', () => {
    assert.equal(h.maxLinesFor(1000), consts.MAX_LOG_LINES);
  });
  await t.test('gives All a window of several pages, so a page at one end can drop one from the other', () => {
    assert.equal(h.maxLinesFor('all'), consts.LOG_WINDOW_LINES);
    assert.ok(consts.LOG_WINDOW_LINES >= 2 * consts.LOG_PAGE_LINES);
  });
});

test('seekCursorFor', async (t) => {
  await t.test('is a valid docker log timestamp, SEEK_CONTEXT_MS before the target', () => {
    const target = Date.parse('2026-01-01T00:05:00.000Z');
    const cursor = h.seekCursorFor(target);
    assert.equal(cursor, '2026-01-01T00:04:00.000Z');
    assert.match(cursor + ' ', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z /);
    assert.equal(target - Date.parse(cursor), consts.SEEK_CONTEXT_MS);
  });
});

test('timestamps at the window ends', async (t) => {
  await t.test('reads the stamp off the first and last line', () => {
    const lines = [{ text: text(3) }, { text: text(4) }, { text: text(5) }];
    assert.equal(h.oldestTimestamp(lines), TS(3));
    assert.equal(h.newestTimestamp(lines), TS(5));
  });
  await t.test('is null for an empty pane, or a line without a docker stamp', () => {
    assert.equal(h.oldestTimestamp([]), null);
    assert.equal(h.newestTimestamp([]), null);
    assert.equal(h.oldestTimestamp([{ text: '[opendockwatch] log stream disconnected' }]), null);
  });
});

test('ids come from the window ends', async (t) => {
  await t.test('start at -1 / 0 for an empty window', () => {
    assert.equal(h.idBelow([]), -1);
    assert.equal(h.idAbove([]), 0);
  });
  await t.test('continue just outside the first and last line', () => {
    assert.equal(h.idBelow(win([4, 5])), 3);
    assert.equal(h.idAbove(win([4, 5])), 6);
  });
});

test('prependPage', async (t) => {
  await t.test('puts older lines in front with ids below the window, in order', () => {
    const r = h.prependPage(win([0, 1]), [text(1, 'a'), text(2, 'b')], 10);
    assert.deepEqual(
      r.lines.map((l) => l.id),
      [-2, -1, 0, 1]
    );
    assert.equal(r.added, 2);
    assert.equal(r.droppedNewer, 0);
  });

  await t.test('drops the NEWEST lines when the window overflows, and says how many', () => {
    const r = h.prependPage(win([0, 1, 2, 3]), [text(1), text(2)], 5);
    assert.equal(r.lines.length, 5);
    assert.deepEqual(
      r.lines.map((l) => l.id),
      [-2, -1, 0, 1, 2]
    );
    assert.equal(r.droppedNewer, 1);
  });

  await t.test('a page larger than the whole window keeps only its newest lines', () => {
    const r = h.prependPage([], [text(1), text(2), text(3)], 2);
    assert.deepEqual(
      r.lines.map((l) => l.text),
      [text(2), text(3)]
    );
  });

  await t.test('decorates the lines like any other, so the pane can render and filter them', () => {
    const [line] = h.prependPage([], [text(7, 'ERROR boom')], 10).lines;
    assert.equal(line.level, 'error');
    assert.equal(typeof line.baseHtml, 'string');
    assert.equal(typeof line.tsMs, 'number');
  });
});

test('appendPage', async (t) => {
  await t.test('puts newer lines at the back with ids above the window, in order', () => {
    const r = h.appendPage(win([0, 1]), [text(5, 'a'), text(6, 'b')], 10);
    assert.deepEqual(
      r.lines.map((l) => l.id),
      [0, 1, 2, 3]
    );
    assert.equal(r.droppedOlder, 0);
  });

  await t.test('drops the OLDEST lines when the window overflows, and says how many', () => {
    const r = h.appendPage(win([0, 1, 2, 3]), [text(5), text(6)], 5);
    assert.equal(r.lines.length, 5);
    assert.deepEqual(
      r.lines.map((l) => l.id),
      [1, 2, 3, 4, 5]
    );
    assert.equal(r.droppedOlder, 1);
  });

  await t.test('paging back then forward never reuses a key', () => {
    let lines = win([0, 1, 2]);
    lines = h.prependPage(lines, [text(1), text(2)], 100).lines;
    lines = h.appendPage(lines, [text(5), text(6)], 100).lines;
    lines = h.prependPage(lines, [text(0)], 100).lines;
    const ids = lines.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      'ids must stay ascending in line order'
    );
  });
});
