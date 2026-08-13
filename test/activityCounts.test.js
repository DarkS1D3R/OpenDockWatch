const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as the other public/js/lib tests.
let groupCounts;
test.before(async () => {
  ({ groupCounts } = await import('../public/js/lib/activityCounts.js'));
});

const alerts = [
  { rule: 'container_cpu', severity: 'warning' },
  { rule: 'container_crashed', severity: 'critical' },
  { rule: 'container_cpu', severity: 'warning' },
  { rule: 'unhealthy', severity: 'warning' },
  { rule: 'container_cpu', severity: 'warning' },
  { rule: 'container_crashed', severity: 'critical' },
];

test('groupCounts', async (t) => {
  await t.test('counts each distinct key, highest first', () => {
    const { shown, total } = groupCounts(alerts, (a) => a.rule);
    assert.deepEqual(
      shown.map((e) => [e.key, e.count]),
      [
        ['container_cpu', 3],
        ['container_crashed', 2],
        ['unhealthy', 1],
      ]
    );
    assert.equal(total, 6);
  });

  await t.test('carries meta from the first item of each group, for severity colouring', () => {
    const { shown } = groupCounts(alerts, (a) => a.rule, { metaOf: (a) => a.severity });
    assert.equal(shown.find((e) => e.key === 'container_crashed').meta, 'critical');
    assert.equal(shown.find((e) => e.key === 'container_cpu').meta, 'warning');
  });

  // The reshuffle guard: equal counts must order by key, or badges swap places as rows stream in.
  await t.test('breaks count ties by key so the order is stable', () => {
    const items = [{ a: 'zebra' }, { a: 'alpha' }, { a: 'mongoose' }];
    const keys = groupCounts(items, (i) => i.a).shown.map((e) => e.key);
    assert.deepEqual(keys, ['alpha', 'mongoose', 'zebra']);
    // Same multiset, different arrival order - same badges in the same places.
    const shuffled = [{ a: 'mongoose' }, { a: 'zebra' }, { a: 'alpha' }];
    assert.deepEqual(
      groupCounts(shuffled, (i) => i.a).shown.map((e) => e.key),
      keys
    );
  });

  await t.test('caps at limit and reports what was left over', () => {
    const items = 'abcdefgh'.split('').map((c) => ({ k: c }));
    const { shown, hidden, hiddenTotal } = groupCounts(items, (i) => i.k, { limit: 3 });
    assert.equal(shown.length, 3);
    assert.equal(hidden.length, 5);
    assert.equal(hiddenTotal, 5);
  });

  await t.test('skips items with no key rather than counting a blank group', () => {
    const items = [{ k: 'x' }, { k: null }, { k: '' }, { k: 'x' }, {}];
    const { shown, total } = groupCounts(items, (i) => i.k);
    assert.deepEqual(
      shown.map((e) => [e.key, e.count]),
      [['x', 2]]
    );
    // total stays the length of what was passed in - it describes the list, not the badges.
    assert.equal(total, 5);
  });

  await t.test('an empty list produces no badges', () => {
    const { shown, hidden, hiddenTotal, total } = groupCounts([], (i) => i.k);
    assert.deepEqual(shown, []);
    assert.deepEqual(hidden, []);
    assert.equal(hiddenTotal, 0);
    assert.equal(total, 0);
  });
});
