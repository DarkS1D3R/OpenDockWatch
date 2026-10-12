import { POLL_MS, MAX_POLL_BACKOFF_MS, HIDDEN_POLL_MS } from '../constants.js';
import { apiGetOverview } from '../api.js';
import { stateEmoji } from '../format.js';
import {
  STATUS_LABELS,
  sortOverviewRows,
  overviewSummary,
  containersLabel,
  containerProblems,
  cpuLabel,
  memLabel,
  memPercent,
  downForLabel,
} from '../lib/hostOverview.js';

// The Hosts tab: one row per configured host from GET /api/overview. Mounted with v-if and owns its
// own chained poll, so it costs one request per POLL_MS only while on screen. See public/CLAUDE.md.
export default {
  name: 'HostsOverview',
  props: {
    selectedHostId: { type: String, default: null },
  },
  emits: ['open-host'],
  data() {
    return {
      rows: null,
      error: null,
      failures: 0,
      timer: null,
      stopped: false,
      now: Date.now(),
    };
  },
  computed: {
    sortedRows() {
      return this.rows ? sortOverviewRows(this.rows) : [];
    },
    summary() {
      return this.rows ? overviewSummary(this.rows) : '';
    },
    anyProblem() {
      return this.sortedRows.some((r) => r.status === 'down' || r.status === 'warning');
    },
  },
  mounted() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.tick();
  },
  beforeUnmount() {
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  },
  methods: {
    containersLabel,
    containerProblems,
    cpuLabel,
    memLabel,
    memPercent,
    statusLabel(row) {
      return STATUS_LABELS[row.status] || row.status;
    },
    downFor(row) {
      return downForLabel(row, this.now);
    },
    // The same icons as a container's state, so the Hosts tab and the List view speak one colour language.
    statusIcon(row) {
      if (row.status === 'down') return stateEmoji('exited', null);
      if (row.status === 'pending') return stateEmoji('created', null);
      return stateEmoji('running', row.status === 'warning' ? 'unhealthy' : null);
    },
    async tick() {
      if (this.stopped) return;
      if (document.hidden) return this.schedule(HIDDEN_POLL_MS);
      try {
        this.rows = await apiGetOverview();
        this.now = Date.now();
        this.error = null;
        this.failures = 0;
      } catch (err) {
        this.error = err.message;
        this.failures += 1;
      }
      this.schedule(this.failures ? Math.min(POLL_MS * 2 ** Math.min(this.failures, 5), MAX_POLL_BACKOFF_MS) : POLL_MS);
    },
    schedule(delay) {
      if (this.stopped) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.tick(), delay);
    },
    onVisibilityChange() {
      if (!document.hidden && !this.stopped) this.schedule(0);
    },
    open(row, view = 'list') {
      this.$emit('open-host', { id: row.id, view });
    },
    rowLabel(row) {
      return `${row.name}, ${this.statusLabel(row)} - press Enter to open`;
    },
  },
  template: `
    <div class="hosts-overview">
      <div class="log-section-header">
        <h3>Hosts</h3>
      </div>
      <p v-if="error" class="error" role="alert">Could not load the overview: {{ error }}</p>
      <p v-if="!rows && !error" class="muted">Loading…</p>
      <template v-if="rows">
        <p class="hosts-summary" :class="{ 'hosts-summary-problem': anyProblem }" role="status">{{ summary }}</p>
        <table v-if="sortedRows.length" class="hosts-table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Status</th>
              <th>Containers</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Open alerts</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in sortedRows"
              :key="row.id"
              class="row-clickable"
              :class="['host-row-' + row.status, { 'row-selected': row.id === selectedHostId }]"
              tabindex="0"
              :aria-label="rowLabel(row)"
              @click="open(row)"
              @keydown.enter.self="open(row)"
              @keydown.space.self.prevent="open(row)"
            >
              <td>
                <span class="host-name">{{ row.name }}</span> <span v-if="row.remote" class="host-kind muted" title="Reached over SSH">SSH</span>
                <span v-if="row.engine === 'podman'" class="host-kind muted" title="A Podman engine, through its Docker-compatible API">Podman</span>
                <span v-if="row.id === selectedHostId" class="visually-hidden"> (selected)</span>
              </td>
              <td>
                <span class="host-status">
                  <span class="host-status-icon" aria-hidden="true" v-html="statusIcon(row)"></span>
                  <span>{{ statusLabel(row) }}</span>
                </span>
                <div v-if="downFor(row)" class="muted small">{{ downFor(row) }}</div>
              </td>
              <td>
                {{ containersLabel(row) }}
                <div v-for="p in containerProblems(row)" :key="p" class="host-problem small">{{ p }}</div>
                <div v-if="row.imageUpdates" class="image-update-update small">{{ row.imageUpdates }} with a newer image</div>
              </td>
              <td class="muted">{{ cpuLabel(row) }}</td>
              <td class="muted">
                {{ memLabel(row) }}
                <span v-if="memPercent(row) !== null" class="small">({{ memPercent(row).toFixed(0) }}%)</span>
              </td>
              <td>
                <button
                  v-if="row.openAlerts"
                  type="button"
                  class="host-alerts-btn"
                  :aria-label="row.openAlerts + ' open alert' + (row.openAlerts === 1 ? '' : 's') + ' on ' + row.name + ' - open Activity'"
                  @click.stop="open(row, 'activity')"
                >{{ row.openAlerts }}</button>
                <span v-else class="muted">0</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  `,
};
