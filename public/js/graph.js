import { stateEmoji, iconFor, parsePublishedPorts } from './format.js';

let htmlLabelRegistered = false;

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
    selector: 'node.running',
    style: {
      'background-color': '#1d2027',
      'border-width': 2,
      'border-color': '#3fb950',
      width: 170,
      height: 76,
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
      height: 76,
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

// Matches the CPU/mem color convention used everywhere else in the app (host tiles,
// list-view sparklines): CPU is always --accent, mem is always --seq-mem, regardless of
// value - magnitude is shown by bar length, not color, so the two bars stay identifiable
// at a glance instead of both turning the same red/amber/green as they fill up.
const CPU_COLOR = '#4f8cff';
const MEM_COLOR = '#199e70';

export function buildElements(nodes, edges, selectedId) {
  const groupIds = new Set(nodes.map((n) => n.group));
  return [
    ...[...groupIds].map((g) => ({ data: { id: `grp:${g}`, label: g }, classes: 'group' })),
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
        netIO: n.netIO || '—',
        blockIO: n.blockIO || '—',
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
function runLayout(cy, { fit, hostId }) {
  const layout = cy.layout({ ...LAYOUT, fit: false });
  layout.one('layoutstop', () => {
    arrangeGroupsInColumns(cy);
    applySavedPositions(cy, hostId);
    const savedViewport = loadViewport(hostId);
    if (savedViewport) {
      cy.viewport(savedViewport);
    } else if (fit) {
      cy.fit(undefined, 30);
    }
  });
  layout.run();
}

// Updates an existing cytoscape instance in place instead of recreating it, so pan/zoom set by
// the user survives the next poll's refresh. Layout only re-runs when the set of nodes/edges
// actually changed, in which case runLayout re-applies any saved (dragged) positions and
// restores the saved camera - or fits, only if there's no saved camera yet for this host.
// Pure data/class updates (status text, selection) never touch the viewport at all.
export function updateGraph(cy, elements, hostId) {
  const newIds = new Set(elements.map((el) => el.data.id));
  let structureChanged = false;

  cy.elements().forEach((ele) => {
    if (!newIds.has(ele.id())) {
      ele.remove();
      structureChanged = true;
    }
  });

  for (const el of elements) {
    const existing = cy.getElementById(el.data.id);
    if (existing && existing.length) {
      existing.data(el.data);
      existing.classes(el.classes || '');
    } else {
      cy.add(el);
      structureChanged = true;
    }
  }

  if (structureChanged) {
    runLayout(cy, { fit: true, hostId });
  }
}

// Dims everything outside the given selection/filter so the surrounding topology is easier to
// read. filterText (if non-empty) takes priority over selectedId - typing a filter and having a
// node selected at the same time would otherwise fight over what "faded" means. Group boxes are
// never faded so the project outline stays legible either way.
export function applyFading(cy, { selectedId, filterText } = {}) {
  if (!cy) return;
  cy.elements().removeClass('faded');

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
      const keep = node.closedNeighborhood();
      cy.elements().not(keep).not('.group').addClass('faded');
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
  runLayout(cy, { fit: true, hostId });

  cy.on('dragfree', 'node', (evt) => {
    const node = evt.target;
    if (!node.hasClass('group')) saveNodePosition(hostId, node.id(), node.position());
  });

  let viewportSaveTimer = null;
  cy.on('viewport', () => {
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
        tpl: (data) => `
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
    ]);
  }

  return cy;
}
