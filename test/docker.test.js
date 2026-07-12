const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseByteString,
  parseMemUsedBytes,
  parseLabels,
  parseHealth,
  networkEdges,
  dependsOnEdges,
  computeRate,
  computeIoRates,
} = require('../server/docker');

test('parseByteString', async (t) => {
  await t.test('parses decimal (SI) units', () => {
    assert.equal(parseByteString('1.2MB'), 1.2 * 1000 ** 2);
  });

  await t.test('parses binary (IEC) units', () => {
    assert.equal(parseByteString('512MiB'), 512 * 1024 ** 2);
  });

  await t.test('returns 0 for empty or unparseable input', () => {
    assert.equal(parseByteString(''), 0);
    assert.equal(parseByteString(undefined), 0);
    assert.equal(parseByteString('not a size'), 0);
  });
});

test('parseMemUsedBytes', () => {
  assert.equal(parseMemUsedBytes('512MiB / 2GiB'), 512 * 1024 ** 2);
});

test('computeRate', async (t) => {
  await t.test('divides the byte delta by elapsed seconds', () => {
    assert.equal(computeRate(1500, 1000, 5), 100);
  });

  await t.test('returns null with no previous value (first poll / just restarted)', () => {
    assert.equal(computeRate(1000, null, 5), null);
    assert.equal(computeRate(1000, undefined, 5), null);
  });

  await t.test('returns null with no elapsed time', () => {
    assert.equal(computeRate(1500, 1000, 0), null);
    assert.equal(computeRate(1500, 1000, null), null);
  });

  await t.test('returns null instead of a negative rate when the counter went backwards (container restarted)', () => {
    assert.equal(computeRate(100, 5000, 5), null);
  });
});

test('computeIoRates', async (t) => {
  await t.test('computes all four rates from current/previous cumulative bytes', () => {
    const current = { netRxBytes: 2000, netTxBytes: 500, blockReadBytes: 4000, blockWriteBytes: 1000 };
    const prev = { netRxBytes: 1000, netTxBytes: 0, blockReadBytes: 3000, blockWriteBytes: 500 };
    assert.deepEqual(computeIoRates(current, prev, 10), {
      netRxRate: 100,
      netTxRate: 50,
      blockReadRate: 100,
      blockWriteRate: 50,
    });
  });

  await t.test('all rates are null with no previous sample', () => {
    const current = { netRxBytes: 2000, netTxBytes: 500, blockReadBytes: 4000, blockWriteBytes: 1000 };
    assert.deepEqual(computeIoRates(current, null, 10), {
      netRxRate: null,
      netTxRate: null,
      blockReadRate: null,
      blockWriteRate: null,
    });
  });
});

test('parseLabels', async (t) => {
  await t.test('parses comma-separated key=value pairs', () => {
    assert.deepEqual(parseLabels('a=1,b=2'), { a: '1', b: '2' });
  });

  await t.test('keeps everything after the first "=" as the value', () => {
    assert.deepEqual(parseLabels('a=1=2'), { a: '1=2' });
  });

  await t.test('returns {} for empty input', () => {
    assert.deepEqual(parseLabels(''), {});
    assert.deepEqual(parseLabels(undefined), {});
  });

  await t.test('skips pairs with no "="', () => {
    assert.deepEqual(parseLabels('a=1,bogus,c=3'), { a: '1', c: '3' });
  });
});

test('parseHealth', async (t) => {
  await t.test('extracts a healthy status', () => {
    assert.equal(parseHealth('Up 2 hours (healthy)'), 'healthy');
  });

  await t.test('extracts an unhealthy status', () => {
    assert.equal(parseHealth('Up 2 hours (unhealthy)'), 'unhealthy');
  });

  await t.test('normalizes "health: starting" to "starting"', () => {
    assert.equal(parseHealth('Up 5 seconds (health: starting)'), 'starting');
  });

  await t.test('returns null when there is no health status', () => {
    assert.equal(parseHealth('Up 2 hours'), null);
    assert.equal(parseHealth(''), null);
    assert.equal(parseHealth(undefined), null);
  });
});

test('networkEdges', async (t) => {
  await t.test('connects containers that share a custom network', () => {
    const edges = networkEdges([
      { id: 'a', networks: ['app-net'] },
      { id: 'b', networks: ['app-net'] },
      { id: 'c', networks: ['other-net'] },
    ]);
    assert.equal(edges.length, 1);
    assert.deepEqual([edges[0].source, edges[0].target].sort(), ['a', 'b']);
    assert.equal(edges[0].kind, 'network');
  });

  await t.test('does not duplicate an edge for containers sharing multiple networks', () => {
    const edges = networkEdges([
      { id: 'a', networks: ['net1', 'net2'] },
      { id: 'b', networks: ['net1', 'net2'] },
    ]);
    assert.equal(edges.length, 1);
  });

  await t.test('returns no edges when containers share no network', () => {
    const edges = networkEdges([
      { id: 'a', networks: ['net1'] },
      { id: 'b', networks: ['net2'] },
    ]);
    assert.equal(edges.length, 0);
  });

  await t.test('suppresses the edge when both containers are in the same compose project', () => {
    const edges = networkEdges([
      { id: 'a', networks: ['app-net'], composeProject: 'shop' },
      { id: 'b', networks: ['app-net'], composeProject: 'shop' },
    ]);
    assert.equal(edges.length, 0);
  });

  await t.test('still connects containers from different compose projects', () => {
    const edges = networkEdges([
      { id: 'a', networks: ['proxy-net'], composeProject: 'shop' },
      { id: 'b', networks: ['proxy-net'], composeProject: 'esb' },
    ]);
    assert.equal(edges.length, 1);
  });

  await t.test('still connects when only one side is grouped', () => {
    const edges = networkEdges([
      { id: 'a', networks: ['app-net'], composeProject: 'shop' },
      { id: 'b', networks: ['app-net'], composeProject: null },
    ]);
    assert.equal(edges.length, 1);
  });
});

test('dependsOnEdges', async (t) => {
  await t.test('emits an edge for a single dependency', () => {
    const containers = [
      { id: 'a', composeProject: 'shop', composeService: 'api' },
      { id: 'b', composeProject: 'shop', composeService: 'db' },
    ];
    const edges = dependsOnEdges(containers, 'a\tdb:service_healthy:false');
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], { source: 'a', target: 'b', kind: 'depends_on', label: 'service_healthy' });
  });

  await t.test('handles multiple comma-separated dependencies without truncating', () => {
    const containers = [
      { id: 'a', composeProject: 'shop', composeService: 'api' },
      { id: 'b', composeProject: 'shop', composeService: 'db' },
      { id: 'c', composeProject: 'shop', composeService: 'redis' },
    ];
    const edges = dependsOnEdges(containers, 'a\tdb:service_healthy:false,redis:service_started:false');
    assert.equal(edges.length, 2);
    assert.deepEqual(edges.map((e) => e.target).sort(), ['b', 'c']);
  });

  await t.test('resolves a scaled service to all of its replica containers', () => {
    const containers = [
      { id: 'a', composeProject: 'shop', composeService: 'api' },
      { id: 'w1', composeProject: 'shop', composeService: 'worker' },
      { id: 'w2', composeProject: 'shop', composeService: 'worker' },
    ];
    const edges = dependsOnEdges(containers, 'a\tworker:service_started:false');
    assert.equal(edges.length, 2);
    assert.deepEqual(edges.map((e) => e.target).sort(), ['w1', 'w2']);
  });

  await t.test('produces no edges for a container with no depends_on label', () => {
    const containers = [
      { id: 'a', composeProject: 'shop', composeService: 'api' },
      { id: 'b', composeProject: 'shop', composeService: 'db' },
    ];
    const edges = dependsOnEdges(containers, 'a\t\nb\t');
    assert.equal(edges.length, 0);
  });

  await t.test('does not cross compose projects', () => {
    const containers = [
      { id: 'a', composeProject: 'shop', composeService: 'api' },
      { id: 'b', composeProject: 'esb', composeService: 'db' },
    ];
    const edges = dependsOnEdges(containers, 'a\tdb:service_healthy:false');
    assert.equal(edges.length, 0);
  });
});
