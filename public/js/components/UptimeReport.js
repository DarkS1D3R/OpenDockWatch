import { apiGetUptime } from '../api.js';
import { formatDuration, formatPercent } from '../lib/duration.js';

// A report, not a live view: fetched once per hostId/window change rather than polled, since the
// numbers it shows are a rollup over days and wouldn't visibly move on a 5s refresh - unlike every
// other tab, mounting this one costs zero ongoing connections. See server/uptime.js for how the
// numbers themselves are reconstructed from durable history rather than sampled.
export default {
  name: 'UptimeReport',
  props: {
    hostId: { type: String, default: null },
  },
  data() {
    return {
      days: 30,
      loading: false,
      error: null,
      report: null,
      search: '',
    };
  },
  computed: {
    // At least one container reporting a real health signal - if none do, the Healthy column is
    // just a second copy of Up and only clutters the table.
    anyHealthchecks() {
      return !!this.report && this.report.containers.some((c) => c.hasHealthcheck);
    },
    sortedContainers() {
      if (!this.report) return [];
      // Worst uptime first - the whole point of a report is finding what to look at, and nulls
      // (no data at all) sort last rather than first, where they'd read as the worst offenders.
      return [...this.report.containers].sort((a, b) => {
        if (a.upPercent === null) return 1;
        if (b.upPercent === null) return -1;
        return a.upPercent - b.upPercent;
      });
    },
    // Name or compose project, same substring/case-insensitive match ContainerList's own filter
    // uses - a host with many projects is exactly where this report is worth searching.
    filteredContainers() {
      const q = this.search.trim().toLowerCase();
      if (!q) return this.sortedContainers;
      return this.sortedContainers.filter(
        (c) => (c.name || c.id).toLowerCase().includes(q) || (c.composeProject || '').toLowerCase().includes(q)
      );
    },
  },
  watch: {
    hostId() {
      this.load();
    },
    days() {
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    formatDuration,
    formatPercent,
    async load() {
      if (!this.hostId) return;
      const hostId = this.hostId;
      this.loading = true;
      this.error = null;
      try {
        const report = await apiGetUptime(hostId, { days: this.days });
        if (this.hostId !== hostId) return; // a host switch landed while this was in flight
        this.report = report;
      } catch (err) {
        if (this.hostId !== hostId) return;
        this.error = err.message;
      } finally {
        if (this.hostId === hostId) this.loading = false;
      }
    },
  },
  template: `
    <div class="uptime-report">
      <div class="log-section-header">
        <h3>Uptime</h3>
        <div class="view-toggle">
          <button :class="{active: days===1}" @click="days=1">24h</button>
          <button :class="{active: days===7}" @click="days=7">7d</button>
          <button :class="{active: days===30}" @click="days=30">30d</button>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="loading && !report" class="muted">Loading…</p>
      <template v-else-if="report">
        <p class="uptime-host-summary">
          Host reachable <strong>{{ formatPercent(report.host.upPercent) }}</strong> of the last {{ days }}d
          <span v-if="report.host.downMs" class="muted">({{ formatDuration(report.host.downMs) }} down)</span>
          <span v-if="report.host.unknownMs" class="muted" title="No reachability history covers this part of the window">
            · {{ formatDuration(report.host.unknownMs) }} with no data
          </span>
        </p>

        <div v-if="sortedContainers.length" class="search-clear-wrap uptime-search-wrap">
          <input type="text" v-model="search" placeholder="Filter by container or project…" class="uptime-search" />
          <button v-if="search" class="filter-clear-btn" @click="search = ''" title="Clear filter">✕</button>
        </div>

        <p v-if="!sortedContainers.length" class="muted">No container history in this window.</p>
        <p v-else-if="!filteredContainers.length" class="muted">No containers match "{{ search.trim() }}".</p>
        <table v-else class="uptime-table">
          <thead>
            <tr>
              <th>Container</th>
              <th>Project</th>
              <th>Up</th>
              <th v-if="anyHealthchecks">Healthy</th>
              <th>Down</th>
              <th>Restarts</th>
              <th>No data</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in filteredContainers" :key="c.id" :class="{ 'uptime-removed-row': c.removed }">
              <td>{{ c.name || c.id }} <span v-if="c.removed" class="muted" title="No longer running on this host">(removed)</span></td>
              <td class="muted">{{ c.composeProject || '—' }}</td>
              <td>{{ formatPercent(c.upPercent) }}</td>
              <td v-if="anyHealthchecks">{{ c.hasHealthcheck ? formatPercent(c.healthyPercent) : '—' }}</td>
              <td class="muted">{{ formatDuration(c.downMs) }}</td>
              <td>{{ c.restartCount }}</td>
              <td class="muted">{{ c.unknownMs ? formatDuration(c.unknownMs) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  `,
};
