import { POLL_MS, MAX_LOG_LINES, PREVIEW_TAIL, METRICS_HISTORY_LEN, HOST_METRICS_HISTORY_LEN, MAX_ACTIVITY_EVENTS } from './constants.js';
import { createLogStream } from './lib/logStream.js';
import SparkTile from './components/SparkTile.js';
import HostCard from './components/HostCard.js';
import LogViewer from './components/LogViewer.js';
import { parseMemUsedBytes, formatGB, formatRatePair, healthColor, healthLabel, highlightLine } from './format.js';
import {
  apiGetHosts,
  apiGetContainers,
  apiGetStats,
  apiGetTopology,
  apiGetHostInfo,
  apiContainerAction,
  apiGetContainerInspect,
  logsUrl,
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
  components: {
    SparkTile,
    HostCard,
    LogViewer,
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
      previewAtBottom: true,
      previewLoading: false,

      logViewerOpen: false,
      logViewerFullscreen: false,

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
    selectedContainerId(newId) {
      this.closePreviewStream();
      this.closeLogViewer();
      this.previewLogLines = [];
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
    // Plain (non-reactive) log stream handle - see openPreviewStream. Keeping it off the
    // reactive `data()` object avoids Vue tracking its internals.
    this._previewStream = null;
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
      this._previewStream = createLogStream({
        url: logsUrl(this.selectedHostId, id, PREVIEW_TAIL),
        onFlush: (lines) => this.appendPreviewLines(lines),
        onLoadingChange: (loading) => {
          this.previewLoading = loading;
        },
      });
      this._previewStream.start();
    },
    closePreviewStream() {
      if (this._previewStream) {
        this._previewStream.stop();
        this._previewStream = null;
      }
    },
    appendPreviewLines(lines) {
      for (const line of lines) this.previewLogLines.push(line);
      if (this.previewLogLines.length > MAX_LOG_LINES) {
        this.previewLogLines.splice(0, this.previewLogLines.length - MAX_LOG_LINES);
      }
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
    openLogViewer() {
      if (!this.selectedContainerId) return;
      this.logViewerOpen = true;
    },
    closeLogViewer() {
      this.logViewerOpen = false;
      this.logViewerFullscreen = false;
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

      <log-viewer
        v-if="logViewerOpen"
        :host-id="selectedHostId"
        :container-id="selectedContainerId"
        :container-name="selectedContainer ? selectedContainer.name : ''"
        :with-detail="!!selectedContainer"
        v-model:fullscreen="logViewerFullscreen"
        @close="closeLogViewer"
      ></log-viewer>

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
