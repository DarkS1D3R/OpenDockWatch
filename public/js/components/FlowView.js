import {
  buildElements,
  buildTreeElements,
  createGraph,
  updateGraph,
  applyFading,
  exportPng,
  exportSvg,
  collapseAllGroups,
  expandAllGroups,
  loadFlowMode,
  saveFlowMode,
  resetView,
} from '../graph.js';

// The Flow view: the cytoscape instance, graph/tree mode switching, edge/state filters,
// fullscreen, tree-mode pill selection, and edge/pill tap info. Stays mounted via v-show (not
// v-if) at the root, same as ContainerList - unlike the log/detail/settings/activity panels,
// rebuilding a cytoscape graph from scratch on every tab switch would be wasteful, especially for
// a host with many compose projects, so this component watches its hostId/topology props instead
// of remounting to pick up a host switch or a fresh poll.
//
// `selectedContainerId` is a two-way relationship with the root: a tap on a real container node
// emits 'select' (the root owns the toggle-on-reselect semantics, shared with ContainerList's row
// clicks); the root passing a new id back down is what this component's own watcher uses to sync
// cy's `.selected` class and recompute fading. A tapped tree-mode pill (proj:/net:/mount: id) is
// NOT a real container - routing it into selectedContainerId would trip ContainerDetail's watcher
// into fetching docker inspect for a fake id, so it's filtered out here and kept as fully local
// state, used only for fading and the info bar.
//
// `fullscreen` is the one other bit of state the root still needs directly (v-model) - it hides
// the host card and other panels, which is the root's layout to control.
export default {
  name: 'FlowView',
  props: {
    topology: { type: Object, required: true },
    // Unlike the other extracted components, this one is v-show'd (always mounted from app
    // start, not v-if'd in once a host is guaranteed selected) - so hostId can briefly be null
    // before the first selectHost() call resolves.
    hostId: { type: String, default: null },
    selectedContainerId: { type: String, default: null },
    stateFilter: { type: String, default: 'all' },
    fullscreen: { type: Boolean, default: false },
  },
  emits: ['select', 'update:fullscreen'],
  data() {
    return {
      cy: null,
      edgeFilters: { dependsOn: true, network: true, manual: true },
      flowFilterText: '',
      edgeInfoText: null,
      flowMode: 'graph', // 'graph' | 'tree'
      treeShowNetworks: true,
      treeShowMounts: true,
      pillSelection: null, // id of a tapped proj:/net:/mount: pill in tree mode
    };
  },
  computed: {
    filteredTopology() {
      let nodes = this.topology.nodes;
      if (this.stateFilter === 'running') nodes = nodes.filter((n) => n.state === 'running');
      else if (this.stateFilter === 'stopped') nodes = nodes.filter((n) => n.state !== 'running');
      const ids = new Set(nodes.map((n) => n.id));
      const kindKey = { depends_on: 'dependsOn', network: 'network', manual: 'manual' };
      const edges = this.topology.edges.filter(
        (e) => ids.has(e.source) && ids.has(e.target) && this.edgeFilters[kindKey[e.kind] || 'network']
      );
      return { nodes, edges };
    },
  },
  watch: {
    topology() {
      this.renderGraph();
    },
    hostId(newId) {
      if (this.cy) {
        this.cy.destroy();
        this.cy = null;
      }
      this.edgeInfoText = null;
      this.pillSelection = null;
      this.flowMode = loadFlowMode(newId);
    },
    selectedContainerId(newId) {
      if (this.cy) {
        this.cy.nodes().removeClass('selected');
        if (newId) this.cy.$id(newId).addClass('selected');
        this.applyFading();
      }
    },
    stateFilter() {
      this.renderGraph();
    },
    flowFilterText() {
      this.applyFading();
    },
    edgeFilters: {
      deep: true,
      handler() {
        this.renderGraph();
      },
    },
    treeShowNetworks() {
      if (this.flowMode === 'tree') this.renderGraph();
    },
    treeShowMounts() {
      if (this.flowMode === 'tree') this.renderGraph();
    },
  },
  beforeUnmount() {
    if (this.cy) this.cy.destroy();
  },
  methods: {
    renderGraph() {
      if (!this.$refs.cy) return;
      const elements =
        this.flowMode === 'tree'
          ? buildTreeElements(this.filteredTopology.nodes, this.selectedContainerId, {
              showNetworks: this.treeShowNetworks,
              showMounts: this.treeShowMounts,
            })
          : buildElements(this.filteredTopology.nodes, this.filteredTopology.edges, this.selectedContainerId);
      if (this.cy) {
        updateGraph(this.cy, elements, this.hostId);
      } else {
        this.cy = createGraph(
          this.$refs.cy,
          elements,
          (id) => this.onNodeTap(id),
          (edgeData) => this.showEdgeInfo(edgeData),
          this.hostId,
          this.flowMode
        );
      }
      this.applyFading();
    },
    applyFading() {
      if (this.cy) applyFading(this.cy, { selectedId: this.selectedContainerId || this.pillSelection, filterText: this.flowFilterText });
    },
    setFlowMode(mode) {
      if (this.flowMode === mode) return;
      this.flowMode = mode;
      saveFlowMode(this.hostId, mode);
      this.pillSelection = null;
      this.edgeInfoText = null;
      if (this.cy) {
        this.cy.destroy();
        this.cy = null;
      }
      this.renderGraph();
    },
    onNodeTap(id) {
      if (id.startsWith('proj:') || id.startsWith('net:') || id.startsWith('mount:')) {
        this.pillSelection = this.pillSelection === id ? null : id;
        if (this.pillSelection) this.showPillInfo(id);
        else this.edgeInfoText = null;
        this.applyFading();
        return;
      }
      this.pillSelection = null;
      this.$emit('select', id);
    },
    // Builds the tap-info text for a network/mount/project pill in tree mode - reuses the same
    // edgeInfoText slot the graph-mode edge-tap info already renders into, rather than adding a
    // second near-duplicate bit of UI.
    showPillInfo(id) {
      if (id.startsWith('proj:')) {
        const name = id.slice('proj:'.length);
        const count = this.topology.nodes.filter((n) => n.group === name).length;
        this.edgeInfoText = `project ${name} — ${count} container${count === 1 ? '' : 's'}`;
      } else if (id.startsWith('net:')) {
        const name = id.slice('net:'.length);
        const members = this.topology.nodes.filter((n) => (n.networks || []).includes(name)).map((n) => n.name);
        this.edgeInfoText = `network ${name} — shared by ${members.join(', ') || 'no containers'}`;
      } else if (id.startsWith('mount:')) {
        const source = id.slice('mount:'.length);
        const members = this.topology.nodes.filter((n) => (n.mounts || []).some((m) => m.source === source)).map((n) => n.name);
        const mount = this.topology.nodes.flatMap((n) => n.mounts || []).find((m) => m.source === source);
        const label =
          mount?.kind === 'volume-anon' ? 'anonymous volume' : mount?.kind === 'bind' ? `bind mount ${source}` : `volume ${source}`;
        this.edgeInfoText = `${label} — mounted by ${members.join(', ') || 'no containers'}`;
      }
    },
    showEdgeInfo(edgeData) {
      if (!edgeData) {
        this.edgeInfoText = null;
        // Tapping empty canvas is the only way to clear a tree-mode pill selection - unlike a
        // selected container, a pill has no detail panel with its own close button.
        if (this.pillSelection) {
          this.pillSelection = null;
          this.applyFading();
        }
        return;
      }
      // A cross-project network edge (see aggregateNetworkEdges in graph.js) points at a
      // "grp:<project>" id instead of a container id - resolve that back to a plain project name
      // rather than falling through to the raw id, same as showPillInfo does for tree mode's own
      // project pills.
      const nameOf = (id) => (id.startsWith('grp:') ? id.slice('grp:'.length) : this.topology.nodes.find((n) => n.id === id)?.name || id);
      const from = nameOf(edgeData.source);
      const to = nameOf(edgeData.target);
      if (edgeData.kind === 'depends_on') {
        this.edgeInfoText = `${from} depends on ${to}${edgeData.label ? ` (${edgeData.label})` : ''}`;
      } else if (edgeData.kind === 'manual') {
        this.edgeInfoText = `${from} → ${to}${edgeData.label ? `: ${edgeData.label}` : ''} (declared in hosts.json)`;
      } else {
        this.edgeInfoText = edgeData.label ? `${from} and ${to} share ${edgeData.label}` : `${from} and ${to} share a Docker network`;
      }
    },
    async exportFlowPng() {
      await exportPng(this.cy);
    },
    async exportFlowSvg() {
      await exportSvg(this.cy);
    },
    collapseAll() {
      collapseAllGroups(this.cy);
    },
    expandAll() {
      expandAllGroups(this.cy);
    },
    async toggleFullscreen() {
      this.$emit('update:fullscreen', !this.fullscreen);
      // Wait for the height change (host card hidden, .cy-container grown) to actually land in
      // the DOM before telling cytoscape about it - resize() reads the container's current
      // rendered size, so calling it a tick too early would just re-measure the old size.
      await this.$nextTick();
      if (this.cy) {
        this.cy.resize();
        this.cy.fit(undefined, 30);
      }
    },
    zoomBy(factor) {
      if (!this.cy) return;
      const center = { x: this.cy.width() / 2, y: this.cy.height() / 2 };
      this.cy.zoom({ level: this.cy.zoom() * factor, renderedPosition: center });
    },
    zoomFit() {
      if (this.cy) this.cy.fit(undefined, 30);
    },
    resetFlowView() {
      resetView(this.cy, this.hostId);
    },
  },
  template: `
    <div class="cy-wrap" :class="{ 'cy-fullscreen': fullscreen }">
      <button
        class="cy-fullscreen-btn"
        @click="toggleFullscreen"
        :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen - hide the host stats so the graph gets more room'"
      >
        {{ fullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen' }}
      </button>
      <div class="cy-toolbar">
        <div class="view-toggle">
          <button :class="{active: flowMode==='graph'}" @click="setFlowMode('graph')">Graph</button>
          <button :class="{active: flowMode==='tree'}" @click="setFlowMode('tree')">Tree</button>
        </div>
        <span class="toolbar-sep"></span>
        <button @click="zoomBy(1.25)">Zoom in</button>
        <button @click="zoomBy(0.8)">Zoom out</button>
        <button @click="zoomFit">Fit</button>
        <template v-if="flowMode === 'graph'">
          <span class="toolbar-sep"></span>
          <button @click="collapseAll">Collapse all</button>
          <button @click="expandAll">Expand all</button>
        </template>
        <template v-else>
          <button @click="resetFlowView" title="Undo any dragged positions and re-fit the camera">Reset view</button>
        </template>
        <span class="toolbar-sep"></span>
        <button @click="exportFlowPng" title="Exports exactly what's on screen right now - zoom/pan in first to crop it">Export PNG</button>
        <button @click="exportFlowSvg" title="Vector export of the whole graph - no size ceiling, good for hosts with a lot of compose projects">Export SVG</button>
        <span class="toolbar-sep"></span>
        <input type="text" v-model="flowFilterText" placeholder="Filter by name…" class="flow-filter-input" />
        <span class="toolbar-sep"></span>
        <template v-if="flowMode === 'graph'">
          <label class="edge-toggle"><input type="checkbox" v-model="edgeFilters.dependsOn" /> depends-on</label>
          <label class="edge-toggle"><input type="checkbox" v-model="edgeFilters.network" /> network</label>
          <label class="edge-toggle"><input type="checkbox" v-model="edgeFilters.manual" /> manual</label>
        </template>
        <template v-else>
          <label class="edge-toggle"><input type="checkbox" v-model="treeShowNetworks" /> networks</label>
          <label class="edge-toggle"><input type="checkbox" v-model="treeShowMounts" /> mounts</label>
        </template>
        <span v-if="edgeInfoText" class="edge-info-text">{{ edgeInfoText }}</span>
      </div>
      <div ref="cy" class="cy-container"></div>
      <p v-if="flowMode === 'graph'" class="muted legend">
        <span class="legend-item"><span class="swatch swatch-running"></span> running</span>
        <span class="legend-item"><span class="swatch swatch-stopped"></span> stopped</span>
        <span class="legend-item"><span class="line line-network"></span> shared network</span>
        <span class="legend-item"><span class="line line-depends-on"></span> depends-on</span>
        <span class="legend-item"><span class="line line-manual"></span> declared dependency</span>
        <span class="legend-item"><span class="swatch swatch-alert"></span> open alert</span>
        <span class="legend-item"><span class="swatch swatch-blast-upstream"></span> selection needs (on select)</span>
        <span class="legend-item"><span class="swatch swatch-blast-downstream"></span> will suffer if selection dies (on select)</span>
        <span class="legend-item"><span class="bar-swatch bar-swatch-cpu"></span> CPU</span>
        <span class="legend-item"><span class="bar-swatch bar-swatch-mem"></span> RAM</span>
      </p>
      <p v-else class="muted legend">
        <span class="legend-item"><span class="swatch swatch-running"></span> running</span>
        <span class="legend-item"><span class="swatch swatch-stopped"></span> stopped</span>
        <span class="legend-item"><span class="swatch swatch-proj"></span> compose project</span>
        <span class="legend-item"><span class="line line-tree-net"></span> network</span>
        <span class="legend-item"><span class="line line-tree-mount"></span> bind mount</span>
        <span class="legend-item"><span class="line line-tree-volume"></span> volume</span>
        <span class="legend-item"><span class="line line-tree-shared"></span> shared by 2+ containers</span>
        <span class="legend-item"><span class="swatch swatch-alert"></span> open alert</span>
      </p>
    </div>
  `,
};
