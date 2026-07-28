// Per-host node positions (from dragging) and camera (zoom/pan) - kept in localStorage so
// a manually-arranged layout survives both a page reload and the next poll cycle's
// structure-changed re-layout (a container starting/stopping elsewhere in the topology
// would otherwise wipe every dragged position, since dagre lays the whole graph out fresh).
const POSITIONS_KEY_PREFIX = 'odw:flow:positions:';
const VIEWPORT_KEY_PREFIX = 'odw:flow:viewport:';
const COLLAPSED_KEY_PREFIX = 'odw:flow:collapsed:';

export function loadCollapsedGroups(hostId) {
  if (!hostId) return [];
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY_PREFIX + hostId)) || [];
  } catch {
    return [];
  }
}

export function saveCollapsedGroups(hostId, ids) {
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
export function loadPositions(hostId, mode = 'graph') {
  if (!hostId) return {};
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY_PREFIX + mode + ':' + hostId)) || {};
  } catch {
    return {};
  }
}

export function saveNodePosition(hostId, nodeId, position, mode = 'graph') {
  if (!hostId) return;
  try {
    const positions = loadPositions(hostId, mode);
    positions[nodeId] = position;
    localStorage.setItem(POSITIONS_KEY_PREFIX + mode + ':' + hostId, JSON.stringify(positions));
  } catch {
    /* localStorage unavailable/full - dragging still works, it just won't persist */
  }
}

export function applySavedPositions(cy, hostId, mode = 'graph') {
  const positions = loadPositions(hostId, mode);
  for (const [id, pos] of Object.entries(positions)) {
    const node = cy.$id(id);
    if (node.length && !node.hasClass('group')) node.position(pos);
  }
}

// Clears a host+mode's dragged positions - used by resetView (layout.js) to undo manual
// dragging and start over, rather than reaching past this module to remove the raw key itself.
export function clearPositions(hostId, mode = 'graph') {
  if (!hostId) return;
  try {
    localStorage.removeItem(POSITIONS_KEY_PREFIX + mode + ':' + hostId);
  } catch {
    /* ignore */
  }
}

export function loadViewport(hostId, mode = 'graph') {
  if (!hostId) return null;
  try {
    return JSON.parse(localStorage.getItem(VIEWPORT_KEY_PREFIX + mode + ':' + hostId));
  } catch {
    return null;
  }
}

export function saveViewport(hostId, viewport, mode = 'graph') {
  if (!hostId) return;
  try {
    localStorage.setItem(VIEWPORT_KEY_PREFIX + mode + ':' + hostId, JSON.stringify(viewport));
  } catch {
    /* ignore */
  }
}

// Clears a host+mode's saved camera - same rationale as clearPositions above.
export function clearViewport(hostId, mode = 'graph') {
  if (!hostId) return;
  try {
    localStorage.removeItem(VIEWPORT_KEY_PREFIX + mode + ':' + hostId);
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
