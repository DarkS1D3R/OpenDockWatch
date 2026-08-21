import { healthColor, escapeHtml } from './format.js';
import { containerFullHeight, clampPct, CONTAINER_STATE_CLASSES } from './graph/elements.js';
import { CY_STYLE, CPU_COLOR, MEM_COLOR } from './graph/style.js';
import { runLayout, updateCompactFlag, resolveNodeOverlap } from './graph/layout.js';
import { loadCollapsedGroups, saveCollapsedGroups, saveNodePosition, saveViewport } from './graph/persistence.js';

// The live cytoscape instance lifecycle: creating it, wiring its events, diffing poll-driven
// updates into it, blast-radius/filter fading, and the PNG exporter. Element-building, styling,
// persistence and layout live in graph/*.js - this file is what actually owns a `cy` instance.

let htmlLabelRegistered = false;
let expandCollapseRegistered = false;

// Updates an existing cytoscape instance in place instead of recreating it, so the user's pan/zoom
// survives the next poll's refresh. Layout only re-runs when nodes/edges actually changed, in
// which case runLayout re-applies saved positions/camera, or fits with no saved camera yet.
export function updateGraph(cy, elements, hostId) {
  cy.scratch('_odw_latestElements', elements);

  // cytoscape-expand-collapse physically removes a collapsed group's children from the graph, so
  // this diff must never add them back in or it'd corrupt the plugin's bookkeeping and silently
  // un-collapse the group. Skipped entirely while hidden; afterexpand re-syncs them. See public/CLAUDE.md.
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
      // always just 'group' - applying it as-is would strip the plugin's own marker class every
      // poll, desyncing its bookkeeping (the group silently pops back open on the next poll).
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
  // survives a poll refresh - but a brand-new node (or one just revealed by expanding a group)
  // starts with none, rendering full-mode regardless of zoom until the next actual zoom/pan.
  updateCompactFlag(cy);
}

// Walks depends_on edges transitively from the selected node. 'target' follows forward (what
// this node depends on); 'source' follows backward (what breaks if it dies). Returns both the
// reached node ids and the specific edges used, so only the actual dependency path gets tinted.
function traverseDependsOn(cy, startId, followField) {
  const fromField = followField === 'target' ? 'source' : 'target';
  const edges = cy.edges('.edge-depends-on');
  // Adjacency built once up front rather than rescanning every depends-on edge per dequeued node -
  // the latter is O(V·E), which on a large compose graph with a deep dependency chain multiplies
  // out fast; this is O(V+E), same as any other BFS.
  const byFrom = new Map(); // fromId -> [{ edgeId, nextId }]
  edges.forEach((edge) => {
    const from = edge.data(fromField);
    const entry = { edgeId: edge.id(), nextId: edge.data(followField) };
    if (byFrom.has(from)) byFrom.get(from).push(entry);
    else byFrom.set(from, [entry]);
  });

  const nodeIds = new Set();
  const edgeIds = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const { edgeId, nextId } of byFrom.get(id) || []) {
      edgeIds.add(edgeId);
      if (nextId !== startId && !nodeIds.has(nextId)) {
        nodeIds.add(nextId);
        queue.push(nextId);
      }
    }
  }
  return { nodeIds, edgeIds };
}

// Dims everything outside the given selection/filter so the surrounding topology is easier to
// read. filterText takes priority over selectedId - typing a filter while a node is selected
// would otherwise fight over what "faded" means. Group boxes are never faded to stay legible.
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

      // A single filter() pass over cy.nodes() rather than reduce()-ing N individual cy.$id()
      // unions together - the latter is O(N²), since each union re-merges the whole collection so far.
      const transitiveIds = new Set([...upstream.nodeIds, ...downstream.nodeIds]);
      const transitive = cy.nodes().filter((n) => transitiveIds.has(n.id()));
      const keep = node.closedNeighborhood().union(transitive);
      cy.nodes().not(keep).not('.group').addClass('faded');
      cy.edges().forEach((e) => {
        if (e.hasClass('blast-upstream') || e.hasClass('blast-downstream')) return;
        if (!keep.contains(e.source()) || !keep.contains(e.target())) e.addClass('faded');
      });
    }
  }

  // cytoscape-node-html-label renders its overlay from node data(), not cytoscape's style/class
  // system, so .faded above never reaches the HTML label on its own - only canvas-drawn border
  // and edges pick it up. Mirror it into data so the template can fade the overlay to match.
  cy.nodes().forEach((n) => {
    const faded = n.hasClass('faded');
    if (n.data('faded') !== faded) n.data('faded', faded);
  });
}

// cy.png() only rasterizes cytoscape's own <canvas>, not the node-html-label plugin's DOM
// overlay that renders everything inside a node box. html2canvas screenshots the real on-screen
// DOM instead, canvas included. See public/CLAUDE.md.
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

  // html2canvas just copies cytoscape's existing (CSS-pixel-resolution) canvas bitmap, so asking
  // for a higher `scale` merely stretches an already-low-res source. Instead, render into a
  // container EXPORT_SCALE times larger for a proportionally bigger real backing store - see public/CLAUDE.md.
  const rect = container.getBoundingClientRect();
  container.style.width = `${rect.width * EXPORT_SCALE}px`;
  container.style.height = `${rect.height * EXPORT_SCALE}px`;
  // Setting style.width/height doesn't take effect synchronously, so calling cy.resize() right
  // away risks it reading the container's OLD size. Reading offsetHeight forces an immediate
  // layout flush so resize() sees the real new size and reallocates cytoscape's canvas at it.
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

// The two nodeHtmlLabel templates below build raw HTML (a real DOM overlay, not canvas), unlike
// every other node kind's `label: 'data(label)'` in graph/style.js - so name/status/label are
// escaped before going in. Defence-in-depth, not a live fix (CSP blocks execution). See public/CLAUDE.md.
export function containerNodeTpl(data) {
  const name = escapeHtml(data.name);
  const status = escapeHtml(data.status);
  if (data.compact) {
    return `
          <div class="cy-node-box cy-node-box-compact${data.faded ? ' faded' : ''}">
            <span class="cy-node-emoji">${data.emoji}</span>
            <span class="cy-node-icon" style="background:${data.icon.bg}">${data.icon.text}</span>
            <span class="cy-node-name">${name}</span>
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `;
  }
  return `
          <div class="cy-node-box${data.faded ? ' faded' : ''}" style="height:${containerFullHeight(data.portLines)}px">
            <span class="cy-node-emoji">${data.emoji}</span>
            <span class="cy-node-status">${status}</span>
            <span class="cy-node-icon" style="background:${data.icon.bg}">${data.icon.text}</span>
            <span class="cy-node-name">${name}</span>
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
        `;
}

export function collapsedGroupTpl(data) {
  const label = escapeHtml(data.label);
  if (data.compact) {
    return `
          <div class="cy-node-box cy-node-group-box cy-node-box-compact${data.faded ? ' faded' : ''}">
            ${data.health ? `<span class="cy-node-group-health" style="background:${healthColor(data.health)}"></span>` : ''}
            <span class="cy-node-name">${label}</span>
            ${data.openAlerts > 0 ? `<span class="cy-node-alert-badge">${data.openAlerts}</span>` : ''}
          </div>
        `;
  }
  return `
          <div class="cy-node-box cy-node-group-box${data.faded ? ' faded' : ''}">
            ${data.health ? `<span class="cy-node-group-health" style="background:${healthColor(data.health)}"></span>` : ''}
            <span class="cy-node-name">${label}</span>
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
        `;
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
    // fisheye off: distorts sibling positions during collapse/expand, fighting the dragged/saved
    // positions this view preserves. undoable off: skips the undo-redo extension this app doesn't
    // vendor. cueEnabled draws the click-to-toggle +/- affordance directly on each group box.
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
      // Same O(n²) reduce()+union() trap as applyFading's transitive set below - one filter() pass
      // over cy.nodes() instead of N single-element unions.
      const savedIds = new Set(savedCollapsed);
      const toCollapse = cy.nodes().filter((n) => savedIds.has(n.id()));
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

      // A collapsed group is a small box, easy to drag against a neighbor without tripping the
      // drag-time overlap check (which only guards individual node drops, not the much bigger
      // box a group turns back into on expand). Push the reopened group clear as a unit.
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
  // intermediate mouse position would block the node against anything its path crossed, even
  // when the drop target is clear - feeling like getting stuck on furniture, not just refused overlap.
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
        query: CONTAINER_STATE_CLASSES.map((c) => `node.${c}`).join(', '),
        halign: 'center',
        valign: 'center',
        halignBox: 'center',
        valignBox: 'center',
        tpl: containerNodeTpl,
      },
      {
        query: 'node.cy-expand-collapse-collapsed-node',
        halign: 'center',
        valign: 'center',
        halignBox: 'center',
        valignBox: 'center',
        tpl: collapsedGroupTpl,
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
