const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as the other lib tests.
let m;
test.before(async () => {
  m = await import('../public/js/lib/resourceLimits.js');
});

const NONE = { memoryLimitBytes: null, cpuLimit: null, pidsLimit: null };

test('cpuLimitLabel', async (t) => {
  await t.test('is null until the limits have loaded', () => {
    assert.equal(m.cpuLimitLabel(undefined), null);
    assert.equal(m.cpuLimitLabel(null), null);
  });
  await t.test('is null with no limit set, so the panel never shows "limit no limit"', () => {
    assert.equal(m.cpuLimitLabel(NONE), null);
  });
  await t.test('words whole, fractional and singular limits', () => {
    assert.equal(m.cpuLimitLabel({ ...NONE, cpuLimit: 2 }), '2 CPUs');
    assert.equal(m.cpuLimitLabel({ ...NONE, cpuLimit: 1 }), '1 CPU');
    assert.equal(m.cpuLimitLabel({ ...NONE, cpuLimit: 0.5 }), '0.5 CPUs');
  });
  await t.test('trims float noise from a quota/period division', () => {
    assert.equal(m.cpuLimitLabel({ ...NONE, cpuLimit: 1 / 3 }), '0.33 CPUs');
  });
});

test('memoryLimitLabel', async (t) => {
  await t.test('is null until loaded and "no limit" when unset', () => {
    assert.equal(m.memoryLimitLabel(undefined), null);
    assert.equal(m.memoryLimitLabel(NONE), 'no limit');
  });
  await t.test('formats a set limit in the binary units it was configured in', () => {
    assert.equal(m.memoryLimitLabel({ ...NONE, memoryLimitBytes: 536870912 }), '512 MiB');
    assert.equal(m.memoryLimitLabel({ ...NONE, memoryLimitBytes: 1610612736 }), '1.5 GiB');
    assert.equal(m.memoryLimitLabel({ ...NONE, memoryLimitBytes: 4194304 }), '4 MiB');
  });
});

test('pidsLimitLabel', async (t) => {
  await t.test('only appears when a limit is set', () => {
    assert.equal(m.pidsLimitLabel(undefined), null);
    assert.equal(m.pidsLimitLabel(NONE), null);
    assert.equal(m.pidsLimitLabel({ ...NONE, pidsLimit: 200 }), '200');
  });
});
