import { POLL_MS, METRICS_HISTORY_LEN, HOST_METRICS_HISTORY_LEN } from './constants.js';
import SparkTile from './components/SparkTile.js';
import HostCard from './components/HostCard.js';
import LogViewer from './components/LogViewer.js';
import ContainerDetail from './components/ContainerDetail.js';
import ActivityView from './components/ActivityView.js';
import SettingsPanel from './components/SettingsPanel.js';
import ContainerList from './components/ContainerList.js';
import { parseMemUsedBytes } from './format.js';
import {
  apiGetHosts,
  apiGetContainers,
  apiGetStats,
  apiGetTopology,
  apiGetHostInfo,
  apiContainerAction,
  apiLogout,
  apiGetSession,
  apiGetDiskUsage,
  apiGetMetricsHistory,
  apiGetAlerts,
  apiAckAlert,
} from './api.js';
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
} from './graph.js';

const { createApp } = Vue;

createApp({
  components: {
    SparkTile,
    HostCard,
    LogViewer,
    ContainerDetail,
    ActivityView,
    SettingsPanel,
    ContainerList,
  },
  data() {
    return {
      role: null,
      appVersion: null,
      hosts: [],
      selectedHostId: null,
      containers: [],
      stats: {},
      containersError: null,
      loadingContainers: false,
      pollTimer: null,
      actionInFlight: {},

      view: 'list', // 'list' | 'flow'
      stateFilter: 'all', // 'all' | 'running' | 'stopped'
      topology: { nodes: [], edges: [] },
      cy: null,
      edgeFilters: { dependsOn: true, network: true, manual: true },
      flowFilterText: '',
      edgeInfoText: null,
      flowFullscreen: false,
      flowMode: 'graph', // 'graph' | 'tree'
      treeShowNetworks: true,
      treeShowMounts: true,
      flowPillSelection: null, // id of a tapped proj:/net:/mount: pill in tree mode

      hostInfo: null,
      diskUsage: [],
      hostMetricsHistory: [],
      containerMetricsHistory: {},

      alerts: [],

      selectedContainerId: null,

      logViewerOpen: false,
      logViewerFullscreen: false,

      settingsOpen: false,
    };
  },
  computed: {
    isAdmin() {
      return this.role === 'admin';
    },
    filteredContainers() {
      if (this.stateFilter === 'running') return this.containers.filter((c) => c.state === 'running');
      if (this.stateFilter === 'stopped') return this.containers.filter((c) => c.state !== 'running');
      return this.containers;
    },
    groupedContainers() {
      const groups = {};
      for (const c of this.filteredContainers) {
        const key = c.composeProject || 'Ungrouped';
        (groups[key] ||= []).push(c);
      }
      return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    },
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
    selectedContainer() {
      return this.containers.find((c) => c.id === this.selectedContainerId) || null;
    },
    currentHostName() {
      const h = this.hosts.find((h) => h.id === this.selectedHostId);
      return h ? h.name : '';
    },
    openAlertsCount() {
      return this.alerts.filter((a) => !a.acknowledged).length;
    },
    containerMetricsView() {
      const out = {};
      for (const id of Object.keys(this.containerMetricsHistory)) {
        const arr = this.containerMetricsHistory[id];
        const cpu = arr.map((s) => s.cpu);
        const mem = arr.map((s) => s.mem);
        out[id] = {
          cpu,
          mem,
          cpuPeak: cpu.length ? Math.max(...cpu) : 0,
          memPeak: mem.length ? Math.max(...mem) : 0,
        };
      }
      return out;
    },
  },
  watch: {
    // Preview-stream/inspect state now lives entirely in ContainerDetail, keyed off its own
    // `container.id` watcher - this only needs to close the (sibling) log viewer and keep the
    // Flow view's cy selection in sync.
    selectedContainerId(newId) {
      this.closeLogViewer();
      if (this.cy) {
        this.cy.nodes().removeClass('selected');
        if (newId) this.cy.$id(newId).addClass('selected');
        if (this.view === 'flow') this.applyFlowFading();
      }
    },
    stateFilter() {
      if (this.view === 'flow') this.renderGraph();
    },
    flowFilterText() {
      if (this.view === 'flow') this.applyFlowFading();
    },
    edgeFilters: {
      deep: true,
      handler() {
        if (this.view === 'flow') this.renderGraph();
      },
    },
    treeShowNetworks() {
      if (this.view === 'flow' && this.flowMode === 'tree') this.renderGraph();
    },
    treeShowMounts() {
      if (this.view === 'flow' && this.flowMode === 'tree') this.renderGraph();
    },
  },
  async mounted() {
    try {
      const session = await apiGetSession();
      this.role = session.role;
      this.appVersion = session.version;
      await this.loadHosts();
    } catch {
      return;
    }
    if (this.hosts.length) {
      this.selectHost(this.hosts[0].id);
    }
  },
  beforeUnmount() {
    this.stopPolling();
    this.closeLogViewer();
    if (this.cy) this.cy.destroy();
  },
  methods: {
    async loadHosts() {
      this.hosts = await apiGetHosts();
    },
    selectHost(id) {
      this.selectedHostId = id;
      this.selectedContainerId = null;
      this.hostInfo = null;
      this.diskUsage = [];
      this.hostMetricsHistory = [];
      this.containerMetricsHistory = {};
      this.alerts = [];
      if (this.cy) {
        this.cy.destroy();
        this.cy = null;
      }
      this.edgeInfoText = null;
      this.flowPillSelection = null;
      this.flowMode = loadFlowMode(id);
      this.stopPolling();
      this.fetchHostInfo();
      this.fetchDiskUsage();
      this.refresh();
      this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    },
    stopPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    },
    async refresh() {
      await this.fetchContainers();
      await this.fetchStats();
      this.recordMetricsSample();
      await this.fetchHostMetricsHistory();
      await this.fetchAlerts();
      if (this.view === 'flow') await this.fetchTopology();
    },
    async fetchHostInfo() {
      if (!this.selectedHostId) return;
      try {
        this.hostInfo = await apiGetHostInfo(this.selectedHostId);
      } catch {
        /* host info is best-effort */
      }
    },
    async fetchDiskUsage() {
      if (!this.selectedHostId) return;
      try {
        this.diskUsage = await apiGetDiskUsage(this.selectedHostId);
      } catch {
        /* disk usage is best-effort */
      }
    },
    async fetchHostMetricsHistory() {
      if (!this.selectedHostId) return;
      try {
        const rows = await apiGetMetricsHistory(this.selectedHostId, { range: '1h' });
        this.hostMetricsHistory = rows.slice(-HOST_METRICS_HISTORY_LEN);
      } catch {
        /* history is best-effort */
      }
    },
    async fetchAlerts() {
      if (!this.selectedHostId) return;
      try {
        this.alerts = await apiGetAlerts(this.selectedHostId, 100);
      } catch {
        /* alerts are best-effort */
      }
    },
    async ackAlertAction(alert) {
      try {
        await apiAckAlert(alert.id);
        alert.acknowledged = 1;
      } catch {
        /* best-effort */
      }
    },
    recordMetricsSample() {
      const currentIds = new Set(this.containers.map((c) => c.id));
      for (const id of Object.keys(this.containerMetricsHistory)) {
        if (!currentIds.has(id)) delete this.containerMetricsHistory[id];
      }

      for (const c of this.containers) {
        if (c.state !== 'running') continue;
        const s = this.stats[c.id];
        if (!s) continue;
        const cpu = parseFloat(s.cpuPerc) || 0;
        const mem = parseMemUsedBytes(s.memUsage);

        const arr = this.containerMetricsHistory[c.id] || (this.containerMetricsHistory[c.id] = []);
        arr.push({ cpu, mem });
        if (arr.length > METRICS_HISTORY_LEN) arr.splice(0, arr.length - METRICS_HISTORY_LEN);
      }
    },
    async setView(v) {
      this.view = v;
      if (v !== 'flow') this.flowFullscreen = false;
      if (v === 'flow') await this.fetchTopology();
    },
    async fetchContainers() {
      if (!this.selectedHostId) return;
      this.loadingContainers = true;
      try {
        this.containers = await apiGetContainers(this.selectedHostId);
        this.containersError = null;
      } catch (err) {
        this.containersError = err.message;
      } finally {
        this.loadingContainers = false;
      }
    },
    async fetchStats() {
      if (!this.selectedHostId) return;
      try {
        this.stats = await apiGetStats(this.selectedHostId);
      } catch {
        /* stats are best-effort */
      }
    },
    async fetchTopology() {
      if (!this.selectedHostId) return;
      try {
        this.topology = await apiGetTopology(this.selectedHostId);
        await this.$nextTick();
        this.renderGraph();
      } catch {
        /* topology is best-effort */
      }
    },
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
        updateGraph(this.cy, elements, this.selectedHostId);
      } else {
        this.cy = createGraph(
          this.$refs.cy,
          elements,
          (id) => this.selectContainerById(id),
          (edgeData) => this.showEdgeInfo(edgeData),
          this.selectedHostId,
          this.flowMode
        );
      }
      this.applyFlowFading();
    },
    applyFlowFading() {
      if (this.cy)
        applyFading(this.cy, { selectedId: this.selectedContainerId || this.flowPillSelection, filterText: this.flowFilterText });
    },
    setFlowMode(mode) {
      if (this.flowMode === mode) return;
      this.flowMode = mode;
      saveFlowMode(this.selectedHostId, mode);
      this.flowPillSelection = null;
      this.edgeInfoText = null;
      if (this.cy) {
        this.cy.destroy();
        this.cy = null;
      }
      this.renderGraph();
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
        if (this.flowPillSelection) {
          this.flowPillSelection = null;
          this.applyFlowFading();
        }
        return;
      }
      const nameOf = (id) => this.topology.nodes.find((n) => n.id === id)?.name || id;
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
    collapseAllFlowGroups() {
      collapseAllGroups(this.cy);
    },
    expandAllFlowGroups() {
      expandAllGroups(this.cy);
    },
    async toggleFlowFullscreen() {
      this.flowFullscreen = !this.flowFullscreen;
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
      resetView(this.cy, this.selectedHostId);
    },
    async doAction(container, action) {
      this.actionInFlight = { ...this.actionInFlight, [container.id]: action };
      try {
        await apiContainerAction(this.selectedHostId, container.id, action);
        await this.fetchContainers();
      } catch (err) {
        this.containersError = `${action} failed: ${err.message}`;
      } finally {
        const next = { ...this.actionInFlight };
        delete next[container.id];
        this.actionInFlight = next;
      }
    },
    selectContainerById(id) {
      this.settingsOpen = false;
      // A tapped tree-mode pill isn't a real container - routing it into selectedContainerId
      // would trip the watcher below into opening a log preview / fetching docker inspect for a
      // fake id like "net:app-net". Kept in its own field instead, purely for fading + infobar.
      if (id.startsWith('proj:') || id.startsWith('net:') || id.startsWith('mount:')) {
        this.selectedContainerId = null;
        this.flowPillSelection = this.flowPillSelection === id ? null : id;
        if (this.flowPillSelection) this.showPillInfo(id);
        else this.edgeInfoText = null;
        this.applyFlowFading();
        return;
      }
      this.flowPillSelection = null;
      this.selectedContainerId = this.selectedContainerId === id ? null : id;
    },
    async openLogsFor(id) {
      this.settingsOpen = false;
      this.selectedContainerId = id;
      // The selectedContainerId watcher closes the log viewer as part of resetting log state for
      // the new container - wait for that to settle before opening it, or it immediately clobbers
      // the logViewerOpen flag we're about to set.
      await this.$nextTick();
      await this.openLogViewer();
    },
    closeDetail() {
      this.selectedContainerId = null;
    },
    openLogViewer() {
      if (!this.selectedContainerId) return;
      this.logViewerOpen = true;
    },
    closeLogViewer() {
      this.logViewerOpen = false;
      this.logViewerFullscreen = false;
    },
    async logout() {
      await apiLogout();
      window.location.href = '/login';
    },
    openSettings() {
      // Both panels are fixed to the same right-hand 520px slot - only one at a time makes sense.
      this.selectedContainerId = null;
      this.settingsOpen = true;
    },
    closeSettings() {
      this.settingsOpen = false;
    },
  },
  template: `
    <div class="app">
      <header class="topbar">
        <h1><img src="/assets/logo.svg" alt="" class="brand-logo" /><span class="brand-name"><span class="brand-open">Open</span><span class="brand-dock">Dock</span><span class="brand-watch">Watch</span></span><span v-if="appVersion" class="brand-version">v{{ appVersion }}</span></h1>
        <select v-model="selectedHostId" @change="selectHost(selectedHostId)">
          <option v-for="h in hosts" :key="h.id" :value="h.id">
            {{ h.name }} {{ h.reachable ? '' : '(unreachable)' }}
          </option>
        </select>
        <div class="view-toggle">
          <button :class="{active: view==='list'}" @click="setView('list')">List</button>
          <button :class="{active: view==='flow'}" @click="setView('flow')">Flow</button>
          <button :class="{active: view==='activity'}" @click="setView('activity')">
            Activity <span v-if="openAlertsCount" class="alert-count-badge">{{ openAlertsCount }}</span>
          </button>
        </div>
        <div class="view-toggle">
          <button :class="{active: stateFilter==='all'}" @click="stateFilter='all'">All</button>
          <button :class="{active: stateFilter==='running'}" @click="stateFilter='running'">Running</button>
          <button :class="{active: stateFilter==='stopped'}" @click="stateFilter='stopped'">Stopped</button>
        </div>
        <span v-if="!isAdmin" class="readonly-badge" title="Read-only account - no start/stop/restart access">Read-only</span>
        <button v-if="isAdmin" class="settings-btn" @click="openSettings" title="Alert webhook settings">⚙ Settings</button>
        <button class="logout-btn" @click="logout">Logout</button>
      </header>

      <p v-if="containersError" class="error">{{ containersError }}</p>

      <host-card
        v-if="hostInfo && !logViewerFullscreen && !flowFullscreen"
        :host-info="hostInfo"
        :host-name="currentHostName"
        :metrics-history="hostMetricsHistory"
        :disk-usage="diskUsage"
        :with-detail="!!selectedContainer || settingsOpen"
      ></host-card>

      <div v-show="!logViewerFullscreen" class="layout" :class="{ 'with-detail': !!selectedContainer || settingsOpen }">
        <div class="main">
          <div v-show="view === 'list'">
            <container-list
              :grouped-containers="groupedContainers"
              :stats="stats"
              :metrics-view="containerMetricsView"
              :action-in-flight="actionInFlight"
              :selected-container-id="selectedContainerId"
              :is-admin="isAdmin"
              @select="selectContainerById"
              @action="doAction"
              @open-logs="openLogsFor"
            ></container-list>
            <p v-if="!loadingContainers && !containers.length" class="muted">No containers found.</p>
          </div>

          <div v-show="view === 'flow'" class="cy-wrap" :class="{ 'cy-fullscreen': flowFullscreen }">
            <button
              class="cy-fullscreen-btn"
              @click="toggleFlowFullscreen"
              :title="flowFullscreen ? 'Exit fullscreen' : 'Fullscreen - hide the host stats so the graph gets more room'"
            >
              {{ flowFullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen' }}
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
                <button @click="collapseAllFlowGroups">Collapse all</button>
                <button @click="expandAllFlowGroups">Expand all</button>
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

          <activity-view v-if="view === 'activity'" :host-id="selectedHostId" :alerts="alerts" @ack="ackAlertAction"></activity-view>
        </div>

        <container-detail
          v-if="selectedContainer"
          :container="selectedContainer"
          :stats="stats"
          :host-id="selectedHostId"
          :is-admin="isAdmin"
          :action-in-flight="actionInFlight"
          @close="closeDetail"
          @action="doAction"
          @open-log-viewer="openLogViewer"
        ></container-detail>
      </div>

      <log-viewer
        v-if="logViewerOpen"
        :host-id="selectedHostId"
        :container-id="selectedContainerId"
        :container-name="selectedContainer ? selectedContainer.name : ''"
        :with-detail="!!selectedContainer"
        v-model:fullscreen="logViewerFullscreen"
        @close="closeLogViewer"
      ></log-viewer>

      <settings-panel v-if="settingsOpen" @close="closeSettings" @hosts-changed="loadHosts"></settings-panel>
    </div>
  `,
}).mount('#app');
