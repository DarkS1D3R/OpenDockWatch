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
} from './api.js';
import { buildElements, createGraph, updateGraph, applyFading, exportPng, collapseAllGroups, expandAllGroups } from './graph.js';

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

      hostInfo: null,
      diskUsage: [],
      hostMetricsHistory: [],
      containerMetricsHistory: {},

      alerts: [],
      alertSearch: '',
      activityEvents: [],
      eventSearch: '',
      activityEventSource: null,

      selectedContainerId: null,
      previewLogLines: [],
      previewEventSource: null,
      previewAtBottom: true,
      previewLoading: false,

      popoutOpen: false,
      popoutTail: 200,
      popoutFilter: '',
      popoutRegexMode: false,
      popoutLevels: { error: true, warn: true, info: true, debug: true },
      popoutLogLines: [],
      popoutEventSource: null,
      popoutAtBottom: true,
      popoutLoading: false,
      popoutFullscreen: false,
      popoutShowTimestamps: true,

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
    popoutTestRegex() {
      if (!this.popoutRegexMode) return null;
      const pattern = this.popoutFilter.trim();
      if (!pattern) return null;
      try {
        return new RegExp(pattern, 'i');
      } catch {
        return null;
      }
    },
    popoutRegexError() {
      if (!this.popoutRegexMode || !this.popoutFilter.trim()) return null;
      return this.popoutTestRegex ? null : 'Invalid regex';
    },
    filteredPopoutLines() {
      const filterText = this.popoutFilter.trim();
      const filterLower = filterText.toLowerCase();
      const regexMode = this.popoutRegexMode;
      const testRegex = this.popoutTestRegex;
      return this.popoutLogLines
        .filter((line) => {
          const level = detectLogLevel(stripAnsi(line.text));
          if (level && !this.popoutLevels[level]) return false;
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
      this.closePopout();
      this.previewLogLines = [];
      this._previewBuffer = [];
      this._previewFlushPending = false;
      this.previewLoading = false;
      if (this.cy) {
        this.cy.nodes().removeClass('selected');
        if (newId) this.cy.$id(newId).addClass('selected');
        if (this.view === 'flow') this.applyFlowFading();
      }
      if (newId) this.openPreviewStream(newId);
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
  },
  created() {
    // Plain (non-reactive) buffers for batching high-volume log streams - see
    // queuePreviewLine/queuePopoutLine. Keeping these off the reactive `data()`
    // object avoids Vue tracking every push into them.
    this._previewBuffer = [];
    this._previewFlushPending = false;
    this._previewNextId = 0;
    this._previewLoadingTimer = null;
    this._popoutBuffer = [];
    this._popoutFlushPending = false;
    this._popoutNextId = 0;
    this._popoutLoadingTimer = null;
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
    this.closePopout();
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
      const elements = buildElements(this.filteredTopology.nodes, this.filteredTopology.edges, this.selectedContainerId);
      if (this.cy) {
        updateGraph(this.cy, elements, this.selectedHostId);
      } else {
        this.cy = createGraph(
          this.$refs.cy,
          elements,
          (id) => this.selectContainerById(id),
          (edgeData) => this.showEdgeInfo(edgeData),
          this.selectedHostId
        );
      }
      this.applyFlowFading();
    },
    applyFlowFading() {
      if (this.cy) applyFading(this.cy, { selectedId: this.selectedContainerId, filterText: this.flowFilterText });
    },
    showEdgeInfo(edgeData) {
      if (!edgeData) {
        this.edgeInfoText = null;
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
        this.edgeInfoText = `${from} and ${to} share a Docker network`;
      }
    },
    async exportFlowPng() {
      await exportPng(this.cy);
    },
    collapseAllFlowGroups() {
      collapseAllGroups(this.cy);
    },
    expandAllFlowGroups() {
      expandAllGroups(this.cy);
    },
    zoomBy(factor) {
      if (!this.cy) return;
      const center = { x: this.cy.width() / 2, y: this.cy.height() / 2 };
      this.cy.zoom({ level: this.cy.zoom() * factor, renderedPosition: center });
    },
    zoomFit() {
      if (this.cy) this.cy.fit(undefined, 30);
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
      this.selectedContainerId = this.selectedContainerId === id ? null : id;
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
    async openPopout() {
      if (!this.selectedContainerId) return;
      this.popoutOpen = true;
      this.startPopoutStream();
      await this.$nextTick();
      this.$refs.logPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    closePopout() {
      this.popoutOpen = false;
      this.popoutFullscreen = false;
      clearTimeout(this._popoutLoadingTimer);
      if (this.popoutEventSource) {
        this.popoutEventSource.close();
        this.popoutEventSource = null;
      }
      this.popoutLogLines = [];
      this._popoutBuffer = [];
      this._popoutFlushPending = false;
      this.popoutLoading = false;
    },
    startPopoutStream() {
      if (!this.selectedContainerId) return;
      if (this.popoutEventSource) this.popoutEventSource.close();
      this.popoutLogLines = [];
      this._popoutBuffer = [];
      this._popoutNextId = 0;
      this.popoutAtBottom = true;
      this.popoutLoading = true;
      clearTimeout(this._popoutLoadingTimer);
      this._popoutLoadingTimer = setTimeout(() => {
        this.popoutLoading = false;
      }, 2000);
      this.popoutEventSource = new EventSource(logsUrl(this.selectedHostId, this.selectedContainerId, this.popoutTail));
      this.popoutEventSource.onmessage = (e) => {
        this.queuePopoutLine(e.data);
      };
      this.popoutEventSource.onerror = () => {
        this.queuePopoutLine('[opendockwatch] log stream disconnected');
      };
    },
    queuePopoutLine(text) {
      this._popoutBuffer.push(text);
      if (this._popoutFlushPending) return;
      this._popoutFlushPending = true;
      requestAnimationFrame(() => this.flushPopoutLines());
    },
    flushPopoutLines() {
      this._popoutFlushPending = false;
      const lines = this._popoutBuffer;
      this._popoutBuffer = [];
      if (!lines.length) return;
      for (const text of lines) this.popoutLogLines.push({ id: this._popoutNextId++, text });
      if (this.popoutLogLines.length > MAX_LOG_LINES) {
        this.popoutLogLines.splice(0, this.popoutLogLines.length - MAX_LOG_LINES);
      }
      clearTimeout(this._popoutLoadingTimer);
      this.popoutLoading = false;
      if (this.popoutAtBottom) {
        this.$nextTick(() => {
          const el = this.$refs.popoutLogView;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    },
    changePopoutTail(newTail) {
      this.popoutTail = newTail;
      this.startPopoutStream();
    },
    downloadLogs() {
      if (!this.selectedContainerId) return;
      window.location.href = downloadLogsUrl(this.selectedHostId, this.selectedContainerId, this.popoutTail);
    },
    onPopoutScroll() {
      const el = this.$refs.popoutLogView;
      if (el) this.popoutAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
    scrollPopoutToBottom() {
      this.popoutAtBottom = true;
      const el = this.$refs.popoutLogView;
      if (el) el.scrollTop = el.scrollHeight;
    },
    toggleLevel(level) {
      this.popoutLevels = { ...this.popoutLevels, [level]: !this.popoutLevels[level] };
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

      <div v-if="hostInfo && !popoutFullscreen" class="host-card" :class="{ 'with-detail': !!selectedContainer }">
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
            <div class="sparkline">
              <div
                v-for="(v, i) in cpuChartSlots"
                :key="i"
                class="spark-bar spark-cpu"
                :class="{ current: i === cpuChartSlots.length - 1, empty: v === null }"
                :style="{ height: (v === null ? 0 : (cpuPeak ? (v / cpuPeak * 100) : 0)) + '%' }"
                :title="v === null ? '' : v.toFixed(1) + '%'"
              ></div>
            </div>
          </div>
          <div class="host-tile">
            <div class="host-tile-label"><span class="tile-icon tile-icon-mem"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="16" height="8" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M5 7V4.5M8 7V4.5M11 7V4.5M14 7V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span> {{ fmtGB(hostInfo.memTotalBytes) }}</div>
            <div class="host-tile-value">{{ fmtGB(memNow) }}</div>
            <div class="host-tile-sub">avg {{ fmtGB(memAvg) }} &bull; pk {{ fmtGB(memPeak) }}</div>
            <div class="sparkline">
              <div
                v-for="(v, i) in memChartSlots"
                :key="i"
                class="spark-bar spark-mem"
                :class="{ current: i === memChartSlots.length - 1, empty: v === null }"
                :style="{ height: (v === null ? 0 : (memPeak ? (v / memPeak * 100) : 0)) + '%' }"
                :title="v === null ? '' : fmtGB(v)"
              ></div>
            </div>
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

      <div v-show="!popoutFullscreen" class="layout" :class="{ 'with-detail': !!selectedContainer }">
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

          <div v-show="view === 'flow'" class="cy-wrap">
            <div class="cy-toolbar">
              <button @click="zoomBy(1.25)">Zoom in</button>
              <button @click="zoomBy(0.8)">Zoom out</button>
              <button @click="zoomFit">Fit</button>
              <button @click="collapseAllFlowGroups">Collapse all</button>
              <button @click="expandAllFlowGroups">Expand all</button>
              <button @click="exportFlowPng">Export PNG</button>
              <input type="text" v-model="flowFilterText" placeholder="Filter by name…" class="flow-filter-input" />
              <label class="edge-toggle"><input type="checkbox" v-model="edgeFilters.dependsOn" /> depends-on</label>
              <label class="edge-toggle"><input type="checkbox" v-model="edgeFilters.network" /> network</label>
              <label class="edge-toggle"><input type="checkbox" v-model="edgeFilters.manual" /> manual</label>
              <span v-if="edgeInfoText" class="edge-info-text">{{ edgeInfoText }}</span>
            </div>
            <div ref="cy" class="cy-container"></div>
            <p class="muted legend">
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
          </div>

          <div v-show="view === 'activity'" class="activity-wrap">
            <div class="activity-column">
              <h3>Alerts</h3>
              <input type="text" v-model="alertSearch" placeholder="Search alerts…" class="activity-search" />
              <p v-if="!searchedAlerts.length" class="muted">{{ alerts.length ? 'No matching alerts.' : 'No alerts.' }}</p>
              <div v-else class="activity-list">
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
            </div>
            <div class="activity-column">
              <h3>Events</h3>
              <input type="text" v-model="eventSearch" placeholder="Search events…" class="activity-search" />
              <p v-if="!searchedActivityEvents.length" class="muted">{{ activityEvents.length ? 'No matching events.' : 'No events yet.' }}</p>
              <div v-else class="activity-list">
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

            <div class="detail-actions" v-if="isAdmin">
              <button :disabled="!!actionInFlight[selectedContainer.id]" @click="doAction(selectedContainer, 'start')">Start</button>
              <button :disabled="!!actionInFlight[selectedContainer.id]" @click="doAction(selectedContainer, 'stop')">Stop</button>
              <button :disabled="!!actionInFlight[selectedContainer.id]" @click="doAction(selectedContainer, 'restart')">Restart</button>
            </div>

            <div class="log-section-header">
              <h3>Logs</h3>
              <button class="small-btn" @click="openPopout" title="Open larger log view with filtering">Log Viewer ⤢</button>
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
        v-if="popoutOpen"
        ref="logPanel"
        class="log-panel"
        :class="{ 'with-detail': !!selectedContainer && !popoutFullscreen, fullscreen: popoutFullscreen }"
      >
        <div class="log-panel-header">
          <strong>{{ selectedContainer ? selectedContainer.name : '' }}</strong>
          <div class="log-panel-controls">
            <div class="log-level-toggle">
              <button :class="{active: popoutLevels.error}" class="level-error" @click="toggleLevel('error')">Error</button>
              <button :class="{active: popoutLevels.warn}" class="level-warn" @click="toggleLevel('warn')">Warn</button>
              <button :class="{active: popoutLevels.info}" class="level-info" @click="toggleLevel('info')">Info</button>
              <button :class="{active: popoutLevels.debug}" class="level-debug" @click="toggleLevel('debug')">Debug</button>
            </div>
            <div class="log-filter-group">
              <div class="log-filter-input-wrap">
                <input
                  type="text"
                  v-model="popoutFilter"
                  :placeholder="popoutRegexMode ? 'Filter logs (regex)…' : 'Filter logs…'"
                  :class="{ 'filter-invalid': popoutRegexError }"
                />
                <button v-if="popoutFilter" class="filter-clear-btn" @click="popoutFilter = ''" title="Clear filter">✕</button>
              </div>
              <button
                class="small-btn regex-toggle-btn"
                :class="{ active: popoutRegexMode }"
                @click="popoutRegexMode = !popoutRegexMode"
                title="Treat filter text as a regular expression"
              >
                .*
              </button>
              <span v-if="popoutRegexError" class="filter-error-text">{{ popoutRegexError }}</span>
              <span v-else-if="popoutFilter" class="filter-count-text">{{ filteredPopoutLines.length }} / {{ popoutLogLines.length }}</span>
            </div>
            <select :value="popoutTail" @change="changePopoutTail($event.target.value === 'all' ? 'all' : Number($event.target.value))">
              <option :value="100">Last 100 lines</option>
              <option :value="200">Last 200 lines</option>
              <option :value="1000">Last 1000 lines</option>
              <option :value="5000">Last 5000 lines</option>
              <option value="all">All lines</option>
            </select>
            <button class="small-btn" @click="downloadLogs" title="Download the currently selected tail as a text file">⬇ Download</button>
            <button
              class="small-btn"
              :class="{ active: popoutShowTimestamps }"
              @click="popoutShowTimestamps = !popoutShowTimestamps"
              title="Toggle the docker timestamp shown at the start of each line"
            >
              🕐 Time
            </button>
            <button
              class="small-btn"
              @click="popoutFullscreen = !popoutFullscreen"
              :title="popoutFullscreen ? 'Exit fullscreen' : 'Fullscreen - hide everything else so you can see more of the log'"
            >
              {{ popoutFullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen' }}
            </button>
            <button @click="closePopout">Close</button>
          </div>
        </div>
        <div class="log-view-wrap">
          <div v-if="popoutLoading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
          <pre class="log-view popout-log" :class="{ 'hide-ts': !popoutShowTimestamps }" ref="popoutLogView" @scroll="onPopoutScroll"><div v-for="line in filteredPopoutLines" :key="line.id" v-html="line.html"></div></pre>
          <button v-show="!popoutAtBottom" class="scroll-bottom-btn" @click="scrollPopoutToBottom" title="Scroll to bottom">&#8595; Bottom</button>
        </div>
      </div>

      <div v-if="settingsOpen" class="modal-backdrop" @click.self="closeSettings">
        <div class="modal-card">
          <div class="modal-header">
            <strong>Alert webhook</strong>
            <button @click="closeSettings">✕</button>
          </div>
          <div class="modal-body">
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
          </div>
        </div>
      </div>
    </div>
  `,
}).mount('#app');
