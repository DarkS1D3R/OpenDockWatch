import { POLL_MS, HISTORY_RANGE_SLOTS } from '../constants.js';
import { formatBytes, formatRate } from '../format.js';
import { apiGetMetricsHistory } from '../api.js';
import SparkTile from './SparkTile.js';

const RANGES = [
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
];

// One container's persisted metrics history over a selectable window - unlike the List row's
// sparklines (root's few-minute in-memory buffer), this reads sqlite history via
// GET /metrics/history. All four charts share one hoverIndex so spikes line up across them.
export default {
  name: 'ContainerMetricsModal',
  components: { SparkTile },
  props: {
    hostId: { type: String, required: true },
    containerId: { type: String, required: true },
    containerName: { type: String, default: '' },
  },
  emits: ['close'],
  data() {
    return {
      ranges: RANGES,
      range: '1h',
      rows: [],
      loading: true,
      error: null,
      hoverIndex: null,
    };
  },
  computed: {
    slotCount() {
      return HISTORY_RANGE_SLOTS[this.range];
    },
    sampleTimes() {
      return this.rows.map((r) => r.bucket);
    },
    cpuSamples() {
      return this.rows.map((r) => r.cpuPerc);
    },
    memSamples() {
      return this.rows.map((r) => r.memUsedBytes);
    },
    // The I/O series are rates derived server-side from cumulative counters (metricsHistory.js),
    // so null is ordinary, not exceptional: the first bucket has nothing to diff against, and a
    // restart-spanning bucket has a counter reset. Passed through as nulls; sparkPaths skips them.
    netRxSamples() {
      return this.rows.map((r) => r.netRxRate);
    },
    netTxSamples() {
      return this.rows.map((r) => r.netTxRate);
    },
    blockReadSamples() {
      return this.rows.map((r) => r.blockReadRate);
    },
    blockWriteSamples() {
      return this.rows.map((r) => r.blockWriteRate);
    },
    hasRows() {
      return this.rows.length > 0;
    },
  },
  watch: {
    range() {
      this.fetchHistory();
      this.restartRefresh();
    },
  },
  mounted() {
    this.fetchHistory();
    this.restartRefresh();
    // Bound once and kept, so beforeUnmount removes the same reference it added.
    this._onKeydown = (event) => {
      if (event.key === 'Escape') this.$emit('close');
    };
    window.addEventListener('keydown', this._onKeydown);
  },
  beforeUnmount() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    window.removeEventListener('keydown', this._onKeydown);
  },
  methods: {
    // Only the 1h range keeps refreshing. Its buckets are 15s wide, so a 5s poll actually moves
    // the chart; the 24h and 7d buckets are 5 and 30 minutes wide, where re-fetching every 5s
    // would redraw an identical chart for minutes on end.
    restartRefresh() {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
      this._refreshTimer = null;
      if (this.range === '1h') {
        this._refreshTimer = setInterval(() => this.fetchHistory({ silent: true }), POLL_MS);
      }
    },
    async fetchHistory({ silent = false } = {}) {
      const { range } = this;
      // The background refresh must not flash the loading state over a chart that's already on
      // screen - only an explicit open or range switch does that.
      if (!silent) this.loading = true;
      try {
        const rows = await apiGetMetricsHistory(this.hostId, { range, containerId: this.containerId });
        // A slow request for the range the user has since switched away from must not land over
        // the newer one's data - same guard the root's own fetches use for a host switch.
        if (this.range !== range) return;
        this.rows = rows;
        this.error = null;
      } catch (err) {
        if (this.range === range) this.error = err.message;
      } finally {
        if (this.range === range) this.loading = false;
      }
    },
    fmtPercent(v) {
      return (v || 0).toFixed(1) + '%';
    },
    fmtBytes(v) {
      return formatBytes(v);
    },
    fmtRate(v) {
      return formatRate(v);
    },
    onBackdropClick(event) {
      // Only a click on the backdrop itself - not one that bubbled up from inside the dialog.
      if (event.target === event.currentTarget) this.$emit('close');
    },
  },
  template: `
    <div class="metrics-modal-backdrop" @click="onBackdropClick">
      <div class="metrics-modal" role="dialog" aria-modal="true" :aria-label="'Metrics for ' + containerName">
        <div class="metrics-modal-header">
          <div>
            <strong>{{ containerName || containerId }}</strong>
            <div class="muted small">Metrics history</div>
          </div>
          <div class="view-toggle">
            <button
              v-for="r in ranges"
              :key="r.key"
              :class="{ active: range === r.key }"
              @click="range = r.key"
            >{{ r.label }}</button>
          </div>
          <button class="small-btn" @click="$emit('close')" title="Close">✕</button>
        </div>

        <div class="metrics-modal-body">
          <p v-if="error" class="error">{{ error }}</p>
          <p v-else-if="loading && !hasRows" class="muted">Loading…</p>
          <p v-else-if="!hasRows" class="muted">
            No history recorded for this container over the last {{ range }}.
          </p>
          <template v-else>
            <spark-tile
              variant="cpu"
              label="CPU"
              :samples="cpuSamples"
              :format-value="fmtPercent"
              :sample-times="sampleTimes"
              :slot-count="slotCount"
              :hover-index="hoverIndex"
              :detailed="true"
              @hover="hoverIndex = $event"
              @leave="hoverIndex = null"
            ></spark-tile>
            <spark-tile
              variant="mem"
              label="Memory"
              :samples="memSamples"
              :format-value="fmtBytes"
              :sample-times="sampleTimes"
              :slot-count="slotCount"
              :hover-index="hoverIndex"
              :detailed="true"
              @hover="hoverIndex = $event"
              @leave="hoverIndex = null"
            ></spark-tile>
            <spark-tile
              variant="net"
              label="Network I/O"
              :samples="netRxSamples"
              :secondary-samples="netTxSamples"
              primary-label="rx"
              secondary-label="tx"
              :format-value="fmtRate"
              :sample-times="sampleTimes"
              :slot-count="slotCount"
              :hover-index="hoverIndex"
              :detailed="true"
              @hover="hoverIndex = $event"
              @leave="hoverIndex = null"
            ></spark-tile>
            <spark-tile
              variant="block"
              label="Block I/O"
              :samples="blockReadSamples"
              :secondary-samples="blockWriteSamples"
              primary-label="read"
              secondary-label="write"
              :format-value="fmtRate"
              :sample-times="sampleTimes"
              :slot-count="slotCount"
              :hover-index="hoverIndex"
              :detailed="true"
              @hover="hoverIndex = $event"
              @leave="hoverIndex = null"
            ></spark-tile>
          </template>
        </div>
      </div>
    </div>
  `,
};
