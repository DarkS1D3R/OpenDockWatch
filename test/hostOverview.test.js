const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let ov;
before(async () => {
  ov = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'hostOverview.js')));
});

const row = (id, status, extra = {}) => ({ id, name: id, status, openAlerts: 0, containers: null, ...extra });

test('sortOverviewRows puts problems first and otherwise keeps the configured order', () => {
  const rows = [row('a', 'ok'), row('b', 'warning'), row('c', 'pending'), row('d', 'down'), row('e', 'ok'), row('f', 'warning')];
  assert.deepEqual(
    ov.sortOverviewRows(rows).map((r) => r.id),
    ['d', 'b', 'f', 'c', 'a', 'e']
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'b', 'c', 'd', 'e', 'f'],
    'sorting must not reorder the prop it was handed'
  );
});

test('overviewSummary', async (t) => {
  await t.test('all fine says so, with the count', () => {
    assert.equal(ov.overviewSummary([row('a', 'ok'), row('b', 'ok')]), 'All 2 hosts OK.');
    assert.equal(ov.overviewSummary([row('a', 'ok')]), 'All 1 host OK.');
  });
  await t.test('a host still waiting for its first poll is not called OK', () => {
    assert.equal(ov.overviewSummary([row('a', 'ok'), row('b', 'pending')]), '2 hosts, none with a problem so far.');
  });
  await t.test('problems are counted by kind, with the open alerts across every host', () => {
    const rows = [row('a', 'down', { openAlerts: 1 }), row('b', 'warning', { openAlerts: 2 }), row('c', 'ok')];
    assert.equal(ov.overviewSummary(rows), '3 hosts: 1 unreachable, 1 needs a look, 3 open alerts.');
  });
  await t.test('plurals', () => {
    const rows = [row('a', 'warning', { openAlerts: 1 }), row('b', 'warning')];
    assert.equal(ov.overviewSummary(rows), '2 hosts: 2 need a look, 1 open alert.');
  });
  await t.test('no hosts at all', () => {
    assert.equal(ov.overviewSummary([]), 'No hosts configured.');
  });
});

test('containersLabel and containerProblems', () => {
  const r = row('a', 'warning', { containers: { total: 5, running: 3, unhealthy: 1, restarting: 2 } });
  assert.equal(ov.containersLabel(r), '3 / 5 running');
  assert.deepEqual(ov.containerProblems(r), ['1 unhealthy', '2 restarting']);
  assert.equal(ov.containersLabel(row('b', 'down')), '—', 'no list is unknown, not zero');
  assert.deepEqual(ov.containerProblems(row('b', 'down')), []);
});

test('cpu and memory labels', () => {
  const r = row('a', 'ok', { cpuPercent: 7.25, memUsedBytes: 2e9, memTotalBytes: 8e9 });
  assert.equal(ov.cpuLabel(r), '7.3%');
  assert.equal(ov.memLabel(r), '2.0 GB / 8.0 GB');
  assert.equal(ov.memPercent(r), 25);
  assert.equal(ov.memLabel({ ...r, memTotalBytes: null }), '2.0 GB');
  assert.equal(ov.memPercent({ ...r, memTotalBytes: null }), null);
  const unknown = row('b', 'down', { cpuPercent: null, memUsedBytes: null });
  assert.equal(ov.cpuLabel(unknown), '—');
  assert.equal(ov.memLabel(unknown), '—');
  assert.equal(ov.memPercent(unknown), null);
});

test('downForLabel', () => {
  const now = 10 * 3_600_000;
  assert.equal(ov.downForLabel(row('a', 'down', { downSince: now - 2 * 3_600_000 - 10 * 60_000 }), now), 'for 2h 10m');
  assert.equal(ov.downForLabel(row('a', 'down', { downSince: null }), now), null);
  assert.equal(ov.downForLabel(row('a', 'ok', { downSince: now - 60_000 }), now), null);
});
