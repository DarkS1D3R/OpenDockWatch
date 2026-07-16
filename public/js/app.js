import { POLL_MS, METRICS_HISTORY_LEN, HOST_METRICS_HISTORY_LEN } from './constants.js';
import SparkTile from './components/SparkTile.js';
import HostCard from './components/HostCard.js';
import LogViewer from './components/LogViewer.js';
import ContainerDetail from './components/ContainerDetail.js';
import ActivityView from './components/ActivityView.js';
import SettingsPanel from './components/SettingsPanel.js';
import ContainerList from './components/ContainerList.js';
import FlowView from './components/FlowView.js';
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
  apiAckAllAlerts,
} from './api.js';

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
    FlowView,
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
      flowFullscreen: false,

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
    // Preview-stream/inspect state lives entirely in ContainerDetail (keyed off its own
    // container.id watcher) and the Flow view's cy selection sync lives entirely in FlowView
    // (keyed off its own selectedContainerId prop watcher) - this only needs to close the
    // (sibling) log viewer.
    selectedContainerId() {
      this.closeLogViewer();
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
    async ackAllAlertsAction() {
      if (!this.selectedHostId) return;
      try {
        await apiAckAllAlerts(this.selectedHostId);
        for (const a of this.alerts) a.acknowledged = 1;
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
      } catch {
        /* topology is best-effort */
      }
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

          <flow-view
            v-show="view === 'flow'"
            :topology="topology"
            :host-id="selectedHostId"
            :selected-container-id="selectedContainerId"
            :state-filter="stateFilter"
            v-model:fullscreen="flowFullscreen"
            @select="selectContainerById"
          ></flow-view>

          <activity-view
            v-if="view === 'activity'"
            :host-id="selectedHostId"
            :alerts="alerts"
            @ack="ackAlertAction"
            @ack-all="ackAllAlertsAction"
          ></activity-view>
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
