const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as the other lib tests.
let m;
test.before(async () => {
  m = await import('../public/js/lib/auditFilter.js');
});

const ROWS = [
  {
    id: 1,
    username: 'alice',
    host_id: 'prod',
    container_id: 'aaa111',
    container_name: 'web',
    action: 'restart',
    result: 'ok',
    error: null,
  },
  {
    id: 2,
    username: 'bob',
    host_id: 'prod',
    container_id: 'bbb222',
    container_name: 'db',
    action: 'stop',
    result: 'error',
    error: 'Permission denied (publickey)',
  },
  {
    id: 3,
    username: 'alice',
    host_id: 'staging',
    container_id: null,
    container_name: null,
    action: 'clear_alerts',
    result: 'ok',
    error: null,
  },
  {
    id: 4,
    username: null,
    host_id: 'prod',
    container_id: 'ccc333',
    container_name: 'cache',
    action: 'start',
    result: 'pending',
    error: null,
  },
];
const ids = (rows) => rows.map((r) => r.id);

test('filterAudit', async (t) => {
  await t.test('returns every row when nothing is asked for', () => {
    assert.deepEqual(ids(m.filterAudit(ROWS)), [1, 2, 3, 4]);
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: '   ' })), [1, 2, 3, 4]);
  });

  await t.test('searches who, where, what and the action, case-insensitively', () => {
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: 'ALICE' })), [1, 3]);
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: 'staging' })), [3]);
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: 'web' })), [1]);
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: 'clear_' })), [3]);
  });

  await t.test('searches the container id and the docker error text too', () => {
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: 'bbb222' })), [2]);
    assert.deepEqual(ids(m.filterAudit(ROWS, { search: 'publickey' })), [2]);
  });

  await t.test('tolerates the null fields a host-level row carries', () => {
    assert.doesNotThrow(() => m.filterAudit(ROWS, { search: 'zzz' }));
    assert.deepEqual(m.filterAudit(ROWS, { search: 'zzz' }), []);
  });

  await t.test('failures only keeps just the rows that errored, and composes with the search', () => {
    assert.deepEqual(ids(m.filterAudit(ROWS, { failuresOnly: true })), [2]);
    assert.deepEqual(ids(m.filterAudit(ROWS, { failuresOnly: true, search: 'alice' })), []);
    assert.deepEqual(ids(m.filterAudit(ROWS, { failuresOnly: true, search: 'bob' })), [2]);
  });

  await t.test('does not count a pending row as a failure', () => {
    assert.ok(!ids(m.filterAudit(ROWS, { failuresOnly: true })).includes(4));
  });
});

test('resultClass', async (t) => {
  await t.test('gives ok, error and anything else their own style', () => {
    assert.equal(m.resultClass('ok'), 'audit-ok');
    assert.equal(m.resultClass('error'), 'audit-error-badge');
    assert.equal(m.resultClass('pending'), 'audit-pending');
    assert.equal(m.resultClass('something-new'), 'audit-pending');
  });
});
