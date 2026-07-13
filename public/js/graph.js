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
    // Tree mode only - project/network/mount pills are plain (non-compound) nodes, so unlike
    // node.group they get a fixed size and centered label rather than padding around children.
    // A darker blue than node.net's border (rather than the muted gray node.stopped also uses)
    // - a project box next to a stopped container otherwise reads as two of the same "state,"
    // when a project is a grouping, not a state at all.
    selector: 'node.proj',
    style: {
      'background-color': '#1d2027',
      'border-width': 1,
      'border-color': '#2d5fa8',
      label: 'data(label)',
      'font-size': 11,
      color: '#e4e6eb',
      'text-valign': 'center',
      'text-halign': 'center',
      width: 140,
      height: 30,
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.net',
    style: {
      'background-color': '#182234',
      'border-width': 1,
      'border-color': '#4f8cff',
      label: 'data(label)',
      'font-size': 10,
      color: '#4f8cff',
      'text-valign': 'center',
      'text-halign': 'center',
      width: 120,
      height: 26,
      shape: 'round-rectangle',
    },
  },
  {
    // Bind-mount source paths can be much longer than a network/project name (e.g. a full
    // /mnt/... path) - a fixed width with text-wrap forces long paths onto multiple lines
    // instead of overflowing a single-line pill; height: 'label' then grows the box to fit
    // however many wrapped lines that took (short volume names still fit on one line).
    selector: 'node.mount',
    style: {
      'background-color': '#241d14',
      'border-width': 1,
      'border-color': '#d29922',
      label: 'data(label)',
      'font-size': 10,
      color: '#d29922',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 150,
      width: 170,
      height: 'label',
      padding: '8px',
      shape: 'round-rectangle',
    },
  },
  {
    // Orthogonal "taxi" routing (horizontal-vertical-horizontal), matching ArgoCD's own resource
    // tree connectors - reads more like a hierarchy diagram than the diagonal bezier edges graph
    // mode uses for network/depends-on/manual relationships. No arrowhead, same reason ArgoCD's
    // doesn't have one: left-to-right position already conveys direction in a tree. Split into
    // three kind-specific styles (rather than one shared edge-tree class) so a network pill's
    // dashed blue lines and a mount pill's solid amber lines don't blend together once several
    // containers converge on shared pills - the whole point of deduping them in the first place.
    selector: 'edge.edge-tree-proj',
    style: {
      'line-color': '#3a3f4b',
      width: 1.5,
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'taxi-turn': '50%',
      'taxi-turn-min-distance': 10,
      'target-arrow-shape': 'none',
    },
  },
  {
    // Straight rather than taxi routing - a network pill is often shared by many containers at
    // different heights, and orthogonal elbows from all of them tend to run along the same
    // horizontal bands and overlap each other. A direct line fans out at a distinct angle per
    // source, which stays readable at higher fan-in than the elbow style does.
    selector: 'edge.edge-tree-net',
    style: {
      'line-color': '#4f8cff',
      width: 1.5,
      'line-style': 'dashed',
      'curve-style': 'straight',
      'target-arrow-shape': 'none',
    },
  },
  {
    // Back to taxi (orthogonal), matching edge-tree-proj's ArgoCD-style look. The invisible-line
    // bug this was briefly switched to 'straight' for turned out to be a stale-render issue (see
    // updateCompactFlag's cy.style().update() call) rather than a taxi-geometry problem - fixed
    // at the source now, so mounts get the elbow routing back. TREE_LAYOUT's extra nodeSep gives
    // the turn points more room, as a further safety margin against tight-quarters overlap.
    selector: 'edge.edge-tree-mount',
    style: {
      'line-color': '#d29922',
      width: 1.5,
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'taxi-turn': '50%',
      'taxi-turn-min-distance': 10,
      'target-arrow-shape': 'none',
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

export function aggregateGroups(nodes) {
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

// Container node data/classes shared by graph mode (buildElements, parented to a compose-group
// box) and tree mode (buildTreeElements, no parent - see there) - factored out so both render
// modes automatically pick up the same live CPU/RAM/health/badge fields from a single place.
function containerNodeEl(n, selectedId, parent) {
  const data = {
    id: n.id,
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
  };
  if (parent) data.parent = parent;
  return {
    data,
    classes:
      (n.state === 'running' ? 'running' : 'stopped') +
      (n.health === 'unhealthy' ? ' unhealthy' : '') +
      (n.id === selectedId ? ' selected' : ''),
  };
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
    ...nodes.map((n) => containerNodeEl(n, selectedId, `grp:${n.group}`)),
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

// containers with this group are treated as having no compose project at all (same sentinel
// docker.js's getTopology already uses for `group` - see there) - a fake "(ungrouped)" project
// node would just be noise, so those containers become their own roots instead.
const NO_PROJECT = 'ungrouped';

const MOUNT_LABEL_LINE_CHARS = 22;

// Cytoscape's text-wrap: 'wrap' only auto-wraps at whitespace, and mount paths/volume names
// have none - a 90-char bind-mount path is one unbreakable "word" as far as it's concerned, so
// it renders on one (very wide) line no matter what text-max-width says. Pre-splitting into
// explicit lines here, preferring path-separator boundaries for readability, is what actually
// makes long labels wrap - text-max-width in CY_STYLE is just a fallback for the rare line that's
// still too long after this (e.g. one giant filename with no separators at all).
function wrapMountLabel(text) {
  if (text.length <= MOUNT_LABEL_LINE_CHARS) return text;
  const parts = text.split(/(?<=[/_-])/);
  const lines = [];
  let current = '';
  for (const part of parts) {
    if (current && (current + part).length > MOUNT_LABEL_LINE_CHARS) {
      lines.push(current);
      current = '';
    }
    current += part;
    while (current.length > MOUNT_LABEL_LINE_CHARS) {
      lines.push(current.slice(0, MOUNT_LABEL_LINE_CHARS));
      current = current.slice(MOUNT_LABEL_LINE_CHARS);
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function mountLabel(source, kind) {
  // Docker's own anonymous-volume names are the mount's full 64-char id, not a human name -
  // shown shortened so the pill stays readable; the node's own `id` keeps the full source so
  // it's still stable/unique across polls (see buildTreeElements).
  const text = kind === 'volume-anon' ? `anon:${source.slice(0, 12)}…` : source;
  return wrapMountLabel(text);
}

// ArgoCD-style tree for the Flow view's tree mode: project -> container -> (network | mount),
// left-to-right via the same dagre layout graph mode uses, but with no compound group boxes -
// rank order falls out of the edges alone. A network or volume shared by several containers is
// deduped globally (one pill, multiple incoming edges) rather than rendered per-container, which
// is the whole point: shared infrastructure becomes visually obvious. Pure/no cytoscape calls, so
// it's unit-testable the same way buildElements/aggregateGroups are.
//
// Node/edge order matters here (unlike buildElements): updateGraph adds new elements one at a
// time via cy.add(), so every node this function emits must appear in the returned array before
// any edge that references it - hence the two passes below (pills first, then containers+edges).
export function buildTreeElements(nodes, selectedId, { showNetworks = true, showMounts = true } = {}) {
  const projectIds = new Set();
  const netNames = new Set();
  const mountSources = new Map();

  for (const n of nodes) {
    if (n.group && n.group !== NO_PROJECT) projectIds.add(n.group);
    if (showNetworks) for (const net of n.networks || []) netNames.add(net);
    if (showMounts) for (const m of n.mounts || []) if (!mountSources.has(m.source)) mountSources.set(m.source, m.kind);
  }

  const els = [];
  for (const g of projectIds) els.push({ data: { id: `proj:${g}`, label: g }, classes: 'proj' });
  for (const net of netNames) els.push({ data: { id: `net:${net}`, label: net }, classes: 'net' });
  for (const [source, kind] of mountSources) {
    els.push({ data: { id: `mount:${source}`, label: mountLabel(source, kind), kind }, classes: 'mount' });
  }

  for (const n of nodes) {
    els.push(containerNodeEl(n, selectedId));
    if (n.group && n.group !== NO_PROJECT) {
      els.push({
        data: { id: `edge:tree:proj:${n.group}->${n.id}`, source: `proj:${n.group}`, target: n.id, kind: 'proj', label: '' },
        classes: 'edge-tree-proj',
      });
    }
    if (showNetworks) {
      for (const net of n.networks || []) {
        els.push({
          data: { id: `edge:tree:${n.id}->net:${net}`, source: n.id, target: `net:${net}`, kind: 'net', label: '' },
          classes: 'edge-tree-net',
        });
      }
    }
    if (showMounts) {
      for (const m of n.mounts || []) {
        els.push({
          data: { id: `edge:tree:${n.id}->mount:${m.source}`, source: n.id, target: `mount:${m.source}`, kind: 'mount', label: '' },
          classes: 'edge-tree-mount',
        });
      }
    }
  }

  return els;
}

const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 90 };
// Tree mode's mount pills can grow several lines tall (wrapped bind-mount paths) - graph mode's
// nodeSep is tuned for its fixed-height container/group boxes and packs siblings too tightly once
// pill heights vary. Extra room here also gives taxi-routed edges (edge-tree-proj/-mount) more
// space to turn cleanly instead of elbowing through a tightly-packed neighbor.
const TREE_LAYOUT = { ...LAYOUT, nodeSep: 70 };
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

// Graph and tree mode lay the same host out completely differently, so a dragged arrangement or
// camera saved in one mode would just be wrong (and fight with dagre) applied to the other -
// each mode gets its own key segment and its own independent saved arrangement.
function loadPositions(hostId, mode = 'graph') {
  if (!hostId) return {};
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY_PREFIX + mode + ':' + hostId)) || {};
  } catch {
    return {};
  }
}

function saveNodePosition(hostId, nodeId, position, mode = 'graph') {
  if (!hostId) return;
  try {
    const positions = loadPositions(hostId, mode);
    positions[nodeId] = position;
    localStorage.setItem(POSITIONS_KEY_PREFIX + mode + ':' + hostId, JSON.stringify(positions));
  } catch {
    /* localStorage unavailable/full - dragging still works, it just won't persist */
  }
}

function applySavedPositions(cy, hostId, mode = 'graph') {
  const positions = loadPositions(hostId, mode);
  for (const [id, pos] of Object.entries(positions)) {
    const node = cy.$id(id);
    if (node.length && !node.hasClass('group')) node.position(pos);
  }
}

function loadViewport(hostId, mode = 'graph') {
  if (!hostId) return null;
  try {
    return JSON.parse(localStorage.getItem(VIEWPORT_KEY_PREFIX + mode + ':' + hostId));
  } catch {
    return null;
  }
}

function saveViewport(hostId, viewport, mode = 'graph') {
  if (!hostId) return;
  try {
    localStorage.setItem(VIEWPORT_KEY_PREFIX + mode + ':' + hostId, JSON.stringify(viewport));
  } catch {
    /* ignore */
  }
}

// Flow mode itself (graph vs tree) is also saved per host, same rationale as positions/viewport
// above - a host you've switched to tree mode for should reopen in tree mode next time.
const FLOW_MODE_KEY_PREFIX = 'odw:flow:mode:';

export function loadFlowMode(hostId) {
  if (!hostId) return 'graph';
  try {
    return localStorage.getItem(FLOW_MODE_KEY_PREFIX + hostId) || 'graph';
  } catch {
    return 'graph';
  }
}

export function saveFlowMode(hostId, mode) {
  if (!hostId) return;
  try {
    localStorage.setItem(FLOW_MODE_KEY_PREFIX + hostId, mode);
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
  try {
    localStorage.removeItem(POSITIONS_KEY_PREFIX + mode + ':' + hostId);
    localStorage.removeItem(VIEWPORT_KEY_PREFIX + mode + ':' + hostId);
  } catch {
    /* ignore */
  }
  runLayout(cy, { fit: true, hostId });
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
    // name covers containers (both modes); label covers tree mode's project/network/mount
    // pills, which have no `name` field of their own.
    const matching = cy
      .nodes()
      .filter((n) => !n.hasClass('group') && (n.data('name') || n.data('label') || '').toLowerCase().includes(text));
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

// ---- SVG export ----
// A vector export has no resolution ceiling to manage the way exportPng's EXPORT_SCALE/
// container-resize dance has to - the whole graph is drawn at its natural size and the viewBox
// just grows to fit, so a host with a lot of compose projects is never "too small to read or a
// huge file" the way a raster export forces you to choose between. extractSvgGeometry (impure:
// reads the live cy instance) and renderSvg (pure: geometry -> markup string) are kept separate
// on purpose, mirroring buildElements/buildTreeElements' own pure-core/impure-adapter split -
// renderSvg is unit-testable the same way, by feeding it a plain geometry object directly
// instead of a live cytoscape instance.

const BLAST_UPSTREAM_COLOR = '#a371f7';
const BLAST_DOWNSTREAM_COLOR = '#f0883e';
const ALERT_BADGE_COLOR = '#e5534b';

function svgEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgTruncate(str, max) {
  const s = str || '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function svgNodeKind(n) {
  if (n.hasClass('cy-expand-collapse-collapsed-node')) return 'group-collapsed';
  if (n.hasClass('group')) return 'group-expanded';
  if (n.hasClass('proj')) return 'proj';
  if (n.hasClass('net')) return 'net';
  if (n.hasClass('mount')) return 'mount';
  if (n.hasClass('running') || n.hasClass('stopped')) return 'container';
  return null;
}

function svgEdgeKind(e) {
  if (e.hasClass('edge-network')) return 'network';
  if (e.hasClass('edge-depends-on')) return 'depends_on';
  if (e.hasClass('edge-manual')) return 'manual';
  if (e.hasClass('edge-tree-proj')) return 'tree-proj';
  if (e.hasClass('edge-tree-net')) return 'tree-net';
  if (e.hasClass('edge-tree-mount')) return 'tree-mount';
  return null;
}

// Reads whatever's currently rendered (either mode) into plain, cytoscape-free data - the
// opposite direction from buildElements/buildTreeElements (data -> cy elements), but the same
// idea of keeping "what's actually drawn" independent of the library that draws it. Leaf/
// collapsed-group sizing deliberately ignores the node's current (possibly compact-shrunk)
// rendered height in favor of the fixed FULL_LEAF_HEIGHT/FULL_GROUP_HEIGHT constants - a vector
// export has no zoom-driven reason to hide detail the way the live semantic-zoom view does.
export function extractSvgGeometry(cy) {
  const nodes = [];
  cy.nodes().forEach((n) => {
    const kind = svgNodeKind(n);
    if (!kind) return;
    let x, y, width, height;
    if (kind === 'group-expanded') {
      const bb = n.boundingBox();
      x = bb.x1 + bb.w / 2;
      y = bb.y1 + bb.h / 2;
      width = bb.w;
      height = bb.h;
    } else {
      const pos = n.position();
      x = pos.x;
      y = pos.y;
      if (kind === 'container') {
        width = NODE_WIDTH;
        height = FULL_LEAF_HEIGHT;
      } else if (kind === 'group-collapsed') {
        width = NODE_WIDTH;
        height = FULL_GROUP_HEIGHT;
      } else {
        width = n.width();
        height = n.height();
      }
    }
    nodes.push({
      id: n.id(),
      kind,
      x,
      y,
      width,
      height,
      data: n.data(),
      running: n.hasClass('running'),
      stopped: n.hasClass('stopped'),
      unhealthy: n.hasClass('unhealthy'),
      selected: n.hasClass('selected'),
      faded: n.hasClass('faded'),
      blastUpstream: n.hasClass('blast-upstream'),
      blastDownstream: n.hasClass('blast-downstream'),
    });
  });

  const edges = [];
  cy.edges().forEach((e) => {
    const kind = svgEdgeKind(e);
    if (!kind) return;
    edges.push({
      id: e.id(),
      kind,
      source: e.sourceEndpoint(),
      target: e.targetEndpoint(),
      label: e.data('label') || '',
      faded: e.hasClass('faded'),
      blastUpstream: e.hasClass('blast-upstream'),
      blastDownstream: e.hasClass('blast-downstream'),
    });
  });

  return { nodes, edges };
}

function svgMetricBars(x, y, width, cpuPct, memPct) {
  const rowGap = 6;
  return (
    `<rect x="${x}" y="${y}" width="${width}" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>` +
    `<rect x="${x}" y="${y}" width="${(width * clampPct(cpuPct)) / 100}" height="3" rx="1.5" fill="${CPU_COLOR}"/>` +
    `<rect x="${x}" y="${y + rowGap}" width="${width}" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>` +
    `<rect x="${x}" y="${y + rowGap}" width="${(width * clampPct(memPct)) / 100}" height="3" rx="1.5" fill="${MEM_COLOR}"/>`
  );
}

function svgAlertBadge(x, y, count) {
  return `<circle cx="${x + 6}" cy="${y + 6}" r="6" fill="${ALERT_BADGE_COLOR}"/><text x="${x + 6}" y="${y + 9}" text-anchor="middle" font-size="8" fill="#fff">${count}</text>`;
}

// Mirrors the .cy-node-box HTML template's layout (public/style.css:491-618): state icon top
// right, service badge + name, CPU/RAM bar rows, NET/DISK text, port/alert badges.
function svgContainerNode(n) {
  const d = n.data;
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  let border = n.stopped ? '#8b909c' : '#3fb950';
  if (n.unhealthy) border = '#f85149';
  if (n.selected) border = '#4f8cff';
  let svg = `<g opacity="${n.faded ? 0.15 : 1}">`;
  if (n.blastUpstream)
    svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="${BLAST_UPSTREAM_COLOR}" fill-opacity="0.22"/>`;
  if (n.blastDownstream)
    svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="${BLAST_DOWNSTREAM_COLOR}" fill-opacity="0.22"/>`;
  svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="#1d2027" stroke="${border}" stroke-width="2"/>`;
  if (d.emoji) svg += `<g transform="translate(${x1 + n.width - 17}, ${y1 + 2})">${d.emoji}</g>`;
  if (d.status) svg += `<text x="${x1 + 18}" y="${y1 + 10}" font-size="9" fill="#8b909c">${svgEscape(svgTruncate(d.status, 22))}</text>`;
  if (d.icon) {
    svg += `<circle cx="${x1 + 14.5}" cy="${y1 + 24.5}" r="8.5" fill="${d.icon.bg}"/>`;
    svg += `<text x="${x1 + 14.5}" y="${y1 + 27.5}" text-anchor="middle" font-size="8" font-weight="600" fill="#fff">${svgEscape(d.icon.text)}</text>`;
  }
  svg += `<text x="${n.x}" y="${y1 + 28}" text-anchor="middle" font-size="11" fill="#e4e6eb">${svgEscape(svgTruncate(d.name, 18))}</text>`;
  svg += svgMetricBars(x1 + 8, y1 + n.height - 32, n.width - 16, d.cpuPerc, d.memPerc);
  svg += `<text x="${x1 + 8}" y="${y1 + n.height - 10}" font-size="5" fill="#8b909c">NET ${svgEscape(d.netIO)}  DISK ${svgEscape(d.blockIO)}</text>`;
  if (d.ports) svg += `<text x="${x1 + 6}" y="${y1 + n.height - 2}" font-size="8" fill="#8b909c">${svgEscape(d.ports)}</text>`;
  if (d.openAlerts > 0) svg += svgAlertBadge(x1 + 4, y1 + 2, d.openAlerts);
  svg += `</g>`;
  return svg;
}

// Collapsed compose group - mirrors the cy-expand-collapse-collapsed-node HTML template (health
// dot, container count, averaged CPU/RAM). An *expanded* group (svgGroupBox below) shows none of
// that - it's just the padded outline + label the live view actually draws for one.
function svgGroupNode(n) {
  const d = n.data;
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  const count = d.count || 0;
  let svg = `<g opacity="${n.faded ? 0.15 : 1}">`;
  svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="#1d2027" stroke="#2b2f38" stroke-width="1"/>`;
  if (d.health) svg += `<circle cx="${x1 + n.width - 10}" cy="${y1 + 8}" r="3.5" fill="${healthColor(d.health)}"/>`;
  svg += `<text x="${n.x}" y="${y1 + 26}" text-anchor="middle" font-size="11" fill="#e4e6eb">${svgEscape(d.label)}</text>`;
  svg += `<text x="${n.x}" y="${y1 + 42}" text-anchor="middle" font-size="9" fill="#8b909c">${count} container${count === 1 ? '' : 's'}</text>`;
  svg += svgMetricBars(x1 + 8, y1 + n.height - 24, n.width - 16, d.cpuAvg, d.memAvg);
  if (d.openAlerts > 0) svg += svgAlertBadge(x1 + 4, y1 + 2, d.openAlerts);
  svg += `</g>`;
  return svg;
}

function svgGroupBox(n) {
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  return (
    `<g opacity="${n.faded ? 0.15 : 1}">` +
    `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="#1d2027" stroke="#2b2f38" stroke-width="1"/>` +
    `<text x="${n.x}" y="${y1 + 16}" text-anchor="middle" font-size="12" fill="#8b909c">${svgEscape(n.data.label)}</text>` +
    `</g>`
  );
}

// Tree mode's project/network/mount pills - plain rect + centered text, matching CY_STYLE's
// node.proj/.net/.mount. Mount labels already carry \n for wrapped long paths (see
// wrapMountLabel) - split into one <tspan> per line rather than trying to word-wrap in SVG.
function svgPillNode(n, { border, text, bg }) {
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  const lines = String(n.data.label || '').split('\n');
  const lineHeight = 12;
  const startY = n.y - ((lines.length - 1) * lineHeight) / 2 + 3;
  const tspans = lines.map((line) => `<tspan x="${n.x}" dy="${lineHeight}">${svgEscape(line)}</tspan>`).join('');
  return (
    `<g opacity="${n.faded ? 0.15 : 1}">` +
    `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="6" fill="${bg}" stroke="${border}" stroke-width="1"/>` +
    `<text x="${n.x}" y="${startY - lineHeight}" text-anchor="middle" font-size="10" fill="${text}">${tspans}</text>` +
    `</g>`
  );
}

function svgNode(n) {
  switch (n.kind) {
    case 'container':
      return svgContainerNode(n);
    case 'group-collapsed':
      return svgGroupNode(n);
    case 'group-expanded':
      return svgGroupBox(n);
    case 'proj':
      return svgPillNode(n, { border: '#2d5fa8', text: '#e4e6eb', bg: '#1d2027' });
    case 'net':
      return svgPillNode(n, { border: '#4f8cff', text: '#4f8cff', bg: '#182234' });
    case 'mount':
      return svgPillNode(n, { border: '#d29922', text: '#d29922', bg: '#241d14' });
    default:
      return '';
  }
}

const EDGE_SVG_STYLE = {
  network: { color: '#2b2f38', dash: '6,4', arrow: false, taxi: false },
  depends_on: { color: '#199e70', dash: null, arrow: true, taxi: false },
  manual: { color: '#4f8cff', dash: null, arrow: true, taxi: false },
  'tree-proj': { color: '#3a3f4b', dash: null, arrow: false, taxi: true },
  'tree-net': { color: '#4f8cff', dash: '6,4', arrow: false, taxi: false },
  'tree-mount': { color: '#d29922', dash: null, arrow: false, taxi: true },
};

// Matches CY_STYLE's taxi-turn: '50%' - a horizontal-vertical-horizontal elbow turning at the
// x-midpoint between source and target, same formula cytoscape itself uses for edge-tree-proj/
// edge-tree-mount.
function taxiPoints(source, target) {
  const midX = (source.x + target.x) / 2;
  return [source, { x: midX, y: source.y }, { x: midX, y: target.y }, target];
}

function svgArrowHead(from, to, color) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 7;
  const spread = 0.4;
  const p1 = { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) };
  const p2 = { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) };
  return `<polygon points="${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" fill="${color}"/>`;
}

// Graph-mode edges (network/depends-on/manual) are bezier-curved in the live view - drawn here
// as straight lines rather than reverse-engineering cytoscape's bezier control-point math, which
// isn't worth the complexity for a visual difference this minor.
function svgEdge(e) {
  const style = EDGE_SVG_STYLE[e.kind];
  if (!style) return '';
  let color = style.color;
  let width = 1.5;
  if (e.blastUpstream) {
    color = BLAST_UPSTREAM_COLOR;
    width = 3;
  } else if (e.blastDownstream) {
    color = BLAST_DOWNSTREAM_COLOR;
    width = 3;
  }
  const points = style.taxi ? taxiPoints(e.source, e.target) : [e.source, e.target];
  const pointsAttr = points.map((p) => `${p.x},${p.y}`).join(' ');
  const dashAttr = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
  let svg = `<g opacity="${e.faded ? 0.15 : 1}">`;
  svg += `<polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="${width}"${dashAttr}/>`;
  if (style.arrow) svg += svgArrowHead(points[points.length - 2], points[points.length - 1], color);
  if (e.label) {
    const mx = (e.source.x + e.target.x) / 2;
    const my = (e.source.y + e.target.y) / 2;
    const label = svgEscape(e.label);
    const boxWidth = label.length * 5.5 + 8;
    svg += `<rect x="${mx - boxWidth / 2}" y="${my - 7}" width="${boxWidth}" height="14" fill="#14161a"/>`;
    svg += `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" fill="${color}">${label}</text>`;
  }
  svg += `</g>`;
  return svg;
}

// Pure: geometry (from extractSvgGeometry, or a synthetic fixture in tests) -> a complete <svg>
// document string. The viewBox grows to fit every node's bounds plus padding - no fixed
// resolution/size decision to make, unlike the PNG export.
export function renderSvg(geometry, { background = '#14161a' } = {}) {
  const { nodes, edges } = geometry;
  if (!nodes.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="${background}"/></svg>`;
  }
  const PAD = 40;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    maxY = Math.max(maxY, n.y + n.height / 2);
  }
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;
  const width = maxX - minX;
  const height = maxY - minY;

  const edgesSvg = edges.map(svgEdge).join('\n');
  const nodesSvg = nodes.map(svgNode).join('\n');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}" font-family="sans-serif">`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${background}"/>`,
    edgesSvg,
    nodesSvg,
    `</svg>`,
  ].join('\n');
}

// cy.fit-to-all before extracting, matching exportPng's behavior - the export always captures
// the whole graph, not just the current viewport. No container-resize or frame-wait needed the
// way exportPng needs one: this reads cytoscape's own bounding boxes/positions, which are
// already current the moment fit() returns, and never touches the DOM overlay at all.
export async function exportSvg(cy) {
  if (!cy) return;
  const savedViewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  cy.fit(undefined, 30);

  const svgString = renderSvg(extractSvgGeometry(cy));
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `opendockwatch-flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  cy.viewport(savedViewport);
}

// cy.png() only rasterizes cytoscape's own <canvas> layer - it has no way to see the
// node-html-label plugin's DOM overlay, which is what actually renders everything inside
// a node box (name, icon, CPU/RAM bars, badges). html2canvas screenshots the real on-screen
// DOM instead, canvas included, so the export matches what's actually visible.
const EXPORT_SCALE = 2;

export async function exportPng(cy) {
  if (!cy || typeof html2canvas !== 'function') return;
  const container = cy.container();

  // Exports exactly what's currently on screen - the user's own pan/zoom - rather than always
  // fitting the whole graph regardless of what they'd zoomed into. (For "the whole graph,
  // always, with no resolution ceiling at all" there's Export SVG.)
  const savedViewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  const savedWidth = container.style.width;
  const savedHeight = container.style.height;

  // html2canvas doesn't re-render cytoscape's <canvas> - it just copies its existing bitmap.
  // On a standard (non-Retina) display that bitmap is only CSS-pixel resolution, so asking
  // html2canvas for a higher `scale` was just stretching an already-low-res source, which reads
  // as blurry. Temporarily rendering into a container EXPORT_SCALE times larger gives cytoscape
  // a proportionally bigger canvas backing store (real pixels, not interpolated ones) to draw
  // into - the node-html-label overlay scales up right along with it since its own transform
  // tracks cytoscape's zoom, so text stays crisp too.
  //
  // Scaling the container size, zoom, AND pan all by the same EXPORT_SCALE is a uniform scale-up
  // of the whole rendered coordinate system: renderedX = graphX * zoom + pan.x, so multiplying
  // zoom/pan/container by the same factor leaves exactly the same graph-space area framed (the
  // same crop, nothing added or cut off) - just with EXPORT_SCALE times as many real pixels to
  // draw it into.
  const rect = container.getBoundingClientRect();
  container.style.width = `${rect.width * EXPORT_SCALE}px`;
  container.style.height = `${rect.height * EXPORT_SCALE}px`;
  // Setting style.width/height doesn't take effect synchronously - the browser can defer layout
  // until the next paint, so calling cy.resize() right away risks it reading the container's OLD
  // size. Reading offsetHeight forces an immediate layout flush, so resize() sees the real new
  // size and actually reallocates cytoscape's canvas at it (not just stretch the old bitmap via
  // CSS, which is what was producing the blur in the first place).
  void container.offsetHeight;
  cy.resize();
  cy.viewport({
    zoom: savedViewport.zoom * EXPORT_SCALE,
    pan: { x: savedViewport.pan.x * EXPORT_SCALE, y: savedViewport.pan.y * EXPORT_SCALE },
  });
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const canvas = await html2canvas(container, { backgroundColor: '#14161a', scale: 1 });
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `opendockwatch-flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    container.style.width = savedWidth;
    container.style.height = savedHeight;
    cy.resize();
    cy.viewport(savedViewport);
  }
}

export function createGraph(container, elements, onNodeTap, onEdgeTap, hostId, mode = 'graph') {
  const cy = cytoscape({
    container,
    elements,
    style: CY_STYLE,
  });
  cy.scratch('_odw_mode', mode);
  cy.scratch('_odw_latestElements', elements);
  runLayout(cy, { fit: true, hostId });
  // runLayout's fit/viewport-restore happens synchronously above, before the 'viewport'
  // listener further down even exists yet - set the initial compact state explicitly rather
  // than relying on that first fit to have been caught by a listener that isn't registered yet.
  updateCompactFlag(cy);

  // Tree mode has no compound group boxes to collapse - skip registering the plugin/its
  // listeners entirely rather than have them sit there doing nothing every poll.
  if (mode === 'graph' && !expandCollapseRegistered && typeof cytoscapeExpandCollapse !== 'undefined') {
    cytoscape.use(cytoscapeExpandCollapse);
    expandCollapseRegistered = true;
  }
  if (mode === 'graph' && typeof cy.expandCollapse === 'function') {
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
    if (!node.hasClass('group')) saveNodePosition(hostId, node.id(), node.position(), mode);
  });

  let viewportSaveTimer = null;
  cy.on('viewport', () => {
    updateCompactFlag(cy);
    clearTimeout(viewportSaveTimer);
    viewportSaveTimer = setTimeout(() => {
      saveViewport(hostId, { zoom: cy.zoom(), pan: cy.pan() }, mode);
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
