const test = require('node:test');
const assert = require('node:assert/strict');
const { orderGroupLevels } = require('../server/composeGroup');

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
