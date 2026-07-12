import { stateEmoji, iconFor, parsePublishedPorts, formatRatePair, healthColor } from './format.js';

let htmlLabelRegistered = false;
let expandCollapseRegistered = false;

// Below this zoom level a fit-to-screen view of more than a handful of containers is mostly
// unreadable anyway (the 5px NET/DISK text is already illegible well before zoom 1, not just
// below it) - compact mode trades the CPU/RAM bars and metric text for just enough to answer
// "what is this and is it OK", legible at whatever zoom the graph actually fits at, one zoom-in
// gesture away from the rest. Set high enough that only viewing at (or past) native size keeps
// the full metrics - any amount of zooming out at all switches over.
const COMPACT_ZOOM_THRESHOLD = 1;
const COMPACT_HEIGHT = 34;

const CY_STYLE = [
  {
    selector: 'node.group',
    style: {
      'background-color': '#1d2027',
      'border-width': 1,
      'border-color': '#2b2f38',
      label: 'data(label)',
      'font-size': 12,
      color: '#8b909c',
      'text-valign': 'top',
      'text-halign': 'center',
      padding: '18px',
      shape: 'round-rectangle',
    },
  },
  {
    // Applied by cytoscape-expand-collapse to the single node left standing once a compose
    // group is collapsed - it keeps the 'group' class above (same underlying element, not a
    // replacement), so this has to come after it to win the cascade. label is blanked the same
    // way leaf nodes are - the html-label overlay below carries all the text instead.
    selector: 'node.cy-expand-collapse-collapsed-node',
    style: {
      'background-color': '#1d2027',
      'border-width': 1,
      'border-color': '#2b2f38',
      label: '',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : 88),
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.running',
    style: {
      'background-color': '#1d2027',
      'border-width': 2,
      'border-color': '#3fb950',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : 76),
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.stopped',
    style: {
      'background-color': '#1d2027',
      'border-width': 2,
      'border-color': '#8b909c',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : 76),
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.unhealthy',
    style: {
      'border-color': '#f85149',
    },
  },
  {
    selector: 'node.selected',
    style: {
      'border-color': '#4f8cff',
      'border-width': 4,
    },
  },
  {
    // Blast radius tint on selection - background only (border stays driven by health/selected
    // state above) so an unhealthy node inside the blast radius still reads as unhealthy first.
    selector: 'node.blast-upstream',
    style: {
      'background-color': '#a371f7',
      'background-opacity': 0.22,
    },
  },
  {
    selector: 'node.blast-downstream',
    style: {
      'background-color': '#f0883e',
      'background-opacity': 0.22,
    },
  },
  {
    selector: 'edge.edge-network',
    style: {
      'line-color': '#2b2f38',
      width: 2,
      'curve-style': 'bezier',
      'line-style': 'dashed',
      'target-arrow-shape': 'none',
    },
  },
  {
    selector: 'edge.edge-depends-on',
    style: {
      'line-color': '#199e70',
      width: 2,
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#199e70',
      label: 'data(label)',
      'font-size': 10,
      color: '#199e70',
      'text-background-color': '#14161a',
      'text-background-opacity': 1,
    },
  },
  {
    selector: 'edge.edge-manual',
    style: {
      'line-color': '#4f8cff',
      width: 2,
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#4f8cff',
      label: 'data(label)',
      'font-size': 10,
      color: '#4f8cff',
      'text-background-color': '#14161a',
      'text-background-opacity': 1,
    },
  },
  {
    selector: 'edge.blast-upstream',
    style: {
      'line-color': '#a371f7',
      'target-arrow-color': '#a371f7',
      width: 3,
    },
  },
  {
    selector: 'edge.blast-downstream',
    style: {
      'line-color': '#f0883e',
      'target-arrow-color': '#f0883e',
      width: 3,
    },
  },
  {
    // Kept last so it wins over the node/edge kind selectors above regardless of element type.
    selector: '.faded',
    style: {
      opacity: 0.15,
    },
  },
];

function clampPct(pct) {
  if (pct == null) return 0;
  return Math.max(0, Math.min(100, pct));
}

// Flips the compact rendering flag to match the current zoom - called on every 'viewport' event
// (not just the debounced save) so it feels like a direct consequence of zooming, not a delayed
// side effect. Mirrors the 'faded' pattern: cytoscape-node-html-label re-renders its overlay off
// node data(), so setting it here is what makes the template below pick compact vs full up.
function updateCompactFlag(cy) {
  const compact = cy.zoom() < COMPACT_ZOOM_THRESHOLD;
  cy.nodes('.running, .stopped, .cy-expand-collapse-collapsed-node').forEach((n) => {
    if (n.data('compact') !== compact) n.data('compact', compact);
  });
}

// Matches the CPU/mem color convention used everywhere else in the app (host tiles,
// list-view sparklines): CPU is always --accent, mem is always --seq-mem, regardless of
// value - magnitude is shown by bar length, not color, so the two bars stay identifiable
// at a glance instead of both turning the same red/amber/green as they fill up.
const CPU_COLOR = '#4f8cff';
const MEM_COLOR = '#199e70';

// Ranks worse-than semantics for a compose group's single "worst health" indicator when
// collapsed - unhealthy anywhere in the group outranks starting, which outranks a clean bill
// of health, so the collapsed box surfaces the thing you'd actually want to know about.
const HEALTH_RANK = { unhealthy: 3, starting: 2, healthy: 1 };

function aggregateGroups(nodes) {
  const byGroup = new Map();
  for (const n of nodes) {
    const agg = byGroup.get(n.group) || { count: 0, cpuSum: 0, memSum: 0, openAlerts: 0, health: null };
    agg.count += 1;
    agg.cpuSum += n.cpuPerc || 0;
    agg.memSum += n.memPerc || 0;
    agg.openAlerts += n.openAlerts || 0;
    if (n.health && (!agg.health || HEALTH_RANK[n.health] > HEALTH_RANK[agg.health])) agg.health = n.health;
    byGroup.set(n.group, agg);
  }
  return byGroup;
}

export function buildElements(nodes, edges, selectedId) {
  const groupIds = new Set(nodes.map((n) => n.group));
  const groupAggregates = aggregateGroups(nodes);
  return [
    ...[...groupIds].map((g) => {
      const agg = groupAggregates.get(g);
      return {
        data: {
          id: `grp:${g}`,
          label: g,
          count: agg.count,
          cpuAvg: agg.count ? agg.cpuSum / agg.count : 0,
          memAvg: agg.count ? agg.memSum / agg.count : 0,
          openAlerts: agg.openAlerts,
          health: agg.health,
        },
        classes: 'group',
      };
    }),
    ...nodes.map((n) => ({
      data: {
        id: n.id,
        parent: `grp:${n.group}`,
        name: n.name,
        emoji: stateEmoji(n.state),
        status: n.status || '',
        icon: iconFor(n.image, n.composeService),
        cpuPerc: n.cpuPerc,
        memPerc: n.memPerc,
        netIO: formatRatePair(n.netRxRate, n.netTxRate),
        blockIO: formatRatePair(n.blockReadRate, n.blockWriteRate),
        ports: parsePublishedPorts(n.ports),
        openAlerts: n.openAlerts || 0,
      },
      classes:
        (n.state === 'running' ? 'running' : 'stopped') +
        (n.health === 'unhealthy' ? ' unhealthy' : '') +
        (n.id === selectedId ? ' selected' : ''),
    })),
    ...edges.map((e) => ({
      data: {
        id: `edge:${e.kind || 'network'}:${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        kind: e.kind || 'network',
        label: e.label || '',
      },
      classes: e.kind === 'manual' ? 'edge-manual' : e.kind === 'depends_on' ? 'edge-depends-on' : 'edge-network',
    })),
  ];
}

const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 90 };
const GROUP_COLUMNS = 2;
const NODE_COL_GAP = 200;
const NODE_ROW_GAP = 96;

// Per-host node positions (from dragging) and camera (zoom/pan) - kept in localStorage so
// a manually-arranged layout survives both a page reload and the next poll cycle's
// structure-changed re-layout (a container starting/stopping elsewhere in the topology
// would otherwise wipe every dragged position, since dagre lays the whole graph out fresh).
const POSITIONS_KEY_PREFIX = 'odw:flow:positions:';
const VIEWPORT_KEY_PREFIX = 'odw:flow:viewport:';
const COLLAPSED_KEY_PREFIX = 'odw:flow:collapsed:';

function loadCollapsedGroups(hostId) {
  if (!hostId) return [];
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY_PREFIX + hostId)) || [];
  } catch {
    return [];
  }
}

function saveCollapsedGroups(hostId, ids) {
  if (!hostId) return;
  try {
    localStorage.setItem(COLLAPSED_KEY_PREFIX + hostId, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

function loadPositions(hostId) {
  if (!hostId) return {};
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY_PREFIX + hostId)) || {};
  } catch {
    return {};
  }
}

function saveNodePosition(hostId, nodeId, position) {
  if (!hostId) return;
  try {
    const positions = loadPositions(hostId);
    positions[nodeId] = position;
    localStorage.setItem(POSITIONS_KEY_PREFIX + hostId, JSON.stringify(positions));
  } catch {
    /* localStorage unavailable/full - dragging still works, it just won't persist */
  }
}

function applySavedPositions(cy, hostId) {
  const positions = loadPositions(hostId);
  for (const [id, pos] of Object.entries(positions)) {
    const node = cy.$id(id);
    if (node.length && !node.hasClass('group')) node.position(pos);
  }
}

function loadViewport(hostId) {
  if (!hostId) return null;
  try {
    return JSON.parse(localStorage.getItem(VIEWPORT_KEY_PREFIX + hostId));
  } catch {
    return null;
  }
}

function saveViewport(hostId, viewport) {
  if (!hostId) return;
  try {
    localStorage.setItem(VIEWPORT_KEY_PREFIX + hostId, JSON.stringify(viewport));
  } catch {
    /* ignore */
  }
}

const NODE_GAP = 16;
const NODE_WIDTH = 170;
const FULL_LEAF_HEIGHT = 76;
const FULL_GROUP_HEIGHT = 88;

// A leaf/collapsed-group node's *current* rendered box isn't safe to collide-check against on
// its own - semantic zoom shrinks it to COMPACT_HEIGHT while zoomed out, and two nodes that are
// just far enough apart while compact can end up overlapping once they grow back to full size on
// zoom-in. Always reserving full-size spacing here means compact is purely a shrink into room
// that was already there, never a size change that needs new room. A compound (expanded) group
// has no such fixed size to fall back on - its box is inherently the union of whatever its
// children currently render at, so that one's fine to read live.
function effectiveBoundingBox(node) {
  if (node.isParent()) return node.boundingBox();
  const pos = node.position();
  const h = node.hasClass('cy-expand-collapse-collapsed-node') ? FULL_GROUP_HEIGHT : FULL_LEAF_HEIGHT;
  return { x1: pos.x - NODE_WIDTH / 2, x2: pos.x + NODE_WIDTH / 2, y1: pos.y - h / 2, y2: pos.y + h / 2 };
}

// Blocks node boxes from being dragged on top of each other - with the html-label overlay
// carrying all the real content (name, icon, metric bars), an overlapping pair renders as
// unreadable stacked garbage rather than just a cosmetic overlap. Pushes `node` out along
// whichever axis needs the least movement to clear each obstacle. A node's own ancestors/
// descendants are excluded from the obstacle set - a leaf is always inside its parent group's
// bounding box by definition, and dragging a group carries its children along with it, so
// neither should register as a "collision" against the thing it's structurally part of.
function resolveNodeOverlap(node) {
  const cy = node.cy();
  const obstacles = cy.nodes('.running, .stopped, .group').not(node).not(node.ancestors()).not(node.descendants());
  obstacles.forEach((other) => {
    const a = effectiveBoundingBox(node);
    const b = effectiveBoundingBox(other);
    const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + NODE_GAP;
    const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + NODE_GAP;
    if (overlapX <= 0 || overlapY <= 0) return;
    const pos = node.position();
    if (overlapX < overlapY) {
      const dir = a.x1 + a.x2 <= b.x1 + b.x2 ? -1 : 1;
      node.position('x', pos.x + dir * overlapX);
    } else {
      const dir = a.y1 + a.y2 <= b.y1 + b.y2 ? -1 : 1;
      node.position('y', pos.y + dir * overlapY);
    }
  });
}

// One-off cleanup pass for positions that came from localStorage rather than a live drag (e.g.
// a position saved before this feature existed) - same collision resolver, just run once over
// everything instead of live during a drag gesture.
function resolveAllOverlaps(cy) {
  cy.nodes('.running, .stopped, .group').forEach((node) => resolveNodeOverlap(node));
}

// Compose groups with many members and no internal edges otherwise get laid out as one tall
// single-file column (dagre has nothing to rank sibling containers by). Re-flow those into a
// fixed-column grid after layout so tall groups stay compact. Groups that DO have internal edges
// (depends_on relationships) are left to dagre's own layout - it has real topology to route
// around now, and overriding its positions with a naive grid ignores that and produces edges that
// cut diagonally across unrelated node boxes.
function arrangeGroupsInColumns(cy) {
  cy.nodes('.group').forEach((group) => {
    const children = group.children();
    if (children.length <= GROUP_COLUMNS) return;
    const internalEdges = children.connectedEdges().filter((e) => children.contains(e.source()) && children.contains(e.target()));
    if (internalEdges.length > 0) return;
    const positions = children.map((c) => c.position());
    const avgX = positions.reduce((sum, p) => sum + p.x, 0) / positions.length;
    const avgY = positions.reduce((sum, p) => sum + p.y, 0) / positions.length;
    const rows = Math.ceil(children.length / GROUP_COLUMNS);
    children.forEach((child, i) => {
      const row = Math.floor(i / GROUP_COLUMNS);
      const col = i % GROUP_COLUMNS;
      child.position({
        x: avgX + (col - (GROUP_COLUMNS - 1) / 2) * NODE_COL_GAP,
        y: avgY + (row - (rows - 1) / 2) * NODE_ROW_GAP,
      });
    });
  });
}

// Runs a fresh dagre pass, then re-flows tall groups into columns, then re-applies any
// positions the user has dragged nodes to (dagre lays out the whole graph from scratch,
// so without this a container starting/stopping elsewhere would silently undo every drag).
// The camera is restored from the last saved zoom/pan instead of fitting whenever one
// exists - only a host with no saved viewport yet (or `fit: false`) gets auto-fit.
// layoutstop fires synchronously for a non-animated layout like this, so this stays
// synchronous end-to-end.
//
// Forces every node out of compact mode before dagre runs: a relayout triggered while zoomed
// out (a container starting/stopping, say) would otherwise have dagre space everything for the
// small compact boxes, and zooming back in later - nodes growing back to full size in place,
// with only compact-sized room reserved between them - is exactly how a container ends up
// visibly sitting on top of a neighboring group's box. compact is restored (via
// updateCompactFlag, reading the real current zoom) only after the final viewport/zoom for this
// pass is settled - not before, or it'd be judged against whatever zoom happened to be active
// before a fit-to-all changes it moments later.
function runLayout(cy, { fit, hostId }) {
  cy.nodes().data('compact', false);
  const layout = cy.layout({ ...LAYOUT, fit: false });
  layout.one('layoutstop', () => {
    arrangeGroupsInColumns(cy);
    applySavedPositions(cy, hostId);
    resolveAllOverlaps(cy);
    const savedViewport = loadViewport(hostId);
    if (savedViewport) {
      cy.viewport(savedViewport);
    } else if (fit) {
      cy.fit(undefined, 30);
    }
    updateCompactFlag(cy);
  });
  layout.run();
}

// Updates an existing cytoscape instance in place instead of recreating it, so pan/zoom set by
// the user survives the next poll's refresh. Layout only re-runs when the set of nodes/edges
// actually changed, in which case runLayout re-applies any saved (dragged) positions and
// restores the saved camera - or fits, only if there's no saved camera yet for this host.
// Pure data/class updates (status text, selection) never touch the viewport at all.
export function updateGraph(cy, elements, hostId) {
  cy.scratch('_odw_latestElements', elements);

  // cytoscape-expand-collapse physically removes a collapsed group's children from the graph
  // (stashing them internally to restore on expand) - this diff must never try to add them back
  // in, or it'd corrupt the plugin's bookkeeping and silently un-collapse the group. An earlier
  // version briefly expanded/re-collapsed every poll to keep their data fresh, but that visibly
  // flickered the collapsed box (and, with node-html-label's own async DOM sync, the metric
  // values inside it) every 5s. Simpler and flicker-free: just skip them entirely while hidden -
  // expandcollapse.afterexpand re-syncs their data from the cache above the moment the group is
  // actually opened, so nothing gets rendered - or re-rendered - while nobody's looking at it.
  const collapsedIds = new Set(cy.nodes('.cy-expand-collapse-collapsed-node').map((n) => n.id()));
  const hiddenIds = new Set();
  if (collapsedIds.size) {
    // Children first, so the edge pass below can see them: an edge between two children of the
    // same collapsed group is just as hidden as the children themselves (both endpoints gone).
    for (const el of elements) {
      if (collapsedIds.has(el.data.parent)) hiddenIds.add(el.data.id);
    }
    for (const el of elements) {
      if (el.data.source && (hiddenIds.has(el.data.source) || hiddenIds.has(el.data.target))) {
        hiddenIds.add(el.data.id);
      }
    }
  }

  const newIds = new Set(elements.map((el) => el.data.id));
  let structureChanged = false;

  cy.elements().forEach((ele) => {
    if (!newIds.has(ele.id())) {
      ele.remove();
      structureChanged = true;
    }
  });

  for (const el of elements) {
    if (hiddenIds.has(el.data.id)) continue;
    const existing = cy.getElementById(el.data.id);
    if (existing && existing.length) {
      existing.data(el.data);
      // buildElements has no notion of collapse state, so el.classes for a collapsed group is
      // always just 'group' - applying that as-is would strip the plugin's own
      // cy-expand-collapse-collapsed-node marker class every poll and desync its bookkeeping
      // from what's actually rendered (the group silently pops back open on the next poll).
      const classes = collapsedIds.has(el.data.id) ? `${el.classes || ''} cy-expand-collapse-collapsed-node` : el.classes || '';
      existing.classes(classes);
    } else {
      cy.add(el);
      structureChanged = true;
    }
  }

  if (structureChanged) {
    runLayout(cy, { fit: true, hostId });
  }

  // .data(el.data) above merges rather than replaces, so an existing node's compact flag
  // survives a poll refresh untouched - but a node that's brand new this poll (or one just
  // revealed by expanding a group) starts with no compact flag at all, which would render it
  // in full mode regardless of the current zoom until the next actual zoom/pan.
  updateCompactFlag(cy);
}

// Walks depends_on edges transitively from the selected node in one direction. 'target' follows
// edges forward (source -> target, i.e. "what this node depends on" - the chain it needs healthy
// to function itself). 'source' follows them backward (i.e. everything that depends on this
// node, directly or transitively - what breaks if it does). Returns both the reached node ids
// and the specific edges used to reach them, so only the actual dependency path gets tinted -
// not every edge that happens to connect two nodes that both end up somewhere in the set.
function traverseDependsOn(cy, startId, followField) {
  const fromField = followField === 'target' ? 'source' : 'target';
  const edges = cy.edges('.edge-depends-on');
  const nodeIds = new Set();
  const edgeIds = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    edges.forEach((edge) => {
      if (edge.data(fromField) !== id) return;
      const nextId = edge.data(followField);
      edgeIds.add(edge.id());
      if (nextId !== startId && !nodeIds.has(nextId)) {
        nodeIds.add(nextId);
        queue.push(nextId);
      }
    });
  }
  return { nodeIds, edgeIds };
}

// Dims everything outside the given selection/filter so the surrounding topology is easier to
// read. filterText (if non-empty) takes priority over selectedId - typing a filter and having a
// node selected at the same time would otherwise fight over what "faded" means. Group boxes are
// never faded so the project outline stays legible either way.
export function applyFading(cy, { selectedId, filterText } = {}) {
  if (!cy) return;
  cy.elements().removeClass('faded blast-upstream blast-downstream');

  const text = (filterText || '').trim().toLowerCase();
  if (text) {
    const matching = cy.nodes().filter((n) => !n.hasClass('group') && (n.data('name') || '').toLowerCase().includes(text));
    if (matching.length) {
      cy.nodes().not('.group').not(matching).addClass('faded');
      cy.edges().forEach((e) => {
        if (!matching.contains(e.source()) && !matching.contains(e.target())) e.addClass('faded');
      });
    }
  } else if (selectedId) {
    const node = cy.$id(selectedId);
    if (node.length) {
      // "What breaks if this dies" (downstream: everything that transitively depends on it) and
      // "what it needs to be healthy" (upstream: everything it transitively depends on) is the
      // actual operational question the topology exists to answer - not just "what's nearby."
      const upstream = traverseDependsOn(cy, selectedId, 'target');
      const downstream = traverseDependsOn(cy, selectedId, 'source');
      upstream.nodeIds.forEach((id) => cy.$id(id).addClass('blast-upstream'));
      downstream.nodeIds.forEach((id) => cy.$id(id).addClass('blast-downstream'));
      upstream.edgeIds.forEach((id) => cy.$id(id).addClass('blast-upstream'));
      downstream.edgeIds.forEach((id) => cy.$id(id).addClass('blast-downstream'));

      const transitive = [...upstream.nodeIds, ...downstream.nodeIds].reduce((coll, id) => coll.union(cy.$id(id)), cy.collection());
      const keep = node.closedNeighborhood().union(transitive);
      cy.nodes().not(keep).not('.group').addClass('faded');
      cy.edges().forEach((e) => {
        if (e.hasClass('blast-upstream') || e.hasClass('blast-downstream')) return;
        if (!keep.contains(e.source()) || !keep.contains(e.target())) e.addClass('faded');
      });
    }
  }

  // cytoscape-node-html-label renders its overlay from node data(), not from cytoscape's own
  // style/class system, so the .faded class above never reaches the HTML label (name, icon,
  // badges) on its own - only the canvas-drawn border and edges pick it up. Mirror it into data
  // so the template (below) can fade the overlay to match.
  cy.nodes().forEach((n) => {
    const faded = n.hasClass('faded');
    if (n.data('faded') !== faded) n.data('faded', faded);
  });
}

// cy.png() only rasterizes cytoscape's own <canvas> layer - it has no way to see the
// node-html-label plugin's DOM overlay, which is what actually renders everything inside
// a node box (name, icon, CPU/RAM bars, badges). html2canvas screenshots the real on-screen
// DOM instead, canvas included, so the export matches what's actually visible.
export async function exportPng(cy) {
  if (!cy || typeof html2canvas !== 'function') return;
  const container = cy.container();

  // html2canvas captures whatever's currently in view, unlike the old cy.png({ full: true })
  // which always exported the whole graph regardless of zoom/pan. Fit-to-all before
  // capturing to keep that behavior, then restore exactly what the user had - the
  // html-label overlay's own reflow needs a frame to catch up with the new positions.
  const savedViewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  cy.fit(undefined, 30);
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const canvas = await html2canvas(container, { backgroundColor: '#14161a', scale: 2 });
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `opendockwatch-flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    cy.viewport(savedViewport);
  }
}

export function createGraph(container, elements, onNodeTap, onEdgeTap, hostId) {
  const cy = cytoscape({
    container,
    elements,
    style: CY_STYLE,
  });
  cy.scratch('_odw_latestElements', elements);
  runLayout(cy, { fit: true, hostId });
  // runLayout's fit/viewport-restore happens synchronously above, before the 'viewport'
  // listener further down even exists yet - set the initial compact state explicitly rather
  // than relying on that first fit to have been caught by a listener that isn't registered yet.
  updateCompactFlag(cy);

  if (!expandCollapseRegistered && typeof cytoscapeExpandCollapse !== 'undefined') {
    cytoscape.use(cytoscapeExpandCollapse);
    expandCollapseRegistered = true;
  }
  if (typeof cy.expandCollapse === 'function') {
    // fisheye off: it distorts sibling node positions during the collapse/expand animation,
    // which fights with the dragged/saved positions this view otherwise goes out of its way to
    // preserve. undoable off: skips requiring the separate undo-redo extension this app doesn't
    // vendor. cueEnabled draws the click-to-toggle +/- affordance directly on each group box -
    // that's the only interaction needed; no extra button click is required for the common case.
    const expandCollapseApi = cy.expandCollapse({
      layoutBy: null,
      fisheye: false,
      animate: true,
      undoable: false,
      cueEnabled: true,
    });
    cy.scratch('_odw_expandCollapseApi', expandCollapseApi);

    const savedCollapsed = loadCollapsedGroups(hostId);
    if (savedCollapsed.length) {
      const toCollapse = savedCollapsed.reduce((coll, id) => coll.union(cy.$id(id)), cy.collection());
      if (toCollapse.length) expandCollapseApi.collapse(toCollapse, { animate: false, layoutBy: null });
    }

    // updateGraph deliberately never touches a collapsed group's hidden children (see there for
    // why), so their data can go stale across however many polls it stays collapsed for. Catch
    // up the moment it's actually opened, from whatever the most recent poll's elements were.
    cy.on('expandcollapse.afterexpand', (evt) => {
      const latest = cy.scratch('_odw_latestElements') || [];
      const byId = new Map(latest.map((el) => [el.data.id, el]));
      evt.target.descendants().forEach((child) => {
        const el = byId.get(child.id());
        if (el) {
          child.data(el.data);
          child.classes(el.classes || '');
        }
      });
      // Newly-revealed children have no compact flag of their own yet - set it to match
      // whatever the current zoom already says the rest of the graph should look like.
      updateCompactFlag(cy);

      // A collapsed group is a small box, easy to drag right up against a neighbor without
      // tripping the drag-time overlap check (that only guards individual node drops, not the
      // much bigger box a group turns back into on expand). Push the whole just-reopened group
      // - as a unit, so its own internal layout stays intact - clear of whatever it now overlaps.
      resolveNodeOverlap(evt.target);
    });

    cy.on('expandcollapse.aftercollapse expandcollapse.afterexpand', () => {
      saveCollapsedGroups(
        hostId,
        cy.nodes('.cy-expand-collapse-collapsed-node').map((n) => n.id())
      );
    });
  }

  // Resolved on drop rather than continuously during 'drag': collision-checking every
  // intermediate mouse position would block the node against anything its path happened to
  // cross, even when the actual drop target is clear - it'd feel like getting stuck on
  // furniture instead of just not being able to overlap once released.
  cy.on('dragfree', 'node', (evt) => {
    const node = evt.target;
    resolveNodeOverlap(node);
    if (!node.hasClass('group')) saveNodePosition(hostId, node.id(), node.position());
  });

  let viewportSaveTimer = null;
  cy.on('viewport', () => {
    updateCompactFlag(cy);
    clearTimeout(viewportSaveTimer);
    viewportSaveTimer = setTimeout(() => {
      saveViewport(hostId, { zoom: cy.zoom(), pan: cy.pan() });
    }, 300);
  });

  cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    if (!id.startsWith('grp:')) onNodeTap(id);
  });

  cy.on('tap', 'edge', (evt) => {
    if (onEdgeTap) onEdgeTap(evt.target.data());
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy && onEdgeTap) onEdgeTap(null);
  });

  if (!htmlLabelRegistered && typeof cytoscapeNodeHtmlLabel !== 'undefined') {
    cytoscape.use(cytoscapeNodeHtmlLabel);
    htmlLabelRegistered = true;
  }
  if (typeof cy.nodeHtmlLabel === 'function') {
    cy.nodeHtmlLabel([
      {
        query: 'node.running, node.stopped',
        halign: 'center',
        valign: 'center',
        halignBox: 'center',
        valignBox: 'center',
        tpl: (data) =>
          data.compact
            ? `
          <div class="cy-node-box cy-node-box-compact${data.faded ? ' faded' : ''}">
            <span class="cy-node-emoji">${data.emoji}</span>
            <span class="cy-node-icon" style="background:${data.icon.bg}">${data.icon.text}</span>
            <span class="cy-node-name">${data.name}</span>
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `
            : `
          <div class="cy-node-box${data.faded ? ' faded' : ''}">
            <span class="cy-node-emoji">${data.emoji}</span>
            <span class="cy-node-status">${data.status}</span>
            <span class="cy-node-icon" style="background:${data.icon.bg}">${data.icon.text}</span>
            <span class="cy-node-name">${data.name}</span>
            <div class="cy-node-metrics">
              <div class="cy-node-metric-row">
                <span class="cy-node-metric-label">CPU</span>
                <span class="cy-node-track"><span class="cy-node-bar-fill" style="width:${clampPct(data.cpuPerc)}%;background:${CPU_COLOR}"></span></span>
              </div>
              <div class="cy-node-metric-row">
                <span class="cy-node-metric-label">RAM</span>
                <span class="cy-node-track"><span class="cy-node-bar-fill" style="width:${clampPct(data.memPerc)}%;background:${MEM_COLOR}"></span></span>
              </div>
              <div class="cy-node-metric-row">
                <span class="cy-node-metric-label">NET</span>
                <span class="cy-node-metric-value">${data.netIO}</span>
                <span class="cy-node-metric-label">DISK</span>
                <span class="cy-node-metric-value">${data.blockIO}</span>
              </div>
            </div>
            ${data.ports ? `<span class="cy-node-port-badge">${data.ports}</span>` : ''}
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `,
      },
      {
        query: 'node.cy-expand-collapse-collapsed-node',
        halign: 'center',
        valign: 'center',
        halignBox: 'center',
        valignBox: 'center',
        tpl: (data) =>
          data.compact
            ? `
          <div class="cy-node-box cy-node-group-box cy-node-box-compact${data.faded ? ' faded' : ''}">
            ${data.health ? `<span class="cy-node-group-health" style="background:${healthColor(data.health)}"></span>` : ''}
            <span class="cy-node-name">${data.label}</span>
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `
            : `
          <div class="cy-node-box cy-node-group-box${data.faded ? ' faded' : ''}">
            ${data.health ? `<span class="cy-node-group-health" style="background:${healthColor(data.health)}"></span>` : ''}
            <span class="cy-node-name">${data.label}</span>
            <span class="cy-node-group-count">${data.count} container${data.count === 1 ? '' : 's'}</span>
            <div class="cy-node-metrics">
              <div class="cy-node-metric-row">
                <span class="cy-node-metric-label">CPU</span>
                <span class="cy-node-track"><span class="cy-node-bar-fill" style="width:${clampPct(data.cpuAvg)}%;background:${CPU_COLOR}"></span></span>
              </div>
              <div class="cy-node-metric-row">
                <span class="cy-node-metric-label">RAM</span>
                <span class="cy-node-track"><span class="cy-node-bar-fill" style="width:${clampPct(data.memAvg)}%;background:${MEM_COLOR}"></span></span>
              </div>
            </div>
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `,
      },
    ]);
  }

  return cy;
}

// For the toolbar's "Collapse all" / "Expand all" convenience buttons - the per-group +/- cue
// (cueEnabled above) is fine one at a time, but not at the "40 containers on one host" scale
// this feature exists for.
export function collapseAllGroups(cy) {
  const api = cy && cy.scratch('_odw_expandCollapseApi');
  if (api) api.collapseAll();
}

export function expandAllGroups(cy) {
  const api = cy && cy.scratch('_odw_expandCollapseApi');
  if (api) api.expandAll();
}
