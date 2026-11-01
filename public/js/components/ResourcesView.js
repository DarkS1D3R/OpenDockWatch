import { apiGetInventory } from '../api.js';
import { formatBytes } from '../format.js';
import { formatDuration } from '../lib/duration.js';
import { imageLabel, volumeLabel, summarize, filterRows } from '../lib/inventory.js';

// While the server is re-reading the host, ask again this often. The route answers from memory,
// so each ask is cheap; the poll stops as soon as `refreshing` goes false.
const REFRESHING_POLL_MS = 2_000;

const SECTIONS = [
  { key: 'images', label: 'Images' },
  { key: 'volumes', label: 'Volumes' },
  { key: 'networks', label: 'Networks' },
];

// The Resources tab: a read-only inventory of the selected host's images, volumes and networks.
// Fetched on mount and on Refresh, not polled - see server/inventory.js for the server-side cache.
export default {
  name: 'ResourcesView',
  props: {
    hostId: { type: String, default: null },
  },
  data() {
    return {
      sections: SECTIONS,
      section: 'images',
      search: '',
      unusedOnly: false,
      inventory: null,
      error: null,
      loading: false,
      now: Date.now(),
    };
  },
  computed: {
    rows() {
      return (this.inventory && this.inventory[this.section]) || null;
    },
    shownRows() {
      return filterRows(this.section, this.rows, { query: this.search, unusedOnly: this.unusedOnly });
    },
    summary() {
      return summarize(this.section, this.rows);
    },
    sectionError() {
      if (!this.inventory) return null;
      return this.section === 'networks' ? this.inventory.errors.networks : this.inventory.errors.df;
    },
    measuredTs() {
      if (!this.inventory) return null;
      return this.section === 'networks' ? this.inventory.networksTs : this.inventory.dfTs;
    },
    refreshing() {
      return !!(this.inventory && this.inventory.refreshing);
    },
    buildCache() {
      return this.inventory && this.inventory.buildCache;
    },
  },
  watch: {
    hostId() {
      this.inventory = null;
      this.error = null;
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  beforeUnmount() {
    clearTimeout(this._pollTimer);
    this._pollTimer = null;
    this._unmounted = true;
  },
  methods: {
    formatBytes,
    imageLabel,
    volumeLabel,
    countFor(key) {
      const list = this.inventory && this.inventory[key];
      return list ? list.length : null;
    },
    async load({ refresh = false } = {}) {
      if (!this.hostId) return;
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
      const hostId = this.hostId;
      this.loading = true;
      try {
        const inv = await apiGetInventory(hostId, { refresh });
        if (this.hostId !== hostId || this._unmounted) return; // a host switch landed while this was in flight
        this.inventory = inv;
        this.error = null;
        this.now = Date.now();
        if (inv.refreshing) this._pollTimer = setTimeout(() => this.load(), REFRESHING_POLL_MS);
      } catch (err) {
        if (this.hostId !== hostId || this._unmounted) return;
        this.error = err.message;
      } finally {
        if (this.hostId === hostId) this.loading = false;
      }
    },
    ago(ts) {
      return ts ? `${formatDuration(Math.max(0, this.now - ts))} ago` : null;
    },
    statusLabel(row) {
      if (this.section === 'networks' && row.builtin) return 'Built-in';
      if (row.unused === null) return 'Unknown';
      if (row.unused) return this.section === 'images' && row.dangling ? 'Unused, dangling' : 'Unused';
      return 'In use';
    },
    statusClass(row) {
      if (this.section === 'networks' && row.builtin) return 'resource-flag-builtin';
      return row.unused ? 'resource-flag-unused' : row.unused === false ? 'resource-flag-used' : '';
    },
  },
  template: `
    <div class="resources-view">
      <div class="log-section-header">
        <h3>Resources</h3>
        <div class="view-toggle" role="group" aria-label="Resource type">
          <button v-for="s in sections" :key="s.key" :class="{active: section===s.key}" :aria-pressed="String(section===s.key)" @click="section = s.key">
            {{ s.label }}<span v-if="countFor(s.key) !== null" class="resources-count"> ({{ countFor(s.key) }})</span>
          </button>
        </div>
        <button class="resources-refresh" :disabled="refreshing" @click="load({ refresh: true })">
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="sectionError" class="error" role="alert">
        Could not read {{ section }}: {{ sectionError }}{{ rows ? ' (showing the last successful reading)' : '' }}
      </p>

      <p v-if="!rows && (loading || refreshing)" class="muted">
        Reading {{ section }}…<span v-if="section !== 'networks'"> Measuring image and volume sizes can take a minute on some hosts.</span>
      </p>

      <template v-else-if="rows">
        <p class="resources-summary">
          <strong>{{ summary.count }}</strong> {{ section }}
          <span v-if="summary.bytes !== null"> · {{ formatBytes(summary.bytes) }}</span>
          · <strong>{{ summary.unused }}</strong> unused
          <span v-if="summary.unusedBytes !== null && summary.unused" class="muted"
            :title="section === 'images' ? 'Unique size: layers no other image shares' : null">
            ({{ formatBytes(summary.unusedBytes) }}{{ section === 'images' ? ' unique' : '' }})
          </span>
          <span v-if="measuredTs" class="muted"> · measured {{ ago(measuredTs) }}</span>
        </p>
        <p v-if="section === 'images' && buildCache && buildCache.count" class="muted resources-build-cache">
          Build cache: {{ buildCache.count }} entries · {{ formatBytes(buildCache.sizeBytes) }} · {{ formatBytes(buildCache.reclaimableBytes) }} not in use
        </p>

        <div class="resources-filters">
          <div class="search-clear-wrap uptime-search-wrap">
            <input type="text" v-model="search" :placeholder="'Filter ' + section + '…'" :aria-label="'Filter ' + section" class="uptime-search" />
            <button aria-label="Clear filter" v-if="search" class="filter-clear-btn" @click="search = ''" title="Clear filter">✕</button>
          </div>
          <div class="view-toggle">
            <button :class="{active: unusedOnly}" :aria-pressed="String(unusedOnly)" @click="unusedOnly = !unusedOnly">Unused only</button>
          </div>
        </div>

        <p v-if="!rows.length" class="muted">No {{ section }} on this host.</p>
        <p v-else-if="!shownRows.length" class="muted">No {{ unusedOnly ? 'unused ' : '' }}{{ section }}{{ search.trim() ? ' match "' + search.trim() + '"' : '' }}.</p>

        <table v-else-if="section === 'images'" class="uptime-table resources-table">
          <thead>
            <tr><th>Image</th><th>ID</th><th>Size</th><th title="Layers no other image shares">Unique</th><th>Containers</th><th>Created</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr v-for="img in shownRows" :key="img.id + (img.repository || '') + (img.tag || '')">
              <td class="mono">{{ imageLabel(img) }}</td>
              <td class="mono muted">{{ img.id }}</td>
              <td>{{ img.size }}</td>
              <td class="muted">{{ img.uniqueSize }}</td>
              <td>{{ img.containers }}</td>
              <td class="muted">{{ img.createdSince }}</td>
              <td><span class="resource-flag" :class="statusClass(img)">{{ statusLabel(img) }}</span></td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="section === 'volumes'" class="uptime-table resources-table">
          <thead>
            <tr><th>Volume</th><th>Project</th><th>Driver</th><th>Size</th><th>Containers</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr v-for="vol in shownRows" :key="vol.name">
              <td class="mono" :title="vol.name">{{ volumeLabel(vol) }} <span v-if="vol.anonymous" class="muted small">(anonymous)</span></td>
              <td class="muted">{{ vol.composeProject || '—' }}</td>
              <td class="muted">{{ vol.driver || '—' }}</td>
              <td>{{ vol.size || '—' }}</td>
              <td>{{ vol.containers }}</td>
              <td><span class="resource-flag" :class="statusClass(vol)">{{ statusLabel(vol) }}</span></td>
            </tr>
          </tbody>
        </table>

        <table v-else class="uptime-table resources-table">
          <thead>
            <tr><th>Network</th><th>Project</th><th>Driver</th><th>Scope</th><th>Containers</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr v-for="net in shownRows" :key="net.id || net.name">
              <td class="mono">{{ net.name }} <span v-if="net.internal" class="muted small" title="No route outside the host">(internal)</span></td>
              <td class="muted">{{ net.composeProject || '—' }}</td>
              <td class="muted">{{ net.driver || '—' }}</td>
              <td class="muted">{{ net.scope || '—' }}</td>
              <td class="resources-net-containers">
                <template v-if="net.builtin">—</template>
                <template v-else-if="net.containers">{{ net.containers.length ? net.containers.join(', ') : '0' }}</template>
                <template v-else>—</template>
              </td>
              <td><span class="resource-flag" :class="statusClass(net)">{{ statusLabel(net) }}</span></td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  `,
};
