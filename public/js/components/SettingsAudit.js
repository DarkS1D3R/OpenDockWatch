import { apiGetAuditLog, apiGetHostsConfig } from '../api.js';
import { filterAudit, resultClass } from '../lib/auditFilter.js';

const LIMITS = [200, 500, 1000];

// The Settings panel's Audit log tab: who ran what, from `GET /api/audit` (admin-only, since the
// error column carries raw docker/ssh stderr). A snapshot you refresh by hand, like the other
// Settings tabs - nothing here is worth a poll. Rows are never edited or deleted from here.
export default {
  name: 'SettingsAudit',
  data() {
    return {
      rows: [],
      hosts: [],
      hostId: '',
      limit: LIMITS[0],
      search: '',
      failuresOnly: false,
      loading: false,
      error: null,
      limits: LIMITS,
    };
  },
  computed: {
    view() {
      return filterAudit(this.rows, { search: this.search, failuresOnly: this.failuresOnly });
    },
    // The server caps at the requested limit, so a full page means there is probably more behind it.
    mayHaveMore() {
      return this.rows.length >= this.limit;
    },
  },
  // Both change what the server is asked for, so they refetch; the search and the failures box only
  // narrow what is already loaded and need no request.
  watch: {
    hostId: 'load',
    limit: 'load',
  },
  async mounted() {
    // The host list only feeds the filter - a failure there should not stop the log from loading.
    apiGetHostsConfig()
      .then((hosts) => (this.hosts = hosts))
      .catch(() => {});
    await this.load();
  },
  methods: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        this.rows = await apiGetAuditLog(this.hostId, this.limit);
      } catch (err) {
        this.error = err.message;
      } finally {
        this.loading = false;
      }
    },
    resultClass,
    formatTime(ts) {
      return new Date(ts).toLocaleString();
    },
    // Clearing alerts or events has no container; say what it did to rather than leaving a dash.
    target(row) {
      return row.container_name || row.container_id || 'whole host';
    },
  },
  template: `
    <div>
      <p class="muted small">
        Who ran each container action and each Clear, newest first. Kept for as long as events are
        (EVENTS_RETENTION_DAYS).
      </p>
      <div class="audit-toolbar">
        <select v-model="hostId" title="Which host's actions to show">
          <option value="">All hosts</option>
          <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name || h.id }}</option>
        </select>
        <select v-model.number="limit" title="How many of the newest rows to load">
          <option v-for="n in limits" :key="n" :value="n">Last {{ n }}</option>
        </select>
        <button class="small-btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>
      <div class="audit-toolbar">
        <div class="search-clear-wrap audit-search-wrap">
          <input type="text" v-model="search" placeholder="Search user, container, action, error…" />
          <button v-if="search" class="filter-clear-btn" @click="search = ''" title="Clear search">✕</button>
        </div>
        <label class="audit-check"><input type="checkbox" v-model="failuresOnly" /> Failures only</label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="!loading && !rows.length" class="muted">No actions recorded yet.</p>
      <p v-else-if="!view.length" class="muted">No matching entries.</p>
      <div v-else class="audit-table-wrap">
        <table class="audit-table">
          <thead>
            <tr><th>Time</th><th>User</th><th>Host</th><th>Container</th><th>Action</th><th>Result</th></tr>
          </thead>
          <tbody>
            <template v-for="r in view" :key="r.id">
              <tr>
                <td class="muted">{{ formatTime(r.ts) }}</td>
                <td>{{ r.username || '—' }}</td>
                <td>{{ r.host_id }}</td>
                <td :title="r.container_id || ''">{{ target(r) }}</td>
                <td class="mono">{{ r.action }}</td>
                <td><span class="audit-badge" :class="resultClass(r.result)">{{ r.result }}</span></td>
              </tr>
              <tr v-if="r.error" class="audit-error-row"><td colspan="6">{{ r.error }}</td></tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-if="rows.length && !error" class="muted small">
        Showing {{ view.length }} of {{ rows.length }} loaded<template v-if="mayHaveMore"> - there are older entries, raise the limit to see them</template>.
      </p>
    </div>
  `,
};
