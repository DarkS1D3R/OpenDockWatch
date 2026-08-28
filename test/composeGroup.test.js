const test = require('node:test');
const assert = require('node:assert/strict');
const { orderGroupLevels, mapLimit } = require('../server/composeGroup');

test('orderGroupLevels', async (t) => {
  await t.test('no edges - everything is independent and lands in one level', () => {
    const levels = orderGroupLevels(['a', 'b', 'c'], [], 'start');
    assert.deepEqual(levels, [['a', 'b', 'c']]);
  });

  await t.test('a linear chain starts dependency-first, one per level', () => {
    // api depends on db, db depends on nothing.
    const edges = [{ source: 'api', target: 'db' }];
    assert.deepEqual(orderGroupLevels(['api', 'db'], edges, 'start'), [['db'], ['api']]);
  });

  await t.test('stop reverses the level order rather than just flattening it', () => {
    const edges = [{ source: 'api', target: 'db' }];
    assert.deepEqual(orderGroupLevels(['api', 'db'], edges, 'stop'), [['api'], ['db']]);
  });

  await t.test('restart uses the same dependency-first order as start', () => {
    const edges = [{ source: 'api', target: 'db' }];
    assert.deepEqual(orderGroupLevels(['api', 'db'], edges, 'restart'), [['db'], ['api']]);
  });

  await t.test('a diamond: two independent middle services share a level', () => {
    // api depends on cache and queue; both depend on db.
    const edges = [
      { source: 'api', target: 'cache' },
      { source: 'api', target: 'queue' },
      { source: 'cache', target: 'db' },
      { source: 'queue', target: 'db' },
    ];
    const levels = orderGroupLevels(['api', 'cache', 'queue', 'db'], edges, 'start');
    assert.equal(levels.length, 3);
    assert.deepEqual(levels[0], ['db']);
    assert.deepEqual(new Set(levels[1]), new Set(['cache', 'queue']));
    assert.deepEqual(levels[2], ['api']);
  });

  await t.test('a self-loop is ignored rather than making its own container unready forever', () => {
    const edges = [{ source: 'a', target: 'a' }];
    assert.deepEqual(orderGroupLevels(['a'], edges, 'start'), [['a']]);
  });

  await t.test('an edge pointing outside the group is ignored', () => {
    const edges = [{ source: 'a', target: 'outside-the-group' }];
    assert.deepEqual(orderGroupLevels(['a'], edges, 'start'), [['a']]);
  });

  await t.test('a cycle terminates instead of looping forever, dumping the unresolved rest in one level', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const levels = orderGroupLevels(['a', 'b'], edges, 'start');
    assert.equal(levels.length, 1);
    assert.deepEqual(new Set(levels[0]), new Set(['a', 'b']));
  });

  await t.test('empty input returns no levels', () => {
    assert.deepEqual(orderGroupLevels([], [], 'start'), []);
  });
});

test('mapLimit', async (t) => {
  await t.test('never runs more than `limit` at once', async () => {
    let active = 0;
    let maxActive = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n;
    });
    assert.equal(maxActive, 2);
  });

  await t.test('results stay in input order regardless of completion order', async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapLimit(delays, 2, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    assert.deepEqual(results, [0, 1, 2, 3]);
  });

  await t.test('a limit larger than the input still runs everything exactly once', async () => {
    const results = await mapLimit(['a', 'b', 'c'], 10, async (s) => s.toUpperCase());
    assert.deepEqual(results, ['A', 'B', 'C']);
  });

  await t.test('empty input resolves to an empty array without calling fn', async () => {
    let calls = 0;
    const results = await mapLimit([], 4, async () => calls++);
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  await t.test('a rejection propagates out rather than being swallowed', async () => {
    await assert.rejects(() => mapLimit([1, 2, 3], 2, async (n) => (n === 2 ? Promise.reject(new Error('boom')) : n)), /boom/);
  });
});
