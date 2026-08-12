import { NODE_WIDTH, FULL_GROUP_HEIGHT, containerFullHeight } from './elements.js';
import { applySavedPositions, loadViewport, clearPositions, clearViewport } from './persistence.js';
import { COMPACT_ZOOM_THRESHOLD } from './style.js';

const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 90 };
// Tree mode's taller mount pills need more nodeSep than graph mode's fixed-height boxes.
// treeMinLen forces left-to-right order (container -> shared mounts -> unshared -> networks)
// since those pills have no edges of their own for dagre to rank by otherwise.
function treeMinLen(edge) {
  if (edge.hasClass('edge-tree-mount')) return edge.target().data('shared') ? 1 : 2;
  if (edge.hasClass('edge-tree-net')) return 3;
  return 1;
}
const TREE_LAYOUT = { ...LAYOUT, nodeSep: 70, minLen: treeMinLen };
const GROUP_COLUMNS = 2;
const NODE_COL_GAP = 200;
const NODE_ROW_GAP = 96;

const NODE_GAP = 16;

// Nodes that participate in drag/layout overlap resolution: container leaves and compose groups
// (graph mode), plus tree mode's project/network/mount pills. One shared selector so the
// obstacle set (resolveNodeOverlap) and the full sweep (resolveAllOverlaps) can't drift apart.
const OVERLAP_NODE_SELECTOR = '.running, .stopped, .group, .proj, .net, .mount';

// A leaf/collapsed-group node's *current* rendered box isn't safe to collide-check against -
// semantic zoom shrinks it while zoomed out, so nodes just far enough apart while compact can
// overlap once full-size again. Reserves full-size spacing always; expanded groups/pills read live.
function effectiveBoundingBox(node) {
  if (node.isParent()) return node.boundingBox();
  const pos = node.position();
  if (node.hasClass('proj') || node.hasClass('net') || node.hasClass('mount')) {
    const w = node.width();
    const h = node.height();
    return { x1: pos.x - w / 2, x2: pos.x + w / 2, y1: pos.y - h / 2, y2: pos.y + h / 2 };
  }
  const h = node.hasClass('cy-expand-collapse-collapsed-node') ? FULL_GROUP_HEIGHT : containerFullHeight(node.data('portLines'));
  return { x1: pos.x - NODE_WIDTH / 2, x2: pos.x + NODE_WIDTH / 2, y1: pos.y - h / 2, y2: pos.y + h / 2 };
}

// Blocks node boxes from being dragged on top of each other - the html-label overlay carries
// all real content, so an overlap renders as unreadable stacked garbage. Pushes `node` out along
// whichever axis needs least movement. Ancestors/descendants excluded: they're structurally part of it, not a collision.
export function resolveNodeOverlap(node) {
  const cy = node.cy();
  const obstacles = cy.nodes(OVERLAP_NODE_SELECTOR).not(node).not(node.ancestors()).not(node.descendants());
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
  cy.nodes(OVERLAP_NODE_SELECTOR).forEach((node) => resolveNodeOverlap(node));
}

// Compose groups with many members and no internal edges lay out as one tall single-file column
// (dagre has nothing to rank siblings by) - re-flowed into a fixed-column grid after layout.
// Groups WITH internal depends_on edges are left to dagre, which has real topology to route around.
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

// Flips the compact rendering flag to match the current zoom - called on every 'viewport' event
// (not the debounced save) so it feels like a direct consequence, not a delayed side effect.
// Mirrors 'faded': node-html-label re-renders off node data(), so this drives compact vs full.
export function updateCompactFlag(cy) {
  const compact = cy.zoom() < COMPACT_ZOOM_THRESHOLD;
  const changed = cy.nodes('.running, .stopped, .cy-expand-collapse-collapsed-node').filter((n) => n.data('compact') !== compact);
  if (!changed.length) return;
  changed.data('compact', compact);
  // Height comes from a compact-dependent style mapper, not a position change - cytoscape only
  // wires bounding-box cache invalidation to the position setter, so a group's outline stays
  // sized to stale compact bounds after children grow back, until something forces a recompute.
  changed.dirtyCompoundBoundsCache();
  // dirtyCompoundBoundsCache only covers compound (parent) boxes, not a plain leaf's own box -
  // every tree-mode container. Without a style recompute, an edge to a just-resized node can
  // route against its stale box, rendering invisible until something else forces a recompute.
  cy.style().update();
}

// Runs a fresh dagre pass, re-flows tall groups, re-applies dragged positions (dagre resets
// everything each time) and restores the saved camera, or fits with none saved. Forces nodes out
// of compact mode first so a relayout while zoomed out doesn't reserve only compact-sized room.
export function runLayout(cy, { fit, hostId }) {
  const mode = cy.scratch('_odw_mode') || 'graph';
  cy.nodes().data('compact', false);
  const layout = cy.layout({ ...(mode === 'tree' ? TREE_LAYOUT : LAYOUT), fit: false });
  layout.one('layoutstop', () => {
    arrangeGroupsInColumns(cy);
    applySavedPositions(cy, hostId, mode);
    resolveAllOverlaps(cy);
    const savedViewport = loadViewport(hostId, mode);
    if (savedViewport) {
      cy.viewport(savedViewport);
    } else if (fit) {
      cy.fit(undefined, 30);
    }
    updateCompactFlag(cy);
  });
  layout.run();
}

// "Reset view" - clears dragged positions and saved camera for the current mode+host, then
// reruns dagre and fits. Fit (the toolbar's other button) only moves the camera over the existing
// arrangement; this also undoes manual dragging, for when a layout's tangled beyond untangling by hand.
export function resetView(cy, hostId) {
  if (!cy) return;
  const mode = cy.scratch('_odw_mode') || 'graph';
  clearPositions(hostId, mode);
  clearViewport(hostId, mode);
  runLayout(cy, { fit: true, hostId });
}
