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
      height: 46,
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
      height: 46,
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

function bandColor(pct) {
  if (pct == null) return 'transparent';
  if (pct >= 90) return '#f85149';
  if (pct >= 70) return '#d29922';
  return '#3fb950';
}

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
const NODE_ROW_GAP = 66;

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

// Runs a fresh dagre pass, then re-flows tall groups into columns, then (optionally) refits the
// viewport to the result. layoutstop fires synchronously for a non-animated layout like this, so
// this stays synchronous end-to-end.
function runLayout(cy, { fit }) {
  const layout = cy.layout({ ...LAYOUT, fit: false });
  layout.one('layoutstop', () => {
    arrangeGroupsInColumns(cy);
    if (fit) cy.fit(undefined, 30);
  });
  layout.run();
}

// Updates an existing cytoscape instance in place instead of recreating it, so pan/zoom set by
// the user survives the next poll's refresh. Layout only re-runs when the set of nodes/edges
// actually changed, in which case the viewport is refit/recentered on the new layout (positions
// shift when nodes are added/removed, so keeping the old pan/zoom would leave the view pointed
// at empty space). Pure data/class updates (status text, selection) never touch the viewport.
export function updateGraph(cy, elements) {
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
    runLayout(cy, { fit: true });
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

export function exportPng(cy) {
  if (!cy) return;
  const dataUrl = cy.png({ full: true, scale: 2, bg: '#14161a' });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `opendockwatch-flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function createGraph(container, elements, onNodeTap, onEdgeTap) {
  const cy = cytoscape({
    container,
    elements,
    style: CY_STYLE,
  });
  runLayout(cy, { fit: true });

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
            <span class="cy-node-cpu-track"><span class="cy-node-bar-fill" style="width:${clampPct(data.cpuPerc)}%;background:${bandColor(data.cpuPerc)}"></span></span>
            <span class="cy-node-mem-track"><span class="cy-node-bar-fill" style="width:${clampPct(data.memPerc)}%;background:${bandColor(data.memPerc)}"></span></span>
            <span class="cy-node-emoji">${data.emoji}</span>
            <span class="cy-node-status">${data.status}</span>
            <span class="cy-node-icon" style="background:${data.icon.bg}">${data.icon.text}</span>
            <span class="cy-node-name">${data.name}</span>
            ${data.ports ? `<span class="cy-node-port-badge">${data.ports}</span>` : ''}
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `,
      },
    ]);
  }

  return cy;
}
