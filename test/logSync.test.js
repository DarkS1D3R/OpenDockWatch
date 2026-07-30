const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let logSync;
before(async () => {
  logSync = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logSync.js')));
});

test('closestIndexByTs', async (t) => {
  await t.test('returns -1 for an empty array', () => {
    assert.equal(logSync.closestIndexByTs([], 100), -1);
  });

  await t.test('returns -1 for an all-null array', () => {
    assert.equal(logSync.closestIndexByTs([null, null, null], 100), -1);
  });

  await t.test('returns -1 when the target itself is null', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], null), -1);
  });

  await t.test('the only element in a single-element array', () => {
    assert.equal(logSync.closestIndexByTs([10], 999), 0);
  });

  await t.test('the first element for a target before the whole range', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], 0), 0);
  });

  await t.test('the last element for a target after the whole range', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], 100), 2);
  });

  await t.test('an exact match', () => {
    assert.equal(logSync.closestIndexByTs([10, 20, 30], 20), 1);
  });

  await t.test('ties between two equidistant values resolve to the earlier one', () => {
    assert.equal(logSync.closestIndexByTs([10, 30], 20), 0);
  });

  await t.test('skips over null entries to find the nearest real value on either side', () => {
    assert.equal(logSync.closestIndexByTs([10, null, null, 40], 12), 0);
    assert.equal(logSync.closestIndexByTs([10, null, null, 40], 38), 3);
  });

  await t.test('a tie across null gaps still resolves to the earlier real value', () => {
    assert.equal(logSync.closestIndexByTs([10, null, null, 40], 25), 0);
  });

  await t.test('finds the only real value regardless of direction when surrounded by nulls', () => {
    assert.equal(logSync.closestIndexByTs([null, null, 50, null], 10), 2);
    assert.equal(logSync.closestIndexByTs([null, null, 50, null], 999), 2);
  });
});
