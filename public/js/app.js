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
import { clearAllOpenPanes } from './lib/logsPersistence.js';
import {
  apiGetHosts,
  apiGetContainers,
  apiGetDashboard,
  apiGetTopology,
  apiGetHostInfo,
  apiContainerAction,
  apiLogout,
  apiGetSession,
  apiGetDiskUsage,
  apiAckAlert,
  apiAckAllAlerts,
  apiClearAlerts,
  reportClientError,
} from './api.js';

const { createApp } = Vue;

// Nothing else in the client catches these - without a listener here, an exception anywhere
// during boot (a vendor script failure, a rejected promise outside Vue's own tracking) leaves
// the page silently blank with zero trace, indistinguishable from "still loading" or a network
// hang. Logged with console.error so it survives even if the app never renders far enough to
// show anything - see mounted()'s bootError for the visible counterpart.
// ...and mirrored to the server so they land in `docker logs` next to everything else, since a
// console nobody has open is not somewhere failures can be found later. Capped hard: a render
// error inside a watcher can fire every frame, and each report would take one of the browser's ~6
// per-origin connections - the same budget the poll loop and the log streams live on. An unbounded
// beacon would cause exactly the hang it exists to diagnose. So: dedup on what makes an error
// distinct, then stop entirely after MAX_CLIENT_ERROR_REPORTS for the life of the page.
const MAX_CLIENT_ERROR_REPORTS = 5;
const seenClientErrors = new Set();
let clientErrorsSent = 0;

// Truncated here as well as on the server: no reason to put a whole stack trace on the wire.
function errText(value) {
  if (value === null || value === undefined) return '';
  return String((typeof value === 'object' && value.message) || value).slice(0, 300);
}

function reportOnce(kind, message, source, line) {
  // Cap checked before the dedup set is touched, not after: a runaway loop throwing *distinct*
  // messages (a counter in the text, say) would otherwise keep growing the set forever long after
  // reporting had stopped - a memory leak inside the very guard meant to stop the beacon becoming
  // the problem. The cap also bounds recursion by construction: even if reporting an error somehow
  // caused another error, it can only happen MAX_CLIENT_ERROR_REPORTS times.
  if (!message || clientErrorsSent >= MAX_CLIENT_ERROR_REPORTS) return;
  const key = `${kind}|${message}|${source}|${line}`;
  if (seenClientErrors.has(key)) return;
  seenClientErrors.add(key);
  clientErrorsSent += 1;
  reportClientError({ kind, message, source, line });
}

window.addEventListener('error', (e) => {
  console.error('[opendockwatch] window.onerror', e.error || e.message, e.filename, e.lineno);
  reportOnce('window.onerror', errText(e.error || e.message), e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[opendockwatch] unhandledrejection', e.reason);
  reportOnce('unhandledrejection', errText(e.reason), null, null);
});

const app = createApp({
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

      view: 'list', // 'list' | 'flow' | 'logs' | 'activity' - reset to the configured default once the session loads, see mounted()
      stateFilter: 'all', // 'all' | 'running' | 'stopped'
      topology: { nodes: [], edges: [] },
      flowFullscreen: false,

      hostInfo: null,
      hostCardFullscreen: false,
      diskUsage: [],
      diskUsageError: null,
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
      logViewerWrap: true,

      // One-shot handoff into the Logs tab's own single-pane state - see openLogsFor. Read once by
      // LogsView's mounted() (it remounts fresh every time view flips into 'logs', v-if not v-show)
      // then cleared, so a later plain click on the Logs nav tab doesn't keep reopening this container.
      logsTabOpenId: null,

      settingsOpen: false,

      // Set only if mounted()'s session/host bootstrap throws - see there. Without this, that
      // failure left '#app' permanently empty with nothing in the console: identical to a network
      // hang from the outside, but caused by a client-side error nobody could see.
      bootError: null,
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
    // A browser allows ~6 connections per origin over HTTP/1.1, so a log-preview stream only
    // runs in the view its component is part of (List/Flow, Logs tab, Activity) - see CLAUDE.md.
    // Gates the panel's *rendering* only; selectedContainerId itself survives a Logs tab trip.
    detailPanelVisible() {
      return !!this.selectedContainer && (this.view === 'list' || this.view === 'flow');
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
    // Preview-stream/inspect state lives in ContainerDetail (its own container.id watcher) and
    // Flow's cy selection sync lives in FlowView (its own selectedContainerId prop watcher) -
    // this only needs to close the sibling log viewer.
    selectedContainerId() {
      this.closeLogViewer();
    },
  },
  async mounted() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    let session;
    try {
      session = await apiGetSession();
      this.role = session.role;
      this.appVersion = session.version;
      await this.loadHosts();
    } catch (err) {
      // apiFetch already redirects to /login on 401 - reaching here means something else failed
      // (server unreachable, a 5xx, a timeout). Previously swallowed silently, which left the page
      // blank forever with no way to tell "still loading" from "never going to load".
      console.error('[opendockwatch] boot failed', err);
      this.bootError = err.message || String(err);
      // Reported rather than only shown: a blank-page-on-load report is the one a user is least
      // likely to be able to describe, and most likely to hit right after a deploy.
      reportOnce('boot', errText(err), null, null);
      return;
    }
    if (this.hosts.length) {
      this.selectHost(this.hosts[0].id);
    }
    // setView (not a direct assignment) so a configured 'flow' default also gets its topology
    // fetched immediately, same as clicking the Flow tab by hand - see setView.
    await this.setView(session.defaultView || 'list');
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
      this.diskUsageError = null;
      this.hostMetricsHistory = [];
      this.containerMetricsHistory = {};
      this.alerts = [];
      this.stopPolling();
      this.fetchHostInfo();
      this.fetchDiskUsage();
      this.startPolling();
    },
    // Chained, never setInterval: refresh() awaits several requests, so a cycle can outlast
    // POLL_MS on a slow host, and an interval would stack another regardless, exhausting the
    // browser's ~6 connections. Measuring the gap from the previous cycle's finish prevents overlap.
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
        // fetchDashboard swallows its own failure into containersError rather than throwing, so
        // the backoff reads that instead of relying on the catch below.
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
    // A cycle was five requests awaited one after another - containers, stats, history, alerts,
    // and topology in Flow view - so it cost five round trips and five turns of the browser's ~6
    // connections per open tab, every POLL_MS, for data the server already holds in memory. Four
    // of them are now fields of one /dashboard response; topology stays its own request (it can
    // shell out to docker) but runs alongside rather than after it, so Flow view is two requests
    // and one round trip. fetchTopology swallows its own errors, so Promise.all can't reject on it.
    async refresh() {
      await Promise.all([this.fetchDashboard(), this.view === 'flow' ? this.fetchTopology() : null]);
    },
    // Same host-switch guard as every other fetch here: a slow response for the host you just
    // navigated away from must not land on the host you are now looking at.
    async fetchDashboard() {
      if (!this.selectedHostId) return;
      const hostId = this.selectedHostId;
      this.loadingContainers = true;
      try {
        const data = await apiGetDashboard(hostId);
        if (this.selectedHostId !== hostId) return;
        this.containers = data.containers;
        this.containersError = null;
        this.stats = data.stats;
        this.recordMetricsSample();
        this.hostMetricsHistory = data.metricsHistory.slice(-HOST_METRICS_HISTORY_LEN);
        this.alerts = data.alerts;
      } catch (err) {
        if (this.selectedHostId !== hostId) return;
        this.containersError = err.message;
      } finally {
        // Only this call's own loading flag - don't clear it out from under a newer, still
        // in-flight fetch for the host the user has since switched to.
        if (this.selectedHostId === hostId) this.loadingContainers = false;
      }
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
        if (this.selectedHostId !== hostId) return;
        this.diskUsage = usage.rows || [];
        this.diskUsageError = usage.error || null;
      } catch {
        /* disk usage is best-effort */
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
    async clearAlertsAction() {
      if (!this.selectedHostId) return;
      try {
        await apiClearAlerts(this.selectedHostId);
        this.alerts = [];
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
      // The host card itself unmounts on the way into Logs (v-if="... && view !== 'logs'"), so
      // nothing would be left to clear this - and .layout stays hidden while it's true, which is
      // the blank-screen bug this guards against. Reset on every switch, not just into Logs: a
      // fullscreen host card has no reason to survive a tab change in general.
      this.hostCardFullscreen = false;
      // The bottom Log Viewer belongs to List/Flow (via the detail panel's button). Closing it
      // on the way into a view that can't open it releases its connection - logViewerOpen is a
      // v-if, so this unmounts and stops the stream. See detailPanelVisible for the budget.
      if (v === 'logs' || v === 'activity') this.closeLogViewer();
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
    // The List view's "Logs" button used to pop open the standalone bottom log-viewer modal - now
    // it takes you to the Logs tab instead, with this container opened there in single-pane mode,
    // where the multi-pane/sync/match-strip machinery lives. The detail panel's own Logs button
    // (@open-log-viewer -> openLogViewer) deliberately still opens the bottom viewer in place:
    // that one is for reading a container's logs *without* leaving List/Flow and losing the
    // selection, which is a different thing to ask for, not a second copy of this.
    async openLogsFor(id) {
      this.settingsOpen = false;
      this.logsTabOpenId = id;
      await this.setView('logs');
      // Let LogsView mount and its own mounted() read logsTabOpenId before clearing it - otherwise
      // a later plain click on the Logs nav tab would keep force-reopening this same container.
      await this.$nextTick();
      this.logsTabOpenId = null;
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
      // The Logs tab's remembered panes are per browser tab, not per account - so signing out has
      // to drop them, or the next person to sign in here arrives at a selection someone else made.
      clearAllOpenPanes();
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
      <div v-if="bootError" class="boot-error">
        <p>OpenDockWatch failed to load: {{ bootError }}</p>
        <p class="muted">Check the browser console and the container's logs for more detail, then reload.</p>
      </div>
      <template v-else>
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
        v-if="hostInfo && !logViewerFullscreen && !flowFullscreen && view !== 'logs' && view !== 'activity'"
        :host-info="hostInfo"
        :host-name="currentHostName"
        :host-id="selectedHostId"
        :metrics-history="hostMetricsHistory"
        :disk-usage="diskUsage"
        :disk-usage-error="diskUsageError"
        :with-detail="detailPanelVisible || settingsOpen"
        v-model:fullscreen="hostCardFullscreen"
      ></host-card>

      <div v-show="!logViewerFullscreen && !hostCardFullscreen" class="layout" :class="{ 'with-detail': detailPanelVisible || settingsOpen }">
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
            :open-container-id="logsTabOpenId"
          ></logs-view>

          <activity-view
            v-if="view === 'activity'"
            :host-id="selectedHostId"
            :alerts="alerts"
            :is-admin="isAdmin"
            @ack="ackAlertAction"
            @ack-all="ackAllAlertsAction"
            @clear-alerts="clearAlertsAction"
          ></activity-view>
        </div>

        <container-detail
          v-if="detailPanelVisible"
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
        :with-detail="detailPanelVisible"
        v-model:fullscreen="logViewerFullscreen"
        v-model:wrap="logViewerWrap"
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
      </template>
    </div>
  `,
});

// Vue's own catch-all for anything thrown inside a component's render/lifecycle/watcher - the
// window listeners above only see errors outside Vue's tracking (vendor scripts, bare promises).
// Without this, a bug in a child component during boot failed exactly like a network hang: no
// console output, '#app' stuck on whatever it last rendered.
app.config.errorHandler = (err, instance, info) => {
  console.error('[opendockwatch] vue error', info, err);
  // `info` (the Vue lifecycle hook that threw) is the useful half here, so it goes in the source
  // slot rather than being dropped - "render function" vs "watcher callback" narrows it a lot.
  reportOnce('vue', errText(err), info, null);
};

app.mount('#app');
