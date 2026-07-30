import { POLL_MS, MAX_POLL_BACKOFF_MS, HIDDEN_POLL_MS, METRICS_HISTORY_LEN, HOST_METRICS_HISTORY_LEN } from './constants.js';
import SparkTile from './components/SparkTile.js';
import HostCard from './components/HostCard.js';
import LogViewer from './components/LogViewer.js';
import ContainerDetail from './components/ContainerDetail.js';
import ActivityView from './components/ActivityView.js';
import SettingsPanel from './components/SettingsPanel.js';
import ContainerList from './components/ContainerList.js';
import ContainerMetricsModal from './components/ContainerMetricsModal.js';
import FlowView from './components/FlowView.js';
import LogsView from './components/LogsView.js';
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
    ContainerMetricsModal,
    FlowView,
    LogsView,
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
      pollStopped: true,
      pollInFlight: false,
      pollFailures: 0,
      actionInFlight: {},

      view: 'list', // 'list' | 'flow' | 'logs' | 'activity'
      stateFilter: 'all', // 'all' | 'running' | 'stopped'
      topology: { nodes: [], edges: [] },
      flowFullscreen: false,

      hostInfo: null,
      hostCardFullscreen: false,
      diskUsage: [],
      hostMetricsHistory: [],
      containerMetricsHistory: {},

      alerts: [],

      selectedContainerId: null,
      // Independent of selectedContainerId: opening a row's metrics shouldn't also open the
      // detail panel and its log stream, and the modal stays on the container it was opened for
      // even if the selection moves underneath it.
      metricsContainerId: null,

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
    metricsContainer() {
      return this.containers.find((c) => c.id === this.metricsContainerId) || null;
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
    document.addEventListener('visibilitychange', this.onVisibilityChange);
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
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
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
      // A container id means nothing on the host being switched to - leaving the modal open would
      // have it fetching history for an id that host has never seen.
      this.metricsContainerId = null;
      this.hostInfo = null;
      this.diskUsage = [];
      this.hostMetricsHistory = [];
      this.containerMetricsHistory = {};
      this.alerts = [];
      this.stopPolling();
      this.fetchHostInfo();
      this.fetchDiskUsage();
      this.startPolling();
    },
    // Chained, never setInterval. refresh() awaits five or six requests in sequence, so on a slow
    // host one cycle can outlast POLL_MS - and an interval doesn't care, it just starts another.
    // Cycles then overlap and stack, each holding connections the browser only has about six of,
    // until the tab has none left and can't issue any request at all. That state doesn't resolve
    // when the server does, which is why the container ends up being restarted. Measuring the gap
    // from when the previous cycle *finished* makes overlap structurally impossible.
    startPolling() {
      this.stopPolling();
      this.pollStopped = false;
      this.pollFailures = 0;
      this.pollTick();
    },
    stopPolling() {
      this.pollStopped = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
    },
    async pollTick() {
      if (this.pollStopped || !this.selectedHostId) return;
      // A background tab still polls forever otherwise - and a dashboard is exactly the kind of
      // page left open in a tab for days. Every one of those tabs was driving docker CLI calls on
      // the server for a view nobody was looking at.
      if (document.hidden) return this.schedulePoll(HIDDEN_POLL_MS);

      this.pollInFlight = true;
      try {
        await this.refresh();
        // refresh()'s sub-fetches each swallow their own errors (they're best-effort), but
        // fetchContainers records its failure - the one that means the host itself is answering.
        this.pollFailures = this.containersError ? this.pollFailures + 1 : 0;
      } catch {
        this.pollFailures++;
      } finally {
        this.pollInFlight = false;
      }
      this.schedulePoll(this.nextPollDelay());
    },
    schedulePoll(delay) {
      if (this.pollStopped) return;
      clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(() => this.pollTick(), delay);
    },
    nextPollDelay() {
      if (!this.pollFailures) return POLL_MS;
      return Math.min(POLL_MS * 2 ** Math.min(this.pollFailures, 5), MAX_POLL_BACKOFF_MS);
    },
    onVisibilityChange() {
      // Coming back to a backgrounded tab should show current data immediately, not whatever it
      // froze on plus up to HIDDEN_POLL_MS. Skipped while a cycle is already running, so this
      // can't start a second one alongside it.
      if (document.hidden || this.pollStopped || this.pollInFlight || !this.selectedHostId) return;
      this.pollFailures = 0;
      this.schedulePoll(0);
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
      const hostId = this.selectedHostId;
      try {
        const info = await apiGetHostInfo(hostId);
        // The user may have switched hosts while this was in flight - a slow/unreachable host
        // can leave this pending well past a subsequent host switch, so only apply it if it's
        // still the host being looked at.
        if (this.selectedHostId === hostId) this.hostInfo = info;
      } catch {
        /* host info is best-effort */
      }
    },
    async fetchDiskUsage() {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      try {
        const usage = await apiGetDiskUsage(hostId);
        if (this.selectedHostId === hostId) this.diskUsage = usage;
      } catch {
        /* disk usage is best-effort */
      }
    },
    async fetchHostMetricsHistory() {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      try {
        const rows = await apiGetMetricsHistory(hostId, { range: '1h' });
        if (this.selectedHostId === hostId) this.hostMetricsHistory = rows.slice(-HOST_METRICS_HISTORY_LEN);
      } catch {
        /* history is best-effort */
      }
    },
    async fetchAlerts() {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      try {
        const alerts = await apiGetAlerts(hostId, 100);
        if (this.selectedHostId === hostId) this.alerts = alerts;
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
    async fetchContainers({ fresh = false } = {}) {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      this.loadingContainers = true;
      try {
        const containers = await apiGetContainers(hostId, { fresh });
        if (this.selectedHostId !== hostId) return;
        this.containers = containers;
        this.containersError = null;
      } catch (err) {
        if (this.selectedHostId !== hostId) return;
        this.containersError = err.message;
      } finally {
        // Only this call's own loading flag - don't clear it out from under a newer, still
        // in-flight fetchContainers for the host the user has since switched to.
        if (this.selectedHostId === hostId) this.loadingContainers = false;
      }
    },
    async fetchStats() {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      try {
        const stats = await apiGetStats(hostId);
        if (this.selectedHostId === hostId) this.stats = stats;
      } catch {
        /* stats are best-effort */
      }
    },
    async fetchTopology() {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      try {
        const topology = await apiGetTopology(hostId);
        // A slow/unreachable host's stale topology must never land after a host switch - it
        // would render under the wrong host's identity in Flow view and its dragged-position
        // save would go to the wrong host's localStorage key.
        if (this.selectedHostId === hostId) this.topology = topology;
      } catch {
        /* topology is best-effort */
      }
    },
    async doAction(container, action) {
      this.actionInFlight = { ...this.actionInFlight, [container.id]: action };
      try {
        await apiContainerAction(this.selectedHostId, container.id, action);
        // Bypass the server's snapshot here specifically - it can be up to POLL_MS old, and the
        // one moment that staleness is visible is the row the user just clicked Stop on.
        await this.fetchContainers({ fresh: true });
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
    openMetrics(id) {
      this.metricsContainerId = id;
    },
    closeMetrics() {
      this.metricsContainerId = null;
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
          <button :class="{active: view==='logs'}" @click="setView('logs')">Logs</button>
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
        v-if="hostInfo && !logViewerFullscreen && !flowFullscreen && view !== 'logs'"
        :host-info="hostInfo"
        :host-name="currentHostName"
        :host-id="selectedHostId"
        :metrics-history="hostMetricsHistory"
        :disk-usage="diskUsage"
        :with-detail="!!selectedContainer || settingsOpen"
        v-model:fullscreen="hostCardFullscreen"
      ></host-card>

      <div v-show="!logViewerFullscreen && !hostCardFullscreen" class="layout" :class="{ 'with-detail': !!selectedContainer || settingsOpen }">
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
              @open-metrics="openMetrics"
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

          <logs-view
            v-if="view === 'logs'"
            :host-id="selectedHostId"
            :grouped-containers="groupedContainers"
          ></logs-view>

          <activity-view
            v-if="view === 'activity'"
            :host-id="selectedHostId"
            :alerts="alerts"
            :is-admin="isAdmin"
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

      <container-metrics-modal
        v-if="metricsContainerId && selectedHostId"
        :key="metricsContainerId"
        :host-id="selectedHostId"
        :container-id="metricsContainerId"
        :container-name="metricsContainer ? metricsContainer.name : metricsContainerId"
        @close="closeMetrics"
      ></container-metrics-modal>
    </div>
  `,
}).mount('#app');
