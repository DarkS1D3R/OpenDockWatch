import { stateEmoji, iconFor } from './format.js';

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
];

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
        label: e.label || '',
      },
      classes: e.kind === 'manual' ? 'edge-manual' : 'edge-network',
    })),
  ];
}

const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 90 };
const GROUP_COLUMNS = 2;
const NODE_COL_GAP = 200;
const NODE_ROW_GAP = 66;

// Compose groups with many members otherwise get laid out as one tall single-file column
// (dagre has nothing to rank sibling containers by when there's no edge between them). Re-flow
// each group's children into a fixed-column grid after layout so tall groups stay compact.
function arrangeGroupsInColumns(cy) {
  cy.nodes('.group').forEach((group) => {
    const children = group.children();
    if (children.length <= GROUP_COLUMNS) return;
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

export function createGraph(container, elements, onNodeTap) {
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
          <div class="cy-node-box">
            <span class="cy-node-emoji">${data.emoji}</span>
            <span class="cy-node-status">${data.status}</span>
            <span class="cy-node-icon" style="background:${data.icon.bg}">${data.icon.text}</span>
            <span class="cy-node-name">${data.name}</span>
          </div>
        `,
      },
    ]);
  }

  return cy;
}
