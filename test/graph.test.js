const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// graph.js imports format.js (also a plain ES module, no browser dependency) and only touches
// cytoscape/DOM globals inside functions that need a live `cy` instance - buildElements and
// aggregateGroups are pure data transforms that never call any of those, so importing the module
// for just those two is safe without a browser or a mocked cytoscape. pathToFileURL rather than a
// plain relative string: import()'s relative-specifier resolution expects forward slashes, so a
// path.join'd path breaks on Windows where it comes out backslash-separated.
let graph;
before(async () => {
  graph = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'graph.js')));
});

test('aggregateGroups', async (t) => {
  await t.test('sums count/cpu/mem/openAlerts per group', () => {
    const nodes = [
      { group: 'shop', cpuPerc: 10, memPerc: 20, openAlerts: 1 },
      { group: 'shop', cpuPerc: 30, memPerc: 40, openAlerts: 2 },
      { group: 'esb', cpuPerc: 5, memPerc: 5, openAlerts: 0 },
    ];
    const agg = graph.aggregateGroups(nodes);
    assert.deepEqual(agg.get('shop'), { count: 2, cpuSum: 40, memSum: 60, openAlerts: 3, health: null });
    assert.deepEqual(agg.get('esb'), { count: 1, cpuSum: 5, memSum: 5, openAlerts: 0, health: null });
  });

  await t.test('worst health wins: unhealthy > starting > healthy', () => {
    const nodes = [
      { group: 'shop', health: 'healthy' },
      { group: 'shop', health: 'starting' },
      { group: 'shop', health: 'unhealthy' },
    ];
    assert.equal(graph.aggregateGroups(nodes).get('shop').health, 'unhealthy');
  });

  await t.test('a node with no health never overrides an already-set one', () => {
    const nodes = [
      { group: 'shop', health: 'unhealthy' },
      { group: 'shop', health: null },
    ];
    assert.equal(graph.aggregateGroups(nodes).get('shop').health, 'unhealthy');
  });

  await t.test('missing cpu/mem/openAlerts on a node count as 0, not NaN', () => {
    const nodes = [{ group: 'shop' }];
    assert.deepEqual(graph.aggregateGroups(nodes).get('shop'), { count: 1, cpuSum: 0, memSum: 0, openAlerts: 0, health: null });
  });
});

test('buildElements', async (t) => {
  await t.test('emits one group node per distinct group, one node per container, one edge per input edge', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running' },
      { id: 'b', group: 'shop', state: 'running' },
      { id: 'c', group: 'esb', state: 'running' },
    ];
    const edges = [{ source: 'a', target: 'b', kind: 'network' }];
    const elements = graph.buildElements(nodes, edges, null);
    assert.equal(elements.filter((el) => el.classes === 'group').length, 2);
    assert.equal(elements.filter((el) => el.data.id === 'a' || el.data.id === 'b' || el.data.id === 'c').length, 3);
    assert.equal(elements.filter((el) => el.data.source).length, 1);
  });

  await t.test('group node data carries the *average* cpu/mem across its members, not the sum', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running', cpuPerc: 10, memPerc: 20 },
      { id: 'b', group: 'shop', state: 'running', cpuPerc: 30, memPerc: 40 },
    ];
    const group = graph.buildElements(nodes, [], null).find((el) => el.data.id === 'grp:shop');
    assert.equal(group.data.cpuAvg, 20);
    assert.equal(group.data.memAvg, 30);
    assert.equal(group.data.count, 2);
  });

  await t.test('a leaf node is parented to its group and carries formatted display fields', () => {
    const nodes = [
      {
        id: 'a',
        group: 'shop',
        state: 'running',
        name: 'web',
        image: 'nginx:latest',
        ports: '0.0.0.0:8080->80/tcp',
        netRxRate: 1500,
        netTxRate: null,
        openAlerts: 2,
      },
    ];
    const el = graph.buildElements(nodes, [], null).find((e) => e.data.id === 'a');
    assert.equal(el.data.parent, 'grp:shop');
    assert.equal(el.data.name, 'web');
    assert.equal(el.data.ports, ':8080');
    assert.equal(el.data.netIO, '1.5 kB/s / 0 B/s');
    assert.equal(el.data.openAlerts, 2);
  });

  await t.test('node classes reflect running/stopped, unhealthy, and selection', () => {
    const nodes = [
      { id: 'a', group: 'g', state: 'running', health: 'healthy' },
      { id: 'b', group: 'g', state: 'exited', health: 'unhealthy' },
      { id: 'c', group: 'g', state: 'running', health: 'healthy' },
    ];
    const els = graph.buildElements(nodes, [], 'c');
    assert.equal(els.find((e) => e.data.id === 'a').classes, 'running');
    assert.equal(els.find((e) => e.data.id === 'b').classes, 'stopped unhealthy');
    assert.equal(els.find((e) => e.data.id === 'c').classes, 'running selected');
  });

  await t.test('edge classes map by kind, defaulting to edge-network', () => {
    const nodes = [
      { id: 'a', group: 'g', state: 'running' },
      { id: 'b', group: 'g', state: 'running' },
    ];
    const edges = [
      { source: 'a', target: 'b', kind: 'manual', label: 'declared' },
      { source: 'a', target: 'b', kind: 'depends_on', label: 'service_healthy' },
      { source: 'a', target: 'b', kind: 'network' },
      { source: 'a', target: 'b' },
    ];
    const edgeEls = graph.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls[0].classes, 'edge-manual');
    assert.equal(edgeEls[1].classes, 'edge-depends-on');
    assert.equal(edgeEls[2].classes, 'edge-network');
    assert.equal(edgeEls[3].classes, 'edge-network');
    assert.equal(edgeEls[3].data.label, '');
    assert.equal(edgeEls[1].data.id, 'edge:depends_on:a->b');
  });
});
