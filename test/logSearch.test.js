const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let logSearch;
before(async () => {
  logSearch = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logSearch.js')));
});

const line = (sec, text) => `2026-01-01T00:00:${String(sec).padStart(2, '0')}.000000000Z ${text}`;

test('searchRows', async (t) => {
  await t.test('keeps the container each line came from and the instant to open it at', () => {
    const [row] = logSearch.searchRows([{ containerId: 'a1', containerName: 'shop-api', line: line(5, 'req=42 done') }], 'req=42');
    assert.equal(row.containerId, 'a1');
    assert.equal(row.containerName, 'shop-api');
    assert.equal(row.tsMs, Date.parse('2026-01-01T00:00:05.000Z'));
  });

  await t.test('highlights the query, case-insensitively, and escapes the line', () => {
    const [row] = logSearch.searchRows([{ containerId: 'a1', containerName: 'x', line: line(1, '<b>REQ=42</b>') }], 'req=42');
    assert.match(row.html, /<mark class="log-highlight">REQ=42<\/mark>/);
    assert.match(row.html, /&lt;b&gt;/);
  });

  await t.test('treats regex characters in the query as plain text, like the server does', () => {
    const [row] = logSearch.searchRows([{ containerId: 'a1', containerName: 'x', line: line(1, 'GET /a.b?c 200') }], 'a.b?c');
    assert.match(row.html, /<mark class="log-highlight">a\.b\?c<\/mark>/);
  });

  await t.test('a line without a docker stamp gets no time, so it cannot be opened at one', () => {
    const [row] = logSearch.searchRows([{ containerId: 'a1', containerName: 'x', line: 'no stamp here' }], 'stamp');
    assert.equal(row.tsMs, null);
  });
});

test('searchSummary', async (t) => {
  await t.test('says how much matched and across how many containers', () => {
    assert.equal(logSearch.searchSummary({ matched: 0, searched: 3, matches: [] }), 'No matches in 3 containers');
    assert.equal(logSearch.searchSummary({ matched: 1, searched: 1, matches: [{}] }), '1 match in 1 container');
  });

  await t.test('says when the list is only the newest part of the answer', () => {
    const summary = logSearch.searchSummary({ matched: 900, searched: 4, truncated: true, matches: new Array(500) });
    assert.equal(summary, '900 matches in 4 containers - showing the newest 500');
  });
});

test('searchWarnings', async (t) => {
  await t.test('names failed and timed-out containers, since their results are missing or partial', () => {
    const warnings = logSearch.searchWarnings({
      failed: [{ containerName: 'shop-db', error: 'no such container' }],
      timedOut: ['shop-worker', 'shop-api'],
    });
    assert.deepEqual(warnings, ['shop-db: no such container', 'Timed out before finishing, results may be partial: shop-worker, shop-api']);
  });

  await t.test('is empty for a clean search', () => {
    assert.deepEqual(logSearch.searchWarnings({ failed: [], timedOut: [] }), []);
  });
});
