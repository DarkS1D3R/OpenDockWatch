import { apiSearchComposeLogs } from '../api.js';
import { SEARCH_WINDOWS, DEFAULT_SEARCH_MINUTES, searchRows, searchSummary, searchWarnings } from '../lib/logSearch.js';

// The Logs tab's compose-wide search: one query over every container in a project, merged into a
// single timeline. A one-shot request, not a stream, so it costs no held connection. Clicking a
// row asks LogsView to open that container's pane at the line. See public/CLAUDE.md.
export default {
  name: 'LogSearchPanel',
  props: {
    hostId: { type: String, required: true },
    project: { type: String, required: true },
    // Ids currently in the container list - a match from a container that has since been removed
    // has no log left to open, so its row is shown but not clickable.
    containerIds: { type: Array, required: true },
    wrap: { type: Boolean, default: true },
  },
  emits: ['open-at', 'close'],
  data() {
    return {
      query: '',
      sinceMinutes: DEFAULT_SEARCH_MINUTES,
      windows: SEARCH_WINDOWS,
      loading: false,
      error: null,
      result: null,
      // The query the shown result was searched for, so editing the box doesn't re-highlight
      // results that were never matched against the new text.
      ranQuery: '',
    };
  },
  computed: {
    rows() {
      return this.result ? searchRows(this.result.matches, this.ranQuery) : [];
    },
    summary() {
      return this.result ? searchSummary(this.result) : '';
    },
    warnings() {
      return this.result ? searchWarnings(this.result) : [];
    },
  },
  watch: {
    // A different project is a different search: results from the old one would read as this one's.
    project() {
      this.result = null;
      this.error = null;
      this._seq = (this._seq || 0) + 1;
      this.loading = false;
      this.$nextTick(() => this.$refs.input && this.$refs.input.focus());
    },
  },
  mounted() {
    this.$refs.input.focus();
  },
  methods: {
    async run() {
      const q = this.query.trim();
      if (!q || this.loading) return;
      // A response from a search the user has since moved past (project switch) is dropped.
      const seq = (this._seq = (this._seq || 0) + 1);
      this.loading = true;
      this.error = null;
      try {
        const result = await apiSearchComposeLogs(this.hostId, this.project, { q, sinceMinutes: this.sinceMinutes });
        if (seq !== this._seq) return;
        this.result = result;
        this.ranQuery = q;
      } catch (err) {
        if (seq !== this._seq) return;
        this.error = err.message;
      } finally {
        if (seq === this._seq) this.loading = false;
      }
    },
    canOpen(row) {
      return row.tsMs != null && this.containerIds.includes(row.containerId);
    },
    openRow(row) {
      if (this.canOpen(row)) this.$emit('open-at', { containerId: row.containerId, tsMs: row.tsMs });
    },
  },
  template: `
    <div class="log-panel embedded log-search-panel">
      <div class="log-panel-header">
        <div class="log-search-titlebar">
          <span class="log-panel-name" :title="project">Search logs in <strong>{{ project }}</strong></span>
          <button aria-label="Close search and go back to the open panes" class="small-btn log-pane-close-btn" @click="$emit('close')" title="Close search and go back to the open panes">✕</button>
        </div>
        <form class="log-search-form" @submit.prevent="run">
          <input
            ref="input"
            v-model="query"
            type="text"
            maxlength="200"
            class="log-search-input"
            aria-label="Text to search for"
            placeholder="Text to find in every container's log - a request id, an email, an error…"
          />
          <select v-model.number="sinceMinutes" title="How far back to search" aria-label="How far back to search">
            <option v-for="w in windows" :key="w.minutes" :value="w.minutes">{{ w.label }}</option>
          </select>
          <button type="submit" class="small-btn" :disabled="!query.trim() || loading">{{ loading ? 'Searching…' : 'Search' }}</button>
        </form>
        <div v-if="error" class="log-search-error" role="alert">{{ error }}</div>
        <div v-else-if="result" class="log-search-summary muted" role="status">{{ summary }}</div>
        <div v-for="w in warnings" :key="w" class="log-search-warning">{{ w }}</div>
      </div>
      <div class="log-view-wrap">
        <div v-if="loading" class="log-loading-overlay"><span class="spinner"></span> Searching every container…</div>
        <div v-if="!result && !loading" class="log-search-empty muted">Case-insensitive, across every container in this project - stopped ones included. Click a result to open that container's log at the line.</div>
        <pre v-else class="log-view log-viewer-pane" :class="{ 'no-wrap': !wrap }"><div
          v-for="row in rows"
          :key="row.id"
          class="log-line log-search-row"
          :class="{ 'search-line-clickable': canOpen(row) }"
          :title="canOpen(row) ? 'Open ' + row.containerName + ' at this line' : 'This container is no longer in the list'"
          :role="canOpen(row) ? 'button' : null"
          :tabindex="canOpen(row) ? 0 : null"
          @click="openRow(row)"
          @keydown.enter.prevent="openRow(row)"
          @keydown.space.prevent="openRow(row)"
        ><span class="log-search-container">{{ row.containerName }}</span><span v-html="row.html"></span></div></pre>
      </div>
    </div>
  `,
};
