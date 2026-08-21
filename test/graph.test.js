const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// graph/elements.js and graph/svgExport.js are both plain ES modules with no browser dependency
// (they only import format.js and each other) - aggregateGroups/buildElements/buildTreeElements
// and renderSvg are pure data transforms that never touch cytoscape/DOM globals, so importing
// them directly is safe without a browser or a mocked cytoscape. graph.js itself (the live
// cytoscape controller the rest of graph/ feeds into) is mostly DOM-coupled and stays
// syntax-check-only for everything else, per public/CLAUDE.md - but nothing at its module scope
// touches a DOM/cytoscape global (those are all inside function bodies), and containerNodeTpl/
// collapsedGroupTpl specifically are pure string builders with no such dependency of their own, so
// importing it here to reach just those two is safe. pathToFileURL rather than a plain relative
// string: import()'s relative-specifier resolution expects forward slashes, so a path.join'd path
// breaks on Windows where it comes out backslash-separated.
let elements, svgExport, theme, graph;
before(async () => {
  const graphDir = path.join(__dirname, '..', 'public', 'js', 'graph');
  elements = await import(pathToFileURL(path.join(graphDir, 'elements.js')));
  svgExport = await import(pathToFileURL(path.join(graphDir, 'svgExport.js')));
  // The colour assertions below read STATE_COLORS rather than repeating its hex values. Pinning
  // literals here was worse than no test: it passed while svgExport and CY_STYLE disagreed, which
  // is the one failure those assertions look like they exist to catch. See test/theme.test.js.
  theme = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'theme.js')));
  graph = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'graph.js')));
});

test('aggregateGroups', async (t) => {
  await t.test('sums count/cpu/mem/openAlerts per group', () => {
    const nodes = [
      { group: 'shop', cpuPerc: 10, memPerc: 20, openAlerts: 1 },
      { group: 'shop', cpuPerc: 30, memPerc: 40, openAlerts: 2 },
      { group: 'esb', cpuPerc: 5, memPerc: 5, openAlerts: 0 },
    ];
    const agg = elements.aggregateGroups(nodes);
    assert.deepEqual(agg.get('shop'), { count: 2, cpuSum: 40, memSum: 60, openAlerts: 3, health: null });
    assert.deepEqual(agg.get('esb'), { count: 1, cpuSum: 5, memSum: 5, openAlerts: 0, health: null });
  });

  await t.test('worst health wins: unhealthy > starting > healthy', () => {
    const nodes = [
      { group: 'shop', health: 'healthy' },
      { group: 'shop', health: 'starting' },
      { group: 'shop', health: 'unhealthy' },
    ];
    assert.equal(elements.aggregateGroups(nodes).get('shop').health, 'unhealthy');
  });

  await t.test('a node with no health never overrides an already-set one', () => {
    const nodes = [
      { group: 'shop', health: 'unhealthy' },
      { group: 'shop', health: null },
    ];
    assert.equal(elements.aggregateGroups(nodes).get('shop').health, 'unhealthy');
  });

  await t.test('missing cpu/mem/openAlerts on a node count as 0, not NaN', () => {
    const nodes = [{ group: 'shop' }];
    assert.deepEqual(elements.aggregateGroups(nodes).get('shop'), { count: 1, cpuSum: 0, memSum: 0, openAlerts: 0, health: null });
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
    const els = elements.buildElements(nodes, edges, null);
    assert.equal(els.filter((el) => el.classes === 'group').length, 2);
    assert.equal(els.filter((el) => el.data.id === 'a' || el.data.id === 'b' || el.data.id === 'c').length, 3);
    assert.equal(els.filter((el) => el.data.source).length, 1);
  });

  await t.test('group node data carries the *average* cpu/mem across its members, not the sum', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running', cpuPerc: 10, memPerc: 20 },
      { id: 'b', group: 'shop', state: 'running', cpuPerc: 30, memPerc: 40 },
    ];
    const group = elements.buildElements(nodes, [], null).find((el) => el.data.id === 'grp:shop');
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
    const el = elements.buildElements(nodes, [], null).find((e) => e.data.id === 'a');
    assert.equal(el.data.parent, 'grp:shop');
    assert.equal(el.data.name, 'web');
    assert.equal(el.data.ports, '8080:80');
    assert.equal(el.data.portLines, 1);
    assert.equal(el.data.netIO, '1.5 kB/s / 0 B/s');
    assert.equal(el.data.openAlerts, 2);
  });

  await t.test('a container publishing enough ports to overflow one line wraps at mapping boundaries and reports the line count', () => {
    const ports = Array.from({ length: 6 }, (_, i) => `0.0.0.0:800${i}->${i}0/tcp`).join(', ');
    const nodes = [{ id: 'a', group: 'shop', state: 'running', ports }];
    const el = elements.buildElements(nodes, [], null).find((e) => e.data.id === 'a');
    const lines = el.data.ports.split('\n');
    assert.ok(lines.length > 1, 'expected the port list to wrap onto more than one line');
    assert.equal(el.data.portLines, lines.length);
    // rejoining every line's tokens should reproduce exactly the 6 clean "host:container"
    // mappings - proves none were dropped and none got split mid-token across a line break
    const tokens = lines.join(', ').split(', ');
    assert.equal(tokens.length, 6);
    for (const token of tokens) assert.match(token, /^\d+:\d+$/);
  });

  await t.test('node classes reflect running/stopped/created, unhealthy, starting, and selection', () => {
    const nodes = [
      { id: 'a', group: 'g', state: 'running', health: 'healthy' },
      { id: 'b', group: 'g', state: 'exited', health: 'unhealthy' },
      { id: 'c', group: 'g', state: 'running', health: 'healthy' },
      { id: 'd', group: 'g', state: 'running', health: 'starting' },
      { id: 'e', group: 'g', state: 'created' },
    ];
    const els = elements.buildElements(nodes, [], 'c');
    assert.equal(els.find((e) => e.data.id === 'a').classes, 'running');
    assert.equal(els.find((e) => e.data.id === 'b').classes, 'stopped unhealthy');
    assert.equal(els.find((e) => e.data.id === 'c').classes, 'running selected');
    assert.equal(els.find((e) => e.data.id === 'd').classes, 'running starting');
    assert.equal(els.find((e) => e.data.id === 'e').classes, 'created');
  });

  await t.test('every state class it emits is listed in CONTAINER_STATE_CLASSES', () => {
    // layout.js builds its overlap and compact-flag selectors off that list, and graph.js/svgExport.js
    // their label query and node-kind test. A state emitted here but missing there doesn't throw - the
    // node just silently stops resolving overlaps and stops shrinking on zoom-out, which is how
    // `created` shipped broken. Sweep every docker state so a new branch can't be added quietly.
    const states = ['running', 'created', 'exited', 'stopped', 'paused', 'restarting', 'dead', 'removing', undefined];
    const els = elements.buildElements(
      states.map((state, i) => ({ id: `c${i}`, group: 'g', state })),
      [],
      null
    );
    const containerIds = new Set(states.map((_, i) => `c${i}`));
    for (const el of els.filter((e) => containerIds.has(e.data.id))) {
      const stateClass = el.classes.split(' ')[0];
      assert.ok(
        elements.CONTAINER_STATE_CLASSES.includes(stateClass),
        `${stateClass} is emitted by buildElements but missing from CONTAINER_STATE_CLASSES`
      );
    }
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
    const edgeEls = elements.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls[0].classes, 'edge-manual');
    assert.equal(edgeEls[1].classes, 'edge-depends-on');
    assert.equal(edgeEls[2].classes, 'edge-network');
    assert.equal(edgeEls[3].classes, 'edge-network');
    assert.equal(edgeEls[3].data.label, '');
    assert.equal(edgeEls[1].data.id, 'edge:depends_on:a->b');
  });

  await t.test('a network edge between containers in different compose projects collapses to one project-to-project edge', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running' },
      { id: 'b', group: 'esb', state: 'running' },
    ];
    const edges = [{ source: 'a', target: 'b', kind: 'network', label: 'proxy' }];
    const edgeEls = elements.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls.length, 1);
    // aggregation dedupes on a sorted pair key - which end lands in source vs target isn't
    // meaningful for an undirected "shares a network" relationship, only that it's this pair.
    assert.deepEqual(new Set([edgeEls[0].data.source, edgeEls[0].data.target]), new Set(['grp:shop', 'grp:esb']));
    assert.equal(edgeEls[0].data.label, 'proxy');
  });

  await t.test('many cross-project container pairs sharing a network collapse to a single edge, not one per pair', () => {
    const nodes = [
      { id: 'a1', group: 'shop', state: 'running' },
      { id: 'a2', group: 'shop', state: 'running' },
      { id: 'b1', group: 'esb', state: 'running' },
      { id: 'b2', group: 'esb', state: 'running' },
    ];
    const edges = [
      { source: 'a1', target: 'b1', kind: 'network', label: 'proxy' },
      { source: 'a1', target: 'b2', kind: 'network', label: 'proxy' },
      { source: 'a2', target: 'b1', kind: 'network', label: 'proxy' },
      { source: 'a2', target: 'b2', kind: 'network', label: 'proxy' },
    ];
    const edgeEls = elements.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls.length, 1);
    assert.deepEqual(new Set([edgeEls[0].data.source, edgeEls[0].data.target]), new Set(['grp:shop', 'grp:esb']));
  });

  await t.test('distinct networks shared between the same two projects merge onto one edge label', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running' },
      { id: 'b', group: 'esb', state: 'running' },
    ];
    const edges = [
      { source: 'a', target: 'b', kind: 'network', label: 'proxy' },
      { source: 'a', target: 'b', kind: 'network', label: 'cache' },
    ];
    const edgeEls = elements.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls.length, 1);
    assert.equal(edgeEls[0].data.label, 'proxy, cache');
  });

  await t.test('containers with no compose project keep per-container network edges (no shared box to collapse into)', () => {
    const nodes = [
      { id: 'a', group: 'ungrouped', state: 'running' },
      { id: 'b', group: 'ungrouped', state: 'running' },
    ];
    const edges = [{ source: 'a', target: 'b', kind: 'network', label: 'bridge' }];
    const edgeEls = elements.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls.length, 1);
    assert.equal(edgeEls[0].data.source, 'a');
    assert.equal(edgeEls[0].data.target, 'b');
  });

  await t.test('depends_on/manual edges are never aggregated by project, even across projects', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running' },
      { id: 'b', group: 'esb', state: 'running' },
    ];
    const edges = [{ source: 'a', target: 'b', kind: 'depends_on', label: 'service_healthy' }];
    const edgeEls = elements.buildElements(nodes, edges, null).filter((e) => e.data.source);
    assert.equal(edgeEls.length, 1);
    assert.equal(edgeEls[0].data.source, 'a');
    assert.equal(edgeEls[0].data.target, 'b');
  });
});

test('buildTreeElements', async (t) => {
  await t.test('dedups a network shared by two containers into one pill with two incoming edges', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running', networks: ['app-net'], mounts: [] },
      { id: 'b', group: 'shop', state: 'running', networks: ['app-net'], mounts: [] },
    ];
    const els = elements.buildTreeElements(nodes, null);
    const netNodes = els.filter((el) => el.classes === 'net');
    assert.equal(netNodes.length, 1);
    assert.equal(netNodes[0].data.id, 'net:app-net');
    const netEdges = els.filter((el) => el.data.target === 'net:app-net');
    assert.equal(netEdges.length, 2);
    assert.deepEqual(netEdges.map((e) => e.data.source).sort(), ['a', 'b']);
  });

  await t.test('wraps a long compose network name onto multiple lines rather than overflowing the pill', () => {
    const longName = 'opendockwatch_default_network';
    const nodes = [{ id: 'a', group: 'shop', state: 'running', networks: [longName], mounts: [] }];
    const netNode = elements.buildTreeElements(nodes, null).find((el) => el.classes === 'net');
    assert.ok(netNode.data.label.includes('\n'), 'expected the long network name to be wrapped onto multiple lines');
    assert.equal(netNode.data.label.replace(/\n/g, ''), longName);
    // net:<id> in the id keeps the unwrapped name, same as mount:<source> does for mounts.
    assert.equal(netNode.data.id, `net:${longName}`);
  });

  await t.test('shortens an anonymous-volume label but keeps the full source as the stable id', () => {
    const anonId = 'a'.repeat(64);
    const nodes = [{ id: 'a', group: 'shop', state: 'running', networks: [], mounts: [{ source: anonId, kind: 'volume-anon' }] }];
    const mountNode = elements.buildTreeElements(nodes, null).find((el) => el.classes === 'mount mount-volume');
    assert.equal(mountNode.data.id, `mount:${anonId}`);
    assert.equal(mountNode.data.label, `anon:${anonId.slice(0, 12)}…`);
  });

  await t.test('wraps a long bind-mount path onto multiple lines at path-separator boundaries', () => {
    const longPath = '/mnt/c/Projects/bm-server/application/target/bm-server-files/bm-server-1.0.0-SNAPSHOT.jar';
    const nodes = [{ id: 'a', group: 'shop', state: 'running', networks: [], mounts: [{ source: longPath, kind: 'bind' }] }];
    const mountNode = elements.buildTreeElements(nodes, null).find((el) => el.classes === 'mount mount-bind');
    assert.ok(mountNode.data.label.includes('\n'), 'expected the long path to be wrapped onto multiple lines');
    assert.ok(
      mountNode.data.label.split('\n').every((line) => line.length <= 22),
      'expected every wrapped line to stay under the max line length'
    );
    assert.equal(mountNode.data.label.replace(/\n/g, ''), longPath);
  });

  await t.test('leaves a short mount source on a single line, unwrapped', () => {
    const nodes = [{ id: 'a', group: 'shop', state: 'running', networks: [], mounts: [{ source: 'pgdata', kind: 'volume-named' }] }];
    const mountNode = elements.buildTreeElements(nodes, null).find((el) => el.classes === 'mount mount-volume');
    assert.equal(mountNode.data.label, 'pgdata');
  });

  await t.test('a container mounting the same volume at two destinations gets one edge, not two', () => {
    const nodes = [
      {
        id: 'a',
        group: 'shop',
        state: 'running',
        networks: [],
        mounts: [
          { source: 'pgdata', kind: 'volume-named', destination: '/var/lib/pg1' },
          { source: 'pgdata', kind: 'volume-named', destination: '/var/lib/pg2' },
        ],
      },
    ];
    const els = elements.buildTreeElements(nodes, null);
    const mountEdges = els.filter((el) => el.classes === 'edge-tree-mount');
    assert.equal(mountEdges.length, 1);
    assert.equal(els.filter((el) => el.classes && el.classes.startsWith('mount')).length, 1);
  });

  await t.test('a container with no compose project gets no project node or edge', () => {
    const nodes = [{ id: 'a', group: 'ungrouped', state: 'running', networks: [], mounts: [] }];
    const els = elements.buildTreeElements(nodes, null);
    assert.equal(els.filter((el) => el.classes === 'proj').length, 0);
    assert.equal(els.filter((el) => el.data.target === 'a').length, 0);
  });

  await t.test('produces stable ids across two calls with equivalent input', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running', networks: ['app-net'], mounts: [{ source: 'pgdata', kind: 'volume-named' }] },
    ];
    const first = elements
      .buildTreeElements(nodes, null)
      .map((el) => el.data.id)
      .sort();
    const second = elements
      .buildTreeElements(nodes, null)
      .map((el) => el.data.id)
      .sort();
    assert.deepEqual(first, second);
  });

  await t.test('showNetworks: false and showMounts: false suppress those pills and edges entirely', () => {
    const nodes = [
      { id: 'a', group: 'shop', state: 'running', networks: ['app-net'], mounts: [{ source: 'pgdata', kind: 'volume-named' }] },
    ];
    const els = elements.buildTreeElements(nodes, null, { showNetworks: false, showMounts: false });
    assert.equal(els.filter((el) => el.classes === 'net').length, 0);
    assert.equal(els.filter((el) => el.classes && el.classes.startsWith('mount')).length, 0);
    assert.equal(els.filter((el) => el.data.id && el.data.id.startsWith('edge:tree:a->')).length, 0);
  });

  await t.test('container node data mirrors buildElements shape, with no parent field', () => {
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
        networks: [],
        mounts: [],
      },
    ];
    const el = elements.buildTreeElements(nodes, null).find((e) => e.data.id === 'a');
    assert.equal(el.data.parent, undefined);
    assert.equal(el.data.name, 'web');
    assert.equal(el.data.ports, '8080:80');
    assert.equal(el.data.netIO, '1.5 kB/s / 0 B/s');
    assert.equal(el.data.openAlerts, 2);
  });

  await t.test('selectedId marks the matching container node selected', () => {
    const nodes = [{ id: 'a', group: 'shop', state: 'running', networks: [], mounts: [] }];
    const els = elements.buildTreeElements(nodes, 'a');
    assert.equal(els.find((e) => e.data.id === 'a').classes, 'running selected');
  });
});

// Fixtures deliberately skip extractSvgGeometry (which needs a live cy instance) and match its
// output shape directly - renderSvg is pure, so it can be exercised the same way buildElements
// is: feed it plain data, assert on the string it returns.
function svgContainerFixture(overrides = {}) {
  return {
    id: 'a',
    kind: 'container',
    x: 100,
    y: 100,
    width: 170,
    height: 76,
    running: true,
    stopped: false,
    created: false,
    unhealthy: false,
    selected: false,
    faded: false,
    blastUpstream: false,
    blastDownstream: false,
    data: {
      name: 'web',
      status: 'Up 3 minutes',
      icon: { text: 'W', bg: '#4f8cff' },
      cpuPerc: 10,
      memPerc: 20,
      netIO: '0 B/s / 0 B/s',
      blockIO: '0 B/s / 0 B/s',
    },
    ...overrides,
  };
}

test('renderSvg', async (t) => {
  const strokes = (svg) => [...svg.matchAll(/stroke="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());

  await t.test('a running container renders a rect in the running border color and its name as text', () => {
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture()], edges: [] });
    assert.ok(strokes(svg).includes(theme.STATE_COLORS.running));
    assert.match(svg, /web/);
  });

  await t.test('an unhealthy container uses the unhealthy border color', () => {
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture({ unhealthy: true })], edges: [] });
    assert.ok(strokes(svg).includes(theme.STATE_COLORS.unhealthy));
  });

  await t.test('a created-but-never-started container gets a dashed accent-colored border, distinct from stopped', () => {
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture({ running: false, created: true })], edges: [] });
    assert.ok(strokes(svg).includes(theme.STATE_COLORS.created));
    assert.ok(!strokes(svg).includes(theme.STATE_COLORS.stopped), 'created must not fall back to the stopped colour');
    assert.match(svg, /stroke-dasharray="6 4"/);
  });

  await t.test('a selected container uses the selected border color', () => {
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture({ selected: true })], edges: [] });
    assert.ok(strokes(svg).includes(theme.SELECTED));
  });

  // The precedence CY_STYLE gets free from selector order, which svgExport has to restate by hand:
  // the more urgent fact wins the border. Asserted as a chain rather than one case, since the bug
  // this guards is an `if` landing in the wrong order, which a single-state test cannot see.
  await t.test('health outranks state, and selection outranks health', () => {
    const starting = svgExport.renderSvg({ nodes: [svgContainerFixture({ starting: true })], edges: [] });
    assert.ok(strokes(starting).includes(theme.STATE_COLORS.starting), 'starting must beat running');

    const unhealthy = svgExport.renderSvg({ nodes: [svgContainerFixture({ starting: true, unhealthy: true })], edges: [] });
    assert.ok(strokes(unhealthy).includes(theme.STATE_COLORS.unhealthy), 'unhealthy must beat starting');

    const selected = svgExport.renderSvg({ nodes: [svgContainerFixture({ unhealthy: true, selected: true })], edges: [] });
    assert.ok(strokes(selected).includes(theme.SELECTED), 'selected must beat unhealthy');
  });

  await t.test('a bind-mount pill with a wrapped multi-line label emits one tspan per line', () => {
    const node = {
      id: 'mount:/a/very/long/path',
      kind: 'mount-bind',
      x: 200,
      y: 200,
      width: 170,
      height: 40,
      faded: false,
      data: { label: '/a/very/\nlong/path' },
    };
    const svg = svgExport.renderSvg({ nodes: [node], edges: [] });
    const tspanCount = (svg.match(/<tspan/g) || []).length;
    assert.equal(tspanCount, 2);
    assert.match(svg, /\/a\/very\//);
    assert.match(svg, /long\/path/);
  });

  await t.test('a volume pill renders in the lighter volume color, distinct from a bind mount', () => {
    const bindSvg = svgExport.renderSvg({
      nodes: [{ id: 'm1', kind: 'mount-bind', x: 0, y: 0, width: 170, height: 26, faded: false, data: { label: 'x' } }],
      edges: [],
    });
    const volumeSvg = svgExport.renderSvg({
      nodes: [{ id: 'm2', kind: 'mount-volume', x: 0, y: 0, width: 170, height: 26, faded: false, data: { label: 'x' } }],
      edges: [],
    });
    assert.match(bindSvg, /stroke="#d29922"/);
    assert.match(volumeSvg, /stroke="#e8c766"/);
  });

  await t.test('a shared mount or volume renders in the shared color regardless of kind', () => {
    const sharedBindSvg = svgExport.renderSvg({
      nodes: [{ id: 'm1', kind: 'mount-bind', x: 0, y: 0, width: 170, height: 26, faded: false, data: { label: 'x', shared: true } }],
      edges: [],
    });
    const sharedVolumeSvg = svgExport.renderSvg({
      nodes: [{ id: 'm2', kind: 'mount-volume', x: 0, y: 0, width: 170, height: 26, faded: false, data: { label: 'x', shared: true } }],
      edges: [],
    });
    assert.match(sharedBindSvg, /stroke="#f0883e"/);
    assert.match(sharedVolumeSvg, /stroke="#f0883e"/);
  });

  const edgeKinds = [
    ['network', '#d160a8'],
    ['depends_on', '#199e70'],
    ['manual', '#4f8cff'],
    ['tree-proj', '#3a3f4b'],
    ['tree-net', '#4f8cff'],
    ['tree-mount', '#d29922'],
  ];
  for (const [kind, color] of edgeKinds) {
    await t.test(`edge kind "${kind}" renders in its expected color`, () => {
      const edge = { id: `e-${kind}`, kind, source: { x: 0, y: 0 }, target: { x: 100, y: 50 }, label: '', faded: false };
      const svg = svgExport.renderSvg({ nodes: [svgContainerFixture()], edges: [edge] });
      assert.match(svg, new RegExp(`stroke="${color}"`));
    });
  }

  await t.test('a tree-mount edge to a volume pill renders in the volume color, not the flat bind default', () => {
    const edge = {
      id: 'e-vol',
      kind: 'tree-mount',
      source: { x: 0, y: 0 },
      target: { x: 100, y: 50 },
      label: '',
      faded: false,
      mountShared: false,
      mountVolume: true,
    };
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture()], edges: [edge] });
    assert.match(svg, /stroke="#e8c766"/);
  });

  await t.test('a tree-mount edge to a shared mount/volume renders in the shared color, overriding kind', () => {
    const edge = {
      id: 'e-shared',
      kind: 'tree-mount',
      source: { x: 0, y: 0 },
      target: { x: 100, y: 50 },
      label: '',
      faded: false,
      mountShared: true,
      mountVolume: true,
    };
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture()], edges: [edge] });
    assert.match(svg, /stroke="#f0883e"/);
  });

  await t.test('depends_on and manual edges render their label text', () => {
    const edge = { id: 'e1', kind: 'depends_on', source: { x: 0, y: 0 }, target: { x: 100, y: 0 }, label: 'service_healthy', faded: false };
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture()], edges: [edge] });
    assert.match(svg, /service_healthy/);
  });

  await t.test('a faded node is wrapped in a reduced-opacity group', () => {
    const svg = svgExport.renderSvg({ nodes: [svgContainerFixture({ faded: true })], edges: [] });
    assert.match(svg, /opacity="0.15"/);
  });

  await t.test('the viewBox grows to cover every node plus padding', () => {
    const nodes = [svgContainerFixture({ id: 'a', x: 0, y: 0 }), svgContainerFixture({ id: 'b', x: 1000, y: 500 })];
    const svg = svgExport.renderSvg({ nodes, edges: [] });
    const viewBoxMatch = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
    assert.ok(viewBoxMatch, 'expected a viewBox attribute');
    const [, minX, minY, width, height] = viewBoxMatch.map(Number);
    assert.ok(minX < 0 - 170 / 2, 'viewBox should extend left past the first node plus padding');
    assert.ok(minY < 0 - 76 / 2, 'viewBox should extend up past the first node plus padding');
    assert.ok(width > 1000, 'viewBox width should cover both nodes');
    assert.ok(height > 500, 'viewBox height should cover both nodes');
  });

  await t.test('empty geometry still returns a valid svg document', () => {
    const svg = svgExport.renderSvg({ nodes: [], edges: [] });
    assert.match(svg, /^<svg/);
    assert.match(svg, /<\/svg>$/);
  });
});

function containerTplFixture(overrides = {}) {
  return {
    compact: false,
    faded: false,
    name: 'web',
    status: 'Up 3 minutes',
    emoji: '🟢',
    icon: { bg: '#4f8cff', text: 'W' },
    cpuPerc: 12.3,
    memPerc: 45.6,
    netIO: '1.2 KB/s / 3.4 KB/s',
    blockIO: '0 B/s / 0 B/s',
    ports: '',
    portLines: 0,
    openAlerts: 0,
    ...overrides,
  };
}

function groupTplFixture(overrides = {}) {
  return {
    compact: false,
    faded: false,
    label: 'shop',
    count: 3,
    cpuAvg: 10,
    memAvg: 20,
    openAlerts: 0,
    health: null,
    ...overrides,
  };
}

// Both templates build raw HTML for cytoscape-node-html-label to overlay as real DOM, bypassing
// Vue's own escaping - see graph.js's comment above them. A container/compose-project name is a
// docker/compose-supplied string with no charset restriction, so a name like `<img onerror=...>`
// must not reach the page unescaped even though CSP (no 'unsafe-inline' in script-src) already
// stops it from executing - this is the defence-in-depth half of that story.
test('containerNodeTpl', async (t) => {
  await t.test('escapes an HTML-special container name', () => {
    const html = graph.containerNodeTpl(containerTplFixture({ name: '<img src=x onerror=alert(1)>' }));
    assert.ok(!html.includes('<img src=x'), 'raw tag reached the output unescaped');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped name missing from the output');
  });

  await t.test('escapes an HTML-special status string', () => {
    const html = graph.containerNodeTpl(containerTplFixture({ status: '</span><script>alert(1)</script>' }));
    assert.ok(!html.includes('<script>'), 'raw script tag reached the output unescaped');
    assert.ok(html.includes('&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  await t.test('compact mode escapes the name too, without the status line', () => {
    const html = graph.containerNodeTpl(containerTplFixture({ compact: true, name: '<b>x</b>' }));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(!html.includes('cy-node-status'));
  });

  await t.test('a plain name renders unchanged', () => {
    const html = graph.containerNodeTpl(containerTplFixture({ name: 'web-api' }));
    assert.ok(html.includes('<span class="cy-node-name">web-api</span>'));
  });
});

test('collapsedGroupTpl', async (t) => {
  await t.test('escapes an HTML-special compose project name', () => {
    const html = graph.collapsedGroupTpl(groupTplFixture({ label: '<script>alert(1)</script>' }));
    assert.ok(!html.includes('<script>'), 'raw script tag reached the output unescaped');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  await t.test('compact mode escapes the label too', () => {
    const html = graph.collapsedGroupTpl(groupTplFixture({ compact: true, label: '<b>x</b>' }));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  });

  await t.test('a plain label renders unchanged', () => {
    const html = graph.collapsedGroupTpl(groupTplFixture({ label: 'shop' }));
    assert.ok(html.includes('<span class="cy-node-name">shop</span>'));
  });
});
