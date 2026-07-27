import { NODE_WIDTH, FULL_GROUP_HEIGHT, containerFullHeight } from './elements.js';
import { applySavedPositions, loadViewport, clearPositions, clearViewport } from './persistence.js';
import { COMPACT_ZOOM_THRESHOLD } from './style.js';

const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 90 };
// Tree mode's mount pills can grow several lines tall (wrapped bind-mount paths) - graph mode's
// nodeSep is tuned for its fixed-height container/group boxes and packs siblings too tightly once
// pill heights vary. Extra room here also gives taxi-routed edges (edge-tree-proj/-mount) more
// space to turn cleanly instead of elbowing through a tightly-packed neighbor.
// Mount/network pills have no edges except the one from their container, so dagre's automatic
// ranking would otherwise put shared mounts, unshared mounts, and networks all in the same
// column right after it (nothing forces them apart). cytoscape-dagre's minLen hook stretches
// an edge's minimum rank distance per-edge, which is what actually produces the desired
// left-to-right order: container -> shared mounts -> unshared mounts -> networks.
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

// A leaf/collapsed-group node's *current* rendered box isn't safe to collide-check against on
// its own - semantic zoom shrinks it to COMPACT_HEIGHT while zoomed out, and two nodes that are
// just far enough apart while compact can end up overlapping once they grow back to full size on
// zoom-in. Always reserving full-size spacing here means compact is purely a shrink into room
// that was already there, never a size change that needs new room. A compound (expanded) group
// has no such fixed size to fall back on - its box is inherently the union of whatever its
// children currently render at, so that one's fine to read live. Tree mode's pills aren't
// touched by semantic zoom at all, so their current width/height already is their real size.
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

// Blocks node boxes from being dragged on top of each other - with the html-label overlay
// carrying all the real content (name, icon, metric bars), an overlapping pair renders as
// unreadable stacked garbage rather than just a cosmetic overlap. Pushes `node` out along
// whichever axis needs the least movement to clear each obstacle. A node's own ancestors/
// descendants are excluded from the obstacle set - a leaf is always inside its parent group's
// bounding box by definition, and dragging a group carries its children along with it, so
// neither should register as a "collision" against the thing it's structurally part of.
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

// Flips the compact rendering flag to match the current zoom - called on every 'viewport' event
// (not just the debounced save) so it feels like a direct consequence of zooming, not a delayed
// side effect. Mirrors the 'faded' pattern: cytoscape-node-html-label re-renders its overlay off
// node data(), so setting it here is what makes the template below pick compact vs full up.
export function updateCompactFlag(cy) {
  const compact = cy.zoom() < COMPACT_ZOOM_THRESHOLD;
  const changed = cy.nodes('.running, .stopped, .cy-expand-collapse-collapsed-node').filter((n) => n.data('compact') !== compact);
  if (!changed.length) return;
  changed.data('compact', compact);
  // Height here comes from a compact-dependent style mapper, not a position change - cytoscape
  // only wires its compound bounding-box cache invalidation up to the position setter, so a
  // compose group's rendered outline is left sized to the stale (compact) bounds once its
  // children grow back to full size on zoom-in, until something else (e.g. selecting a node)
  // happens to force a recompute. Without this, children can render outside their own group box.
  changed.dirtyCompoundBoundsCache();
  // dirtyCompoundBoundsCache only covers compound (parent) bounding boxes - it does nothing for
  // a plain leaf node's own rendered box, which is exactly what every tree-mode container is (no
  // compound groups there). Without an explicit style recompute, an edge routed to/from a node
  // whose height just changed can keep using its previous box to route against, silently
  // rendering a zero/near-zero-length (so invisible) segment until *something else* forces a
  // recompute - reproduced by zooming across the compact threshold and back. cy.style().update()
  // is cytoscape's own documented way to force every function-valued style (like this height
  // mapper) to be recomputed and repainted.
  cy.style().update();
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

// "Reset view" - clears any dragged positions and saved camera for the current mode+host, then
// reruns dagre fresh and fits. Fit (the toolbar's other button) only moves the camera over the
// existing arrangement; this also undoes manual dragging, for when a layout's been dragged into
// a tangle and starting over is easier than untangling it by hand.
export function resetView(cy, hostId) {
  if (!cy) return;
  const mode = cy.scratch('_odw_mode') || 'graph';
  clearPositions(hostId, mode);
  clearViewport(hostId, mode);
  runLayout(cy, { fit: true, hostId });
}
