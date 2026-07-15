const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCpuPercent } = require('../server/hostUsage');

test('computeCpuPercent', async (t) => {
  await t.test('computes percent busy from the idle/total delta between two samples', () => {
    const prev = { idle: 1000, total: 2000 };
    const sample = { idle: 1200, total: 2500 };
    // idle grew by 200 out of 500 total - 60% of that window was busy
    assert.equal(computeCpuPercent(prev, sample), 60);
  });

  await t.test('returns null with no previous sample (first poll)', () => {
    assert.equal(computeCpuPercent(null, { idle: 100, total: 200 }), null);
    assert.equal(computeCpuPercent(undefined, { idle: 100, total: 200 }), null);
  });

  await t.test("returns null when total hasn't moved (no elapsed time / clock oddity)", () => {
    const sample = { idle: 1000, total: 2000 };
    assert.equal(computeCpuPercent(sample, { idle: 1000, total: 2000 }), null);
  });

  await t.test('clamps to 0-100 in case of a counter anomaly', () => {
    assert.equal(computeCpuPercent({ idle: 0, total: 1000 }, { idle: 2000, total: 1500 }), 0);
  });
});
