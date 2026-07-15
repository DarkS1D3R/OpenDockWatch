import { POLL_MS, MAX_LOG_LINES, PREVIEW_TAIL, METRICS_HISTORY_LEN, HOST_METRICS_HISTORY_LEN, MAX_ACTIVITY_EVENTS } from './constants.js';
import {
  parseMemUsedBytes,
  formatGB,
  formatRatePair,
  healthColor,
  healthLabel,
  detectLogLevel,
  highlightLine,
  stripAnsi,
} from './format.js';
import {
  apiGetHosts,
  apiGetContainers,
  apiGetStats,
  apiGetTopology,
  apiGetHostInfo,
  apiContainerAction,
  apiGetContainerInspect,
  logsUrl,
  downloadLogsUrl,
  apiLogout,
  apiGetSession,
  apiGetDiskUsage,
  apiGetMetricsHistory,
  apiGetEvents,
  eventsStreamUrl,
  apiGetAlerts,
  apiAckAlert,
  apiGetWebhookConfig,
  apiSaveWebhookConfig,
  apiClearWebhookConfig,
  apiTestWebhook,
  apiGetThresholdConfig,
  apiSaveThresholdConfig,
  apiClearThresholdConfig,
  apiGetHostsConfig,
  apiAddHost,
  apiUpdateHost,
  apiDeleteHost,
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
      collapsedGroups: {},

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
      alertSearch: '',
      activityEvents: [],
      eventSearch: '',
      activityEventSource: null,
      alertsAtTop: true,
      eventsAtTop: true,

      selectedContainerId: null,
      containerInspect: null,
      previewLogLines: [],
      previewEventSource: null,
      previewAtBottom: true,
      previewLoading: false,

      logViewerOpen: false,
      logViewerTail: 200,
      logViewerFilter: '',
      logViewerRegexMode: false,
      logViewerLevels: { error: true, warn: true, info: true, debug: true },
      logViewerLines: [],
      logViewerEventSource: null,
      logViewerAtBottom: true,
      logViewerLoading: false,
      logViewerFullscreen: false,
      logViewerShowTimestamps: true,

      settingsOpen: false,
      webhookUrl: '',
      webhookFormat: '',
      webhookOverridden: false,
      webhookSaving: false,
      webhookTesting: false,
      webhookError: null,
      webhookStatus: null,

      thresholds: { cpuThreshold: 0, memThreshold: 0, sustainMinutes: 5, diskThresholdGb: 0 },
      thresholdsOverridden: false,
      thresholdsSaving: false,
      thresholdsError: null,
      thresholdsStatus: null,

      settingsHosts: [],
      newHost: { id: '', name: '', dockerHost: '' },
      hostsSaving: false,
      hostsError: null,
      hostsStatus: null,
      editingHostId: null,
      editHostDraft: { name: '', dockerHost: '' },
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
    cpuSamples() {
      return this.hostMetricsHistory.map((s) => s.cpuPercent);
    },
    memSamples() {
      return this.hostMetricsHistory.map((s) => s.memUsedBytes);
    },
    openAlertsCount() {
      return this.alerts.filter((a) => !a.acknowledged).length;
    },
    searchedAlerts() {
      const q = this.alertSearch.trim().toLowerCase();
      if (!q) return this.alerts;
      return this.alerts.filter(
        (a) =>
          (a.rule || '').toLowerCase().includes(q) ||
          (a.message || '').toLowerCase().includes(q) ||
          (a.containerName || '').toLowerCase().includes(q)
      );
    },
    searchedActivityEvents() {
      const q = this.eventSearch.trim().toLowerCase();
      if (!q) return this.activityEvents;
      return this.activityEvents.filter(
        (e) => (e.containerName || e.containerId || '').toLowerCase().includes(q) || (e.action || '').toLowerCase().includes(q)
      );
    },
    cpuChartSlots() {
      const pad = HOST_METRICS_HISTORY_LEN - this.cpuSamples.length;
      return pad > 0 ? [...Array(pad).fill(null), ...this.cpuSamples] : this.cpuSamples;
    },
    memChartSlots() {
      const pad = HOST_METRICS_HISTORY_LEN - this.memSamples.length;
      return pad > 0 ? [...Array(pad).fill(null), ...this.memSamples] : this.memSamples;
    },
    cpuNow() {
      return this.cpuSamples.length ? this.cpuSamples[this.cpuSamples.length - 1] : 0;
    },
    cpuAvg() {
      return this.cpuSamples.length ? this.cpuSamples.reduce((a, b) => a + b, 0) / this.cpuSamples.length : 0;
    },
    cpuPeak() {
      return this.cpuSamples.length ? Math.max(...this.cpuSamples) : 0;
    },
    memNow() {
      return this.memSamples.length ? this.memSamples[this.memSamples.length - 1] : 0;
    },
    memAvg() {
      return this.memSamples.length ? this.memSamples.reduce((a, b) => a + b, 0) / this.memSamples.length : 0;
    },
    memPeak() {
      return this.memSamples.length ? Math.max(...this.memSamples) : 0;
    },
    // Host-total figures - real host-wide CPU/mem (every process, not just this app's
    // containers), local-host-only (null fields for a remote SSH host) - see hostUsage.js. Pulled
    // from the same hostMetricsHistory rows the Docker cpuSamples/memSamples above already use
    // (metricsCollector writes both into the same host_metrics row every poll), rather than a
    // separate client-side buffer - that was tried first, but since it had no server-persisted
    // history, a page refresh emptied it while the Docker numbers reloaded instantly from the DB,
    // and its samples were positioned by stretching whatever few points existed across the full
    // width each poll rather than a fixed per-slot position, which reflowed/reshuffled the whole
    // line every 5s instead of extending it. Deriving from hostMetricsHistory fixes both: same
    // persisted history behavior as Docker's own numbers, and the same fixed-slot positioning via
    // hostCpuChartSlots/hostMemChartSlots below.
    hostSystemUsage() {
      const last = this.hostMetricsHistory[this.hostMetricsHistory.length - 1];
      return last && last.systemMemTotalBytes != null
        ? { cpuPercent: last.systemCpuPercent, memUsedBytes: last.systemMemUsedBytes, memTotalBytes: last.systemMemTotalBytes }
        : null;
    },
    // Host-total sparklines - drawn as a lighter/lower-opacity layer behind the Docker ones
    // below, sharing the same peak (sharedCpuPeak/sharedMemPeak) as the Docker line so the two
    // are on one common y-axis - the host total (e.g. 0.9 GB) should actually sit visibly higher
    // than Docker's own figure (e.g. 0.1 GB) when it really is ~9x larger, not end up looking
    // similarly-tall because each was independently normalized to its own tiny range.
    hostCpuSamples() {
      return this.hostMetricsHistory.map((s) => s.systemCpuPercent);
    },
    hostMemSamples() {
      return this.hostMetricsHistory.map((s) => s.systemMemUsedBytes);
    },
    hostCpuChartSlots() {
      const pad = HOST_METRICS_HISTORY_LEN - this.hostCpuSamples.length;
      return pad > 0 ? [...Array(pad).fill(null), ...this.hostCpuSamples] : this.hostCpuSamples;
    },
    hostMemChartSlots() {
      const pad = HOST_METRICS_HISTORY_LEN - this.hostMemSamples.length;
      return pad > 0 ? [...Array(pad).fill(null), ...this.hostMemSamples] : this.hostMemSamples;
    },
    hostCpuPeak() {
      return this.hostCpuSamples.length ? Math.max(...this.hostCpuSamples) : 0;
    },
    hostMemPeak() {
      return this.hostMemSamples.length ? Math.max(...this.hostMemSamples) : 0;
    },
    sharedCpuPeak() {
      return Math.max(this.cpuPeak, this.hostCpuPeak);
    },
    sharedMemPeak() {
      return Math.max(this.memPeak, this.hostMemPeak);
    },
    cpuSparkPaths() {
      return this.sparkPaths(this.cpuChartSlots, this.sharedCpuPeak);
    },
    memSparkPaths() {
      return this.sparkPaths(this.memChartSlots, this.sharedMemPeak);
    },
    hostCpuSparkPaths() {
      return this.sparkPaths(this.hostCpuChartSlots, this.sharedCpuPeak);
    },
    hostMemSparkPaths() {
      return this.sparkPaths(this.hostMemChartSlots, this.sharedMemPeak);
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
    logViewerTestRegex() {
      if (!this.logViewerRegexMode) return null;
      const pattern = this.logViewerFilter.trim();
      if (!pattern) return null;
      try {
        return new RegExp(pattern, 'i');
      } catch {
        return null;
      }
    },
    logViewerRegexError() {
      if (!this.logViewerRegexMode || !this.logViewerFilter.trim()) return null;
      return this.logViewerTestRegex ? null : 'Invalid regex';
    },
    filteredLogViewerLines() {
      const filterText = this.logViewerFilter.trim();
      const filterLower = filterText.toLowerCase();
      const regexMode = this.logViewerRegexMode;
      const testRegex = this.logViewerTestRegex;
      return this.logViewerLines
        .filter((line) => {
          const level = detectLogLevel(stripAnsi(line.text));
          if (level && !this.logViewerLevels[level]) return false;
          if (!filterText) return true;
          if (regexMode) return testRegex ? testRegex.test(line.text) : true;
          return line.text.toLowerCase().includes(filterLower);
        })
        .map((line) => ({ id: line.id, html: highlightLine(line.text, filterText, regexMode && !!testRegex) }));
    },
  },
  watch: {
    selectedContainerId(newId) {
      this.closePreviewStream();
      this.closeLogViewer();
      this.previewLogLines = [];
      this._previewBuffer = [];
      this._previewFlushPending = false;
      this.previewLoading = false;
      if (this.cy) {
        this.cy.nodes().removeClass('selected');
        if (newId) this.cy.$id(newId).addClass('selected');
        if (this.view === 'flow') this.applyFlowFading();
      }
      this.containerInspect = null;
      if (newId) {
        this.openPreviewStream(newId);
        this.fetchContainerInspect(newId);
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
  created() {
    // Plain (non-reactive) buffers for batching high-volume log streams - see
    // queuePreviewLine/queueLogViewerLine. Keeping these off the reactive `data()`
    // object avoids Vue tracking every push into them.
    this._previewBuffer = [];
    this._previewFlushPending = false;
    this._previewNextId = 0;
    this._previewLoadingTimer = null;
    this._logViewerBuffer = [];
    this._logViewerFlushPending = false;
    this._logViewerNextId = 0;
    this._logViewerLoadingTimer = null;
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
    this.closePreviewStream();
    this.closeLogViewer();
    this.closeActivityStream();
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
      this.closeActivityStream();
      this.activityEvents = [];
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
      if (this.view === 'activity') this.enterActivityView();
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
    diskRow(type) {
      return this.diskUsage.find((r) => r.type === type) || null;
    },
    sparkPaths(slots, peak) {
      const w = 100;
      const h = 30;
      const topPad = 3;
      const usable = h - topPad;
      const n = slots.length;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const v = slots[i];
        if (v === null) continue;
        const x = n > 1 ? (i / (n - 1)) * w : w;
        const y = peak ? topPad + usable - (v / peak) * usable : h;
        pts.push([x, y]);
      }
      if (!pts.length) return { line: '', area: '', dot: null };
      const line = 'M' + pts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' L');
      const first = pts[0];
      const last = pts[pts.length - 1];
      const area = `${line} L${last[0].toFixed(2)},${h} L${first[0].toFixed(2)},${h} Z`;
      return { line, area, dot: { x: last[0], y: last[1] } };
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
      if (v === 'flow') {
        await this.fetchTopology();
      } else if (v === 'activity') {
        await this.enterActivityView();
      } else {
        this.closeActivityStream();
      }
    },
    async enterActivityView() {
      if (!this.selectedHostId) return;
      try {
        this.activityEvents = await apiGetEvents(this.selectedHostId, { limit: 200 });
      } catch {
        /* events are best-effort */
      }
      this.openActivityStream();
    },
    openActivityStream() {
      this.closeActivityStream();
      this.activityEventSource = new EventSource(eventsStreamUrl(this.selectedHostId));
      this.activityEventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          this.activityEvents.unshift(event);
          if (this.activityEvents.length > MAX_ACTIVITY_EVENTS) this.activityEvents.length = MAX_ACTIVITY_EVENTS;
        } catch {
          /* ignore malformed event */
        }
      };
    },
    closeActivityStream() {
      if (this.activityEventSource) {
        this.activityEventSource.close();
        this.activityEventSource = null;
      }
    },
    formatEventTime(ts) {
      return new Date(ts).toLocaleTimeString();
    },
    onAlertsScroll() {
      const el = this.$refs.alertsListView;
      if (el) this.alertsAtTop = el.scrollTop < 40;
    },
    scrollAlertsToTop() {
      const el = this.$refs.alertsListView;
      if (el) el.scrollTop = 0;
      this.alertsAtTop = true;
    },
    onEventsScroll() {
      const el = this.$refs.eventsListView;
      if (el) this.eventsAtTop = el.scrollTop < 40;
    },
    scrollEventsToTop() {
      const el = this.$refs.eventsListView;
      if (el) el.scrollTop = 0;
      this.eventsAtTop = true;
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
    async fetchContainerInspect(id) {
      if (!this.selectedHostId) return;
      try {
        const inspect = await apiGetContainerInspect(this.selectedHostId, id);
        // The user may have clicked a different container (or closed the panel) before this
        // resolved - only apply it if it's still the one being looked at.
        if (this.selectedContainerId === id) this.containerInspect = inspect;
      } catch {
        /* inspect details are best-effort */
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
    openPreviewStream(id) {
      this.previewAtBottom = true;
      this.previewLoading = true;
      this._previewBuffer = [];
      clearTimeout(this._previewLoadingTimer);
      // A container with no log output at all would otherwise never clear the
      // spinner, since that only happens once a line actually arrives.
      this._previewLoadingTimer = setTimeout(() => {
        this.previewLoading = false;
      }, 2000);
      this.previewEventSource = new EventSource(logsUrl(this.selectedHostId, id, PREVIEW_TAIL));
      this.previewEventSource.onmessage = (e) => {
        this.queuePreviewLine(e.data);
      };
      this.previewEventSource.onerror = () => {
        this.queuePreviewLine('[opendockwatch] log stream disconnected');
      };
    },
    closePreviewStream() {
      clearTimeout(this._previewLoadingTimer);
      if (this.previewEventSource) {
        this.previewEventSource.close();
        this.previewEventSource = null;
      }
    },
    // Log lines can arrive in a fast burst (e.g. a large tail on open), and each one
    // used to trigger its own reactive push + array-splice + render. On a big backlog
    // that was thousands of full-list re-renders in a row and froze the tab. Buffering
    // them and flushing once per animation frame turns that into a handful of renders.
    queuePreviewLine(text) {
      this._previewBuffer.push(text);
      if (this._previewFlushPending) return;
      this._previewFlushPending = true;
      requestAnimationFrame(() => this.flushPreviewLines());
    },
    flushPreviewLines() {
      this._previewFlushPending = false;
      const lines = this._previewBuffer;
      this._previewBuffer = [];
      if (!lines.length) return;
      for (const text of lines) this.previewLogLines.push({ id: this._previewNextId++, text });
      if (this.previewLogLines.length > MAX_LOG_LINES) {
        this.previewLogLines.splice(0, this.previewLogLines.length - MAX_LOG_LINES);
      }
      clearTimeout(this._previewLoadingTimer);
      this.previewLoading = false;
      if (this.previewAtBottom) {
        this.$nextTick(() => {
          const el = this.$refs.previewLogView;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    },
    onPreviewScroll() {
      const el = this.$refs.previewLogView;
      if (el) this.previewAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
    scrollPreviewToBottom() {
      this.previewAtBottom = true;
      const el = this.$refs.previewLogView;
      if (el) el.scrollTop = el.scrollHeight;
    },
    formatPreviewLine(text) {
      return highlightLine(text, '', false);
    },
    async openLogViewer() {
      if (!this.selectedContainerId) return;
      this.logViewerOpen = true;
      this.startLogViewerStream();
      await this.$nextTick();
      this.$refs.logPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    closeLogViewer() {
      this.logViewerOpen = false;
      this.logViewerFullscreen = false;
      clearTimeout(this._logViewerLoadingTimer);
      if (this.logViewerEventSource) {
        this.logViewerEventSource.close();
        this.logViewerEventSource = null;
      }
      this.logViewerLines = [];
      this._logViewerBuffer = [];
      this._logViewerFlushPending = false;
      this.logViewerLoading = false;
    },
    startLogViewerStream() {
      if (!this.selectedContainerId) return;
      if (this.logViewerEventSource) this.logViewerEventSource.close();
      this.logViewerLines = [];
      this._logViewerBuffer = [];
      this._logViewerNextId = 0;
      this.logViewerAtBottom = true;
      this.logViewerLoading = true;
      clearTimeout(this._logViewerLoadingTimer);
      this._logViewerLoadingTimer = setTimeout(() => {
        this.logViewerLoading = false;
      }, 2000);
      this.logViewerEventSource = new EventSource(logsUrl(this.selectedHostId, this.selectedContainerId, this.logViewerTail));
      this.logViewerEventSource.onmessage = (e) => {
        this.queueLogViewerLine(e.data);
      };
      this.logViewerEventSource.onerror = () => {
        this.queueLogViewerLine('[opendockwatch] log stream disconnected');
      };
    },
    queueLogViewerLine(text) {
      this._logViewerBuffer.push(text);
      if (this._logViewerFlushPending) return;
      this._logViewerFlushPending = true;
      requestAnimationFrame(() => this.flushLogViewerLines());
    },
    flushLogViewerLines() {
      this._logViewerFlushPending = false;
      const lines = this._logViewerBuffer;
      this._logViewerBuffer = [];
      if (!lines.length) return;
      for (const text of lines) this.logViewerLines.push({ id: this._logViewerNextId++, text });
      if (this.logViewerLines.length > MAX_LOG_LINES) {
        this.logViewerLines.splice(0, this.logViewerLines.length - MAX_LOG_LINES);
      }
      clearTimeout(this._logViewerLoadingTimer);
      this.logViewerLoading = false;
      if (this.logViewerAtBottom) {
        this.$nextTick(() => {
          const el = this.$refs.logViewerLogView;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    },
    changeLogViewerTail(newTail) {
      this.logViewerTail = newTail;
      this.startLogViewerStream();
    },
    downloadLogs() {
      if (!this.selectedContainerId) return;
      window.location.href = downloadLogsUrl(this.selectedHostId, this.selectedContainerId, this.logViewerTail);
    },
    onLogViewerScroll() {
      const el = this.$refs.logViewerLogView;
      if (el) this.logViewerAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
    scrollLogViewerToBottom() {
      this.logViewerAtBottom = true;
      const el = this.$refs.logViewerLogView;
      if (el) el.scrollTop = el.scrollHeight;
    },
    toggleLevel(level) {
      this.logViewerLevels = { ...this.logViewerLevels, [level]: !this.logViewerLevels[level] };
    },
    toggleGroup(name) {
      this.collapsedGroups = { ...this.collapsedGroups, [name]: !this.collapsedGroups[name] };
    },
    statFor(id) {
      return this.stats[id] || {};
    },
    metricsFor(id) {
      return this.containerMetricsView[id] || { cpu: [], mem: [], cpuPeak: 0, memPeak: 0 };
    },
    fmtGB(bytes) {
      return formatGB(bytes || 0);
    },
    fmtRatePair(a, b) {
      return formatRatePair(a, b);
    },
    fmtCreated(iso) {
      return iso ? new Date(iso).toLocaleString() : '—';
    },
    fmtRestartPolicy(inspect) {
      if (!inspect || !inspect.restartPolicy) return '—';
      const labels = { no: 'No', always: 'Always', 'unless-stopped': 'Unless stopped', 'on-failure': 'On failure' };
      const label = labels[inspect.restartPolicy] || inspect.restartPolicy;
      return inspect.restartPolicy === 'on-failure' && inspect.restartMaxRetries ? `${label} (max ${inspect.restartMaxRetries})` : label;
    },
    healthDotColor(health) {
      return healthColor(health);
    },
    healthTitle(health) {
      return healthLabel(health);
    },
    stateClass(container) {
      return container.state === 'running' ? 'state-running' : 'state-stopped';
    },
    async logout() {
      await apiLogout();
      window.location.href = '/login';
    },
    async openSettings() {
      // Both panels are fixed to the same right-hand 520px slot - only one at a time makes sense.
      this.selectedContainerId = null;
      this.settingsOpen = true;
      this.webhookError = null;
      this.webhookStatus = null;
      this.thresholdsError = null;
      this.thresholdsStatus = null;
      try {
        const config = await apiGetWebhookConfig();
        this.webhookUrl = config.url;
        this.webhookFormat = config.format;
        this.webhookOverridden = config.overridden;
      } catch (err) {
        this.webhookError = err.message;
      }
      try {
        const config = await apiGetThresholdConfig();
        this.thresholds = config;
        this.thresholdsOverridden = config.overridden;
      } catch (err) {
        this.thresholdsError = err.message;
      }
      this.hostsError = null;
      this.hostsStatus = null;
      this.editingHostId = null;
      this.newHost = { id: '', name: '', dockerHost: '' };
      try {
        this.settingsHosts = await apiGetHostsConfig();
      } catch (err) {
        this.hostsError = err.message;
      }
    },
    closeSettings() {
      this.settingsOpen = false;
    },
    async saveWebhookConfig() {
      this.webhookSaving = true;
      this.webhookError = null;
      this.webhookStatus = null;
      try {
        const config = await apiSaveWebhookConfig(this.webhookUrl, this.webhookFormat);
        this.webhookOverridden = config.overridden;
        this.webhookStatus = 'Saved.';
      } catch (err) {
        this.webhookError = err.message;
      } finally {
        this.webhookSaving = false;
      }
    },
    async clearWebhookConfig() {
      this.webhookSaving = true;
      this.webhookError = null;
      this.webhookStatus = null;
      try {
        const config = await apiClearWebhookConfig();
        this.webhookUrl = config.url;
        this.webhookFormat = config.format;
        this.webhookOverridden = config.overridden;
        this.webhookStatus = 'Cleared - using the .env default.';
      } catch (err) {
        this.webhookError = err.message;
      } finally {
        this.webhookSaving = false;
      }
    },
    async testWebhook() {
      this.webhookTesting = true;
      this.webhookError = null;
      this.webhookStatus = null;
      try {
        await apiTestWebhook();
        this.webhookStatus = 'Test alert sent.';
      } catch (err) {
        this.webhookError = err.message;
      } finally {
        this.webhookTesting = false;
      }
    },
    async saveThresholds() {
      this.thresholdsSaving = true;
      this.thresholdsError = null;
      this.thresholdsStatus = null;
      try {
        const config = await apiSaveThresholdConfig(this.thresholds);
        this.thresholds = config;
        this.thresholdsOverridden = config.overridden;
        this.thresholdsStatus = 'Saved.';
      } catch (err) {
        this.thresholdsError = err.message;
      } finally {
        this.thresholdsSaving = false;
      }
    },
    async clearThresholds() {
      this.thresholdsSaving = true;
      this.thresholdsError = null;
      this.thresholdsStatus = null;
      try {
        const config = await apiClearThresholdConfig();
        this.thresholds = config;
        this.thresholdsOverridden = config.overridden;
        this.thresholdsStatus = 'Cleared - using the .env default.';
      } catch (err) {
        this.thresholdsError = err.message;
      } finally {
        this.thresholdsSaving = false;
      }
    },
    async addHost() {
      this.hostsSaving = true;
      this.hostsError = null;
      this.hostsStatus = null;
      try {
        this.settingsHosts = await apiAddHost(this.newHost);
        this.newHost = { id: '', name: '', dockerHost: '' };
        this.hostsStatus = 'Host added.';
        await this.loadHosts();
      } catch (err) {
        this.hostsError = err.message;
      } finally {
        this.hostsSaving = false;
      }
    },
    startEditHost(host) {
      this.editingHostId = host.id;
      this.editHostDraft = { name: host.name || '', dockerHost: host.dockerHost || '' };
      this.hostsError = null;
      this.hostsStatus = null;
    },
    cancelEditHost() {
      this.editingHostId = null;
    },
    async saveEditHost(id) {
      this.hostsSaving = true;
      this.hostsError = null;
      this.hostsStatus = null;
      try {
        this.settingsHosts = await apiUpdateHost(id, this.editHostDraft);
        this.editingHostId = null;
        this.hostsStatus = 'Host updated.';
        await this.loadHosts();
      } catch (err) {
        this.hostsError = err.message;
      } finally {
        this.hostsSaving = false;
      }
    },
    async removeHost(id) {
      this.hostsSaving = true;
      this.hostsError = null;
      this.hostsStatus = null;
      try {
        this.settingsHosts = await apiDeleteHost(id);
        this.hostsStatus = 'Host removed.';
        await this.loadHosts();
      } catch (err) {
        this.hostsError = err.message;
      } finally {
        this.hostsSaving = false;
      }
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

      <div v-if="hostInfo && !logViewerFullscreen && !flowFullscreen" class="host-card" :class="{ 'with-detail': !!selectedContainer || settingsOpen }">
        <div class="host-card-header">
          <span class="host-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="6" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="2" y="11" width="16" height="6" rx="1.5" stroke="currentColor" stroke-width="1.6"/><circle cx="5.5" cy="6" r="1" fill="currentColor"/><circle cx="5.5" cy="14" r="1" fill="currentColor"/></svg></span>
          <strong>{{ currentHostName }}</strong>
          <span class="host-card-meta">
            <span class="meta-item"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2.5 17 6.5V13.5L10 17.5 3 13.5V6.5L10 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 6.5 10 10.5 17 6.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 10.5V17.5" stroke="currentColor" stroke-width="1.6"/></svg> {{ hostInfo.containers }} containers</span>
            <span class="meta-item"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h7l7 7-7 7-7-7V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.7" cy="6.7" r="1.3" fill="currentColor"/></svg> {{ hostInfo.serverVersion }}</span>
          </span>
        </div>
        <div class="host-tiles">
          <div class="host-tile">
            <div class="host-tile-label"><span class="tile-icon tile-icon-cpu"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="8.5" width="3" height="3" fill="currentColor"/><path d="M7 2v2M10 2v2M13 2v2M7 16v2M10 16v2M13 16v2M2 7h2M2 10h2M2 13h2M16 7h2M16 10h2M16 13h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span> {{ hostInfo.ncpu }} CPU</div>
            <div class="host-tile-value">{{ cpuNow.toFixed(1) }}%</div>
            <div class="host-tile-sub">avg {{ cpuAvg.toFixed(1) }}% &bull; pk {{ cpuPeak.toFixed(1) }}%</div>
            <div v-if="hostSystemUsage" class="host-tile-system">
              host total: {{ hostSystemUsage.cpuPercent != null ? hostSystemUsage.cpuPercent.toFixed(1) + '%' : '—' }}
            </div>
            <div class="sparkline">
              <svg class="spark-svg" viewBox="0 0 100 30" preserveAspectRatio="none">
                <path v-if="hostSystemUsage" class="spark-area spark-area-cpu-host" :d="hostCpuSparkPaths.area"></path>
                <path v-if="hostSystemUsage" class="spark-line spark-line-cpu-host" :d="hostCpuSparkPaths.line" vector-effect="non-scaling-stroke"></path>
                <path class="spark-area spark-area-cpu" :d="cpuSparkPaths.area"></path>
                <path class="spark-line spark-line-cpu" :d="cpuSparkPaths.line" vector-effect="non-scaling-stroke"></path>
              </svg>
              <span
                v-if="cpuSparkPaths.dot"
                class="spark-dot spark-dot-cpu"
                :style="{ left: cpuSparkPaths.dot.x + '%', top: (cpuSparkPaths.dot.y / 30 * 100) + '%' }"
                :title="cpuNow.toFixed(1) + '%'"
              ></span>
            </div>
            <p v-if="hostSystemUsage" class="muted legend host-usage-legend">
              <span class="legend-item"><span class="bar-swatch bar-swatch-cpu"></span> Docker</span>
              <span class="legend-item"><span class="bar-swatch bar-swatch-cpu-host"></span> host total</span>
            </p>
          </div>
          <div class="host-tile">
            <div class="host-tile-label"><span class="tile-icon tile-icon-mem"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="16" height="8" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M5 7V4.5M8 7V4.5M11 7V4.5M14 7V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span> {{ fmtGB(hostInfo.memTotalBytes) }}</div>
            <div class="host-tile-value">{{ fmtGB(memNow) }}</div>
            <div class="host-tile-sub">avg {{ fmtGB(memAvg) }} &bull; pk {{ fmtGB(memPeak) }}</div>
            <div v-if="hostSystemUsage" class="host-tile-system">
              host total: {{ fmtGB(hostSystemUsage.memUsedBytes) }} / {{ fmtGB(hostSystemUsage.memTotalBytes) }}
            </div>
            <div class="sparkline">
              <svg class="spark-svg" viewBox="0 0 100 30" preserveAspectRatio="none">
                <path v-if="hostSystemUsage" class="spark-area spark-area-mem-host" :d="hostMemSparkPaths.area"></path>
                <path v-if="hostSystemUsage" class="spark-line spark-line-mem-host" :d="hostMemSparkPaths.line" vector-effect="non-scaling-stroke"></path>
                <path class="spark-area spark-area-mem" :d="memSparkPaths.area"></path>
                <path class="spark-line spark-line-mem" :d="memSparkPaths.line" vector-effect="non-scaling-stroke"></path>
              </svg>
              <span
                v-if="memSparkPaths.dot"
                class="spark-dot spark-dot-mem"
                :style="{ left: memSparkPaths.dot.x + '%', top: (memSparkPaths.dot.y / 30 * 100) + '%' }"
                :title="fmtGB(memNow)"
              ></span>
            </div>
            <p v-if="hostSystemUsage" class="muted legend host-usage-legend">
              <span class="legend-item"><span class="bar-swatch bar-swatch-mem"></span> Docker</span>
              <span class="legend-item"><span class="bar-swatch bar-swatch-mem-host"></span> host total</span>
            </p>
          </div>
          <div class="host-tile" v-if="diskUsage.length">
            <div class="host-tile-label"><span class="tile-icon tile-icon-disk"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M3 5v10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5" stroke="currentColor" stroke-width="1.6"/><path d="M3 10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" stroke="currentColor" stroke-width="1.6"/></svg></span> Disk</div>
            <div class="disk-usage-rows">
              <div class="disk-usage-row" v-if="diskRow('Images')">
                <span class="muted">Images ({{ diskRow('Images').total }})</span>
                <span>{{ diskRow('Images').size }} <span class="muted small">· {{ diskRow('Images').reclaimable }} reclaimable</span></span>
              </div>
              <div class="disk-usage-row" v-if="diskRow('Local Volumes')">
                <span class="muted">Volumes ({{ diskRow('Local Volumes').total }})</span>
                <span>{{ diskRow('Local Volumes').size }} <span class="muted small">· {{ diskRow('Local Volumes').reclaimable }} reclaimable</span></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-show="!logViewerFullscreen" class="layout" :class="{ 'with-detail': !!selectedContainer || settingsOpen }">
        <div class="main">
          <div v-show="view === 'list'">
            <div v-for="[groupName, items] in groupedContainers" :key="groupName" class="group-block">
              <div class="group-header" @click="toggleGroup(groupName)">
                <span class="chevron" :class="{open: !collapsedGroups[groupName]}">&#9656;</span>
                {{ groupName }} <span class="muted">({{ items.length }})</span>
              </div>
              <table v-show="!collapsedGroups[groupName]" class="containers">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Image</th>
                    <th>Status</th>
                    <th>CPU</th>
                    <th>Memory</th>
                    <th>Ports</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="c in items"
                    :key="c.id"
                    class="row-clickable"
                    :class="{'row-selected': c.id === selectedContainerId}"
                    @click="selectContainerById(c.id)"
                  >
                    <td>{{ c.name }}</td>
                    <td class="muted">{{ c.image }}</td>
                    <td>
                      <span :class="stateClass(c)">{{ c.status }}</span>
                      <span
                        v-if="c.health"
                        class="health-dot"
                        :style="{ background: healthDotColor(c.health) }"
                        :title="healthTitle(c.health)"
                      ></span>
                      <span v-if="c.restartCount1h" class="restart-badge" title="Restarts in the last hour">⟳ {{ c.restartCount1h }}</span>
                    </td>
                    <td class="muted">
                      <div class="cell-metric-row">
                        <span>{{ statFor(c.id).cpuPerc || '—' }}</span>
                        <div class="mini-spark">
                          <div
                            v-for="(v, i) in metricsFor(c.id).cpu"
                            :key="i"
                            class="mini-bar mini-cpu"
                            :class="{ current: i === metricsFor(c.id).cpu.length - 1 }"
                            :style="{ height: (metricsFor(c.id).cpuPeak ? (v / metricsFor(c.id).cpuPeak * 100) : 0) + '%' }"
                          ></div>
                        </div>
                      </div>
                    </td>
                    <td class="muted">
                      <div class="cell-metric-row">
                        <span>{{ statFor(c.id).memUsage || '—' }}</span>
                        <div class="mini-spark">
                          <div
                            v-for="(v, i) in metricsFor(c.id).mem"
                            :key="i"
                            class="mini-bar mini-mem"
                            :class="{ current: i === metricsFor(c.id).mem.length - 1 }"
                            :style="{ height: (metricsFor(c.id).memPeak ? (v / metricsFor(c.id).memPeak * 100) : 0) + '%' }"
                          ></div>
                        </div>
                      </div>
                    </td>
                    <td class="muted" :title="c.ports">{{ c.ports }}</td>
                    <td class="actions" @click.stop>
                      <button @click="openLogsFor(c.id)" title="Open the log viewer for this container">Logs</button>
                      <template v-if="isAdmin">
                        <button :disabled="!!actionInFlight[c.id]" @click="doAction(c, 'start')">Start</button>
                        <button :disabled="!!actionInFlight[c.id]" @click="doAction(c, 'stop')">Stop</button>
                        <button :disabled="!!actionInFlight[c.id]" @click="doAction(c, 'restart')">Restart</button>
                      </template>
                      <span v-else class="muted small">read-only</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
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

          <div v-show="view === 'activity'" class="activity-wrap">
            <div class="activity-column">
              <h3>Alerts</h3>
              <input type="text" v-model="alertSearch" placeholder="Search alerts…" class="activity-search" />
              <p v-if="!searchedAlerts.length" class="muted">{{ alerts.length ? 'No matching alerts.' : 'No alerts.' }}</p>
              <div v-else class="activity-list-wrap">
                <div class="activity-list" ref="alertsListView" @scroll="onAlertsScroll">
                  <div v-for="a in searchedAlerts" :key="a.id" class="alert-row" :class="'severity-' + a.severity">
                    <div class="alert-row-main">
                      <strong>{{ a.rule }}</strong>
                      <span class="alert-time">{{ formatEventTime(a.ts) }}</span>
                    </div>
                    <div class="alert-message">{{ a.message }}</div>
                    <button v-if="!a.acknowledged" class="small-btn" @click="ackAlertAction(a)">Acknowledge</button>
                    <span v-else class="ack-tick">✓ Acknowledged</span>
                  </div>
                </div>
                <button v-show="!alertsAtTop" class="scroll-top-btn" @click="scrollAlertsToTop" title="Scroll to top">&#8593; Top</button>
              </div>
            </div>
            <div class="activity-column">
              <h3>Events</h3>
              <input type="text" v-model="eventSearch" placeholder="Search events…" class="activity-search" />
              <p v-if="!searchedActivityEvents.length" class="muted">{{ activityEvents.length ? 'No matching events.' : 'No events yet.' }}</p>
              <div v-else class="activity-list-wrap">
                <div class="activity-list" ref="eventsListView" @scroll="onEventsScroll">
                  <table class="containers">
                    <thead><tr><th>Time</th><th>Container</th><th>Action</th></tr></thead>
                    <tbody>
                      <tr v-for="(e, i) in searchedActivityEvents" :key="i">
                        <td class="muted">{{ formatEventTime(e.ts) }}</td>
                        <td>{{ e.containerName || e.containerId || '—' }}</td>
                        <td class="muted">{{ e.action }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <button v-show="!eventsAtTop" class="scroll-top-btn" @click="scrollEventsToTop" title="Scroll to top">&#8593; Top</button>
              </div>
            </div>
          </div>
        </div>

        <aside v-if="selectedContainer" class="detail-panel">
          <div class="detail-header">
            <div>
              <strong>{{ selectedContainer.name }}</strong>
              <div class="muted small">{{ selectedContainer.composeProject || 'ungrouped' }} / {{ selectedContainer.composeService || '—' }}</div>
            </div>
            <button @click="closeDetail">✕</button>
          </div>
          <div class="detail-body">
            <div class="detail-row"><span class="label">Status</span><span :class="stateClass(selectedContainer)">{{ selectedContainer.status }}</span></div>
            <div class="detail-row" v-if="selectedContainer.health"><span class="label">Health</span><span><span class="health-dot" :style="{ background: healthDotColor(selectedContainer.health) }"></span> {{ healthTitle(selectedContainer.health) }}</span></div>
            <div class="detail-row" v-if="selectedContainer.restartCount1h"><span class="label">Restarts (1h)</span><span>{{ selectedContainer.restartCount1h }}</span></div>
            <div class="detail-row"><span class="label">Image</span><span>{{ selectedContainer.image }}</span></div>
            <div class="detail-row"><span class="label">CPU</span><span>{{ statFor(selectedContainer.id).cpuPerc || '—' }}</span></div>
            <div class="detail-row"><span class="label">Memory</span><span>{{ statFor(selectedContainer.id).memUsage || '—' }}</span></div>
            <div class="detail-row"><span class="label">Net I/O</span><span>{{ fmtRatePair(statFor(selectedContainer.id).netRxRate, statFor(selectedContainer.id).netTxRate) }}</span></div>
            <div class="detail-row"><span class="label">Block I/O</span><span>{{ fmtRatePair(statFor(selectedContainer.id).blockReadRate, statFor(selectedContainer.id).blockWriteRate) }}</span></div>
            <div class="detail-row"><span class="label">Ports</span><span>{{ selectedContainer.ports || '—' }}</span></div>
            <div class="detail-row"><span class="label">Networks</span><span>{{ selectedContainer.networks.join(', ') || '—' }}</span></div>

            <template v-if="containerInspect">
              <div class="detail-row"><span class="label">Created</span><span>{{ fmtCreated(containerInspect.createdAt) }}</span></div>
              <div class="detail-row"><span class="label">Restart Policy</span><span>{{ fmtRestartPolicy(containerInspect) }}</span></div>

              <details class="inspect-section">
                <summary>Environment ({{ containerInspect.env.length }})</summary>
                <div class="inspect-list">
                  <div v-for="(line, i) in containerInspect.env" :key="i" class="inspect-line mono">{{ line }}</div>
                  <div v-if="!containerInspect.env.length" class="muted small">None</div>
                </div>
              </details>

              <details class="inspect-section">
                <summary>Mounts ({{ containerInspect.mounts.length }})</summary>
                <div class="inspect-list">
                  <div v-for="(m, i) in containerInspect.mounts" :key="i" class="inspect-line">
                    <span class="mono">{{ m.source || m.type }}</span> → <span class="mono">{{ m.destination }}</span>
                    <span class="muted small">({{ m.rw ? 'rw' : 'ro' }})</span>
                  </div>
                  <div v-if="!containerInspect.mounts.length" class="muted small">None</div>
                </div>
              </details>

              <details class="inspect-section">
                <summary>Labels ({{ Object.keys(containerInspect.labels).length }})</summary>
                <div class="inspect-list">
                  <div v-for="(v, k) in containerInspect.labels" :key="k" class="inspect-line mono">{{ k }}={{ v }}</div>
                  <div v-if="!Object.keys(containerInspect.labels).length" class="muted small">None</div>
                </div>
              </details>
            </template>

            <div class="detail-actions" v-if="isAdmin">
              <button :disabled="!!actionInFlight[selectedContainer.id]" @click="doAction(selectedContainer, 'start')">Start</button>
              <button :disabled="!!actionInFlight[selectedContainer.id]" @click="doAction(selectedContainer, 'stop')">Stop</button>
              <button :disabled="!!actionInFlight[selectedContainer.id]" @click="doAction(selectedContainer, 'restart')">Restart</button>
            </div>

            <div class="log-section-header">
              <h3>Logs</h3>
              <button class="small-btn" @click="openLogViewer" title="Open larger log view with filtering">Log Viewer ⤢</button>
            </div>
            <div class="log-view-wrap">
              <div v-if="previewLoading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
              <pre class="log-view detail-log" ref="previewLogView" @scroll="onPreviewScroll"><div v-for="line in previewLogLines" :key="line.id" v-html="formatPreviewLine(line.text)"></div></pre>
              <button v-show="!previewAtBottom" class="scroll-bottom-btn" @click="scrollPreviewToBottom" title="Scroll to bottom">&#8595; Bottom</button>
            </div>
          </div>
        </aside>
      </div>

      <div
        v-if="logViewerOpen"
        ref="logPanel"
        class="log-panel"
        :class="{ 'with-detail': !!selectedContainer && !logViewerFullscreen, fullscreen: logViewerFullscreen }"
      >
        <div class="log-panel-header">
          <strong>{{ selectedContainer ? selectedContainer.name : '' }}</strong>
          <div class="log-panel-controls">
            <div class="log-level-toggle">
              <button :class="{active: logViewerLevels.error}" class="level-error" @click="toggleLevel('error')">Error</button>
              <button :class="{active: logViewerLevels.warn}" class="level-warn" @click="toggleLevel('warn')">Warn</button>
              <button :class="{active: logViewerLevels.info}" class="level-info" @click="toggleLevel('info')">Info</button>
              <button :class="{active: logViewerLevels.debug}" class="level-debug" @click="toggleLevel('debug')">Debug</button>
            </div>
            <div class="log-filter-group">
              <div class="log-filter-input-wrap">
                <input
                  type="text"
                  v-model="logViewerFilter"
                  :placeholder="logViewerRegexMode ? 'Filter logs (regex)…' : 'Filter logs…'"
                  :class="{ 'filter-invalid': logViewerRegexError }"
                />
                <button v-if="logViewerFilter" class="filter-clear-btn" @click="logViewerFilter = ''" title="Clear filter">✕</button>
              </div>
              <button
                class="small-btn regex-toggle-btn"
                :class="{ active: logViewerRegexMode }"
                @click="logViewerRegexMode = !logViewerRegexMode"
                title="Treat filter text as a regular expression"
              >
                .*
              </button>
              <span v-if="logViewerRegexError" class="filter-error-text">{{ logViewerRegexError }}</span>
              <span v-else-if="logViewerFilter" class="filter-count-text">{{ filteredLogViewerLines.length }} / {{ logViewerLines.length }}</span>
            </div>
            <select :value="logViewerTail" @change="changeLogViewerTail($event.target.value === 'all' ? 'all' : Number($event.target.value))">
              <option :value="100">Last 100 lines</option>
              <option :value="200">Last 200 lines</option>
              <option :value="1000">Last 1000 lines</option>
              <option :value="5000">Last 5000 lines</option>
              <option value="all">All lines</option>
            </select>
            <button class="small-btn" @click="downloadLogs" title="Download the currently selected tail as a text file">⬇ Download</button>
            <button
              class="small-btn"
              :class="{ active: logViewerShowTimestamps }"
              @click="logViewerShowTimestamps = !logViewerShowTimestamps"
              title="Toggle the docker timestamp shown at the start of each line"
            >
              🕐 Time
            </button>
            <button
              class="small-btn"
              @click="logViewerFullscreen = !logViewerFullscreen"
              :title="logViewerFullscreen ? 'Exit fullscreen' : 'Fullscreen - hide everything else so you can see more of the log'"
            >
              {{ logViewerFullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen' }}
            </button>
            <button @click="closeLogViewer">Close</button>
          </div>
        </div>
        <div class="log-view-wrap">
          <div v-if="logViewerLoading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
          <pre class="log-view log-viewer-pane" :class="{ 'hide-ts': !logViewerShowTimestamps }" ref="logViewerLogView" @scroll="onLogViewerScroll"><div v-for="line in filteredLogViewerLines" :key="line.id" v-html="line.html"></div></pre>
          <button v-show="!logViewerAtBottom" class="scroll-bottom-btn" @click="scrollLogViewerToBottom" title="Scroll to bottom">&#8595; Bottom</button>
        </div>
      </div>

      <aside v-if="settingsOpen" class="detail-panel">
        <div class="detail-header">
          <strong>Settings</strong>
          <button @click="closeSettings">✕</button>
        </div>
        <div class="detail-body">
            <p class="muted small">
              Sets ALERT_WEBHOOK_URL for all hosts. Supports
              <code>discord://</code>, <code>ntfy://</code>, <code>gotify://</code> / <code>gotifys://</code>, or any
              <code>http(s)://</code> URL (auto-detected for Slack, generic JSON otherwise).
            </p>
            <label class="modal-field">
              Webhook URL
              <input type="text" v-model="webhookUrl" placeholder="discord://webhook_id/webhook_token" />
            </label>
            <label class="modal-field">
              Format override
              <select v-model="webhookFormat">
                <option value="">Auto</option>
                <option value="slack">Force Slack {text} shape</option>
              </select>
            </label>
            <p v-if="webhookOverridden" class="muted small">Overriding the .env default.</p>
            <p v-else class="muted small">Using the .env default (if any) — no override saved yet.</p>
            <p v-if="webhookError" class="error">{{ webhookError }}</p>
            <p v-if="webhookStatus" class="muted small">{{ webhookStatus }}</p>
            <div class="modal-actions">
              <button :disabled="webhookSaving" @click="saveWebhookConfig">Save</button>
              <button :disabled="webhookSaving || !webhookOverridden" @click="clearWebhookConfig">Clear override</button>
              <button :disabled="webhookTesting" @click="testWebhook">Send test alert</button>
            </div>

            <hr />

            <strong>Resource thresholds</strong>
            <p class="muted small">
              Alert when a value stays over threshold for the sustain window. Leave a threshold at 0 to disable that
              rule. CPU% is raw <code>docker stats</code> CPU (per-core cumulative, so 4 cores fully busy reads 400%).
              Mem% needs a container memory limit set to mean much. Docker disk usage is Docker's own footprint
              (images/containers/volumes/cache), not host free disk space — it's a prune reminder, not a disk-full alert.
              Skip a container entirely with the <code>opendockwatch.alerts=off</code> label.
            </p>
            <label class="modal-field">
              Container/host CPU threshold (%)
              <input type="number" min="0" max="100" v-model.number="thresholds.cpuThreshold" />
            </label>
            <label class="modal-field">
              Container/host memory threshold (%)
              <input type="number" min="0" max="100" v-model.number="thresholds.memThreshold" />
            </label>
            <label class="modal-field">
              Sustain window (minutes)
              <input type="number" min="0" v-model.number="thresholds.sustainMinutes" />
            </label>
            <label class="modal-field">
              Docker disk usage threshold (GB)
              <input type="number" min="0" v-model.number="thresholds.diskThresholdGb" />
            </label>
            <p v-if="thresholdsOverridden" class="muted small">Overriding the .env defaults.</p>
            <p v-else class="muted small">Using the .env defaults (if any) — no override saved yet.</p>
            <p v-if="thresholdsError" class="error">{{ thresholdsError }}</p>
            <p v-if="thresholdsStatus" class="muted small">{{ thresholdsStatus }}</p>
            <div class="modal-actions">
              <button :disabled="thresholdsSaving" @click="saveThresholds">Save</button>
              <button :disabled="thresholdsSaving || !thresholdsOverridden" @click="clearThresholds">Clear override</button>
            </div>

            <hr />

            <strong>Hosts</strong>
            <p class="muted small">
              Docker hosts this dashboard monitors. Add a remote one as
              <code>ssh://user@host[:port]</code> — the container's docker CLI reaches it using the
              SSH keys already mounted in, no password needed here. Changes apply immediately, no
              restart required.
            </p>
            <p v-if="hostsError" class="error">{{ hostsError }}</p>
            <p v-if="hostsStatus" class="muted small">{{ hostsStatus }}</p>

            <div v-for="h in settingsHosts" :key="h.id" class="host-row">
              <template v-if="editingHostId === h.id">
                <label class="modal-field">
                  Display name
                  <input type="text" v-model="editHostDraft.name" :placeholder="h.id" />
                </label>
                <label class="modal-field">
                  Docker host
                  <input type="text" v-model="editHostDraft.dockerHost" placeholder="ssh://user@host (blank = local socket)" />
                </label>
                <div class="modal-actions">
                  <button :disabled="hostsSaving" @click="saveEditHost(h.id)">Save</button>
                  <button :disabled="hostsSaving" @click="cancelEditHost">Cancel</button>
                </div>
              </template>
              <template v-else>
                <div class="host-row-main">
                  <strong>{{ h.name || h.id }}</strong>
                  <span class="muted small">{{ h.dockerHost || 'local socket' }}</span>
                </div>
                <div class="modal-actions">
                  <button class="small-btn" :disabled="hostsSaving" @click="startEditHost(h)">Edit</button>
                  <button class="small-btn" :disabled="hostsSaving" @click="removeHost(h.id)">Remove</button>
                </div>
              </template>
            </div>

            <label class="modal-field">
              ID
              <input type="text" v-model="newHost.id" placeholder="prod" />
            </label>
            <label class="modal-field">
              Display name (optional)
              <input type="text" v-model="newHost.name" placeholder="Production" />
            </label>
            <label class="modal-field">
              Docker host (blank = local socket)
              <input type="text" v-model="newHost.dockerHost" placeholder="ssh://deploy@prod.example.com" />
            </label>
            <div class="modal-actions">
              <button :disabled="hostsSaving || !newHost.id" @click="addHost">Add host</button>
            </div>
        </div>
      </aside>
    </div>
  `,
}).mount('#app');
