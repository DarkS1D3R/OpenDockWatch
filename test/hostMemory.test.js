const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let hostMemory;
before(async () => {
  hostMemory = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'hostMemory.js')));
});

test('resolveHostMemoryDisplay', async (t) => {
  await t.test('returns null when there is no host-system data at all (remote host)', () => {
    const result = hostMemory.resolveHostMemoryDisplay({
      osUsedBytes: null,
      osTotalBytes: null,
      dockerTotalBytes: 10e9,
      dockerUsedBytes: 1e9,
    });
    assert.equal(result, null);
  });

  await t.test("non-divergent: os and docker totals roughly agree, so today's plain os-based display is unchanged", () => {
    const result = hostMemory.resolveHostMemoryDisplay({
      osUsedBytes: 8e9,
      osTotalBytes: 16e9,
      dockerTotalBytes: 16e9,
      dockerUsedBytes: 2e9,
    });
    assert.deepEqual(result, {
      heading: 'host total',
      label: '8.0 GB / 16.0 GB',
      seriesLabel: 'host total',
      extraLabel: null,
    });
  });

  await t.test('divergent: os total is well over the docker-reported total (Docker running inside an LXC)', () => {
    const result = hostMemory.resolveHostMemoryDisplay({
      osUsedBytes: 40e9,
      osTotalBytes: 64e9,
      dockerTotalBytes: 10e9,
      dockerUsedBytes: 1.2e9,
    });
    assert.deepEqual(result, {
      heading: 'LXC total',
      label: '1.2 GB / 10.0 GB',
      seriesLabel: 'physical host',
      extraLabel: 'physical host: 64.0 GB',
    });
  });

  await t.test('boundary: right at HOST_MEM_DIVERGENCE_RATIO does not trigger divergence (strict >)', () => {
    const dockerTotalBytes = 10e9;
    const result = hostMemory.resolveHostMemoryDisplay({
      osUsedBytes: 1e9,
      osTotalBytes: dockerTotalBytes * hostMemory.HOST_MEM_DIVERGENCE_RATIO,
      dockerTotalBytes,
      dockerUsedBytes: 1e9,
    });
    assert.equal(result.heading, 'host total');
  });

  await t.test('boundary: just over HOST_MEM_DIVERGENCE_RATIO does trigger divergence', () => {
    const dockerTotalBytes = 10e9;
    const result = hostMemory.resolveHostMemoryDisplay({
      osUsedBytes: 1e9,
      osTotalBytes: dockerTotalBytes * hostMemory.HOST_MEM_DIVERGENCE_RATIO + 1,
      dockerTotalBytes,
      dockerUsedBytes: 1e9,
    });
    assert.equal(result.heading, 'LXC total');
  });

  await t.test('missing/zero used-bytes format as 0.0 GB rather than NaN GB', () => {
    const result = hostMemory.resolveHostMemoryDisplay({
      osUsedBytes: undefined,
      osTotalBytes: 16e9,
      dockerTotalBytes: 16e9,
      dockerUsedBytes: undefined,
    });
    assert.equal(result.label, '0.0 GB / 16.0 GB');
  });
});
