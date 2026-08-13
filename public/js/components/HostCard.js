import { formatGB } from '../format.js';
import { apiGetDiskUsageImages, apiGetMetricsHistory } from '../api.js';
import { resolveHostMemoryDisplay } from '../lib/hostMemory.js';
import { POLL_MS, HISTORY_RANGE_SLOTS, HOST_METRICS_HISTORY_LEN } from '../constants.js';
import SparkTile from './SparkTile.js';

// 'live' is the root's rolling window (the metricsHistory prop, refreshed every poll); the other
// three re-read sqlite over the same GET /metrics/history the container modal uses, minus its
// containerId. Offered only in fullscreen - a shared-row tile has no space for a range strip.
const RANGES = [
  { key: 'live', label: 'Live' },
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
];

// The host header (name + container count + Docker version) plus the CPU/RAM SparkTiles and the
// disk-usage tile. Owns deriving the Docker and host-total sample series from the raw metrics
// history rows, since metricsCollector writes both into the same host_metrics row every poll.
export default {
  name: 'HostCard',
  components: { SparkTile },
  props: {
    hostInfo: { type: Object, required: true },
    hostName: { type: String, required: true },
    hostId: { type: String, default: null },
    metricsHistory: { type: Array, default: () => [] },
    diskUsage: { type: Array, default: () => [] },
    withDetail: { type: Boolean, default: false },
    fullscreen: { type: Boolean, default: false },
  },
  emits: ['update:fullscreen'],
  data() {
    return {
      // Shared between both SparkTiles (not local to either) so hovering the CPU graph shows the
      // crosshair on the RAM graph at the same x position too, and vice versa - the point being
      // to let a CPU spike be correlated against what RAM was doing at that same moment.
      hoverIndex: null,
      ranges: RANGES,
      range: 'live',
      // Only populated for a non-live range; 'live' reads the metricsHistory prop instead, so the
      // card costs no extra request at all until someone actually widens the window.
      rangeRows: [],
      rangeLoading: false,
      rangeError: null,
      // Per-image breakdown - fetched lazily the first time the Images disclosure opens (see
      // onImagesToggle), not alongside the regular disk-usage poll, since walking every image's
      // layer sizes is extra work nobody needs unless they're actually looking at the list.
      imagesExpanded: false,
      images: [],
      imagesLoaded: false,
      imagesLoading: false,
      imagesError: null,
    };
  },
  watch: {
    hostId() {
      this.images = [];
      this.imagesLoaded = false;
      this.imagesError = null;
      // If the disclosure was already open (from the previous host), refresh in place rather
      // than leaving it open over a now-empty/stale list.
      if (this.imagesExpanded) this.loadImages();
      // The other host's rows describe a different machine - drop straight back to live rather
      // than leaving them on screen under the new host's name until a refetch lands.
      this.resetRange();
    },
    range() {
      this.fetchRangeHistory();
      this.restartRangeRefresh();
    },
    // The range strip only exists in fullscreen, so leaving it would strand a non-live range with
    // no way back to live - and keep its refresh timer running behind a tile that can't show it.
    fullscreen(on) {
      if (!on) this.resetRange();
    },
  },
  beforeUnmount() {
    if (this._rangeTimer) clearInterval(this._rangeTimer);
  },
  computed: {
    // The single source every series below reads, so switching range swaps all of them at once
    // and the two tiles can never end up drawing different windows.
    activeHistory() {
      return this.range === 'live' ? this.metricsHistory : this.rangeRows;
    },
    // Samples are right-aligned into this many slots, so a 7d window on a two-day-old install
    // draws in the right-hand part of the chart instead of stretching to fill it.
    slotCount() {
      return HISTORY_RANGE_SLOTS[this.range] || HOST_METRICS_HISTORY_LEN;
    },
    rangeEmpty() {
      return this.range !== 'live' && !this.rangeLoading && !this.rangeError && !this.activeHistory.length;
    },
    cpuSamples() {
      return this.activeHistory.map((s) => s.cpuPercent);
    },
    memSamples() {
      return this.activeHistory.map((s) => s.memUsedBytes);
    },
    // Both series come from the same host_metrics row each poll (see module comment above), so
    // one shared timestamps array covers CPU and RAM (and their host-total counterparts) alike.
    sampleTimes() {
      return this.activeHistory.map((s) => s.bucket);
    },
    // Host-total figures - real host-wide CPU/mem (every process, not just this app's
    // containers), local-host-only (null fields for a remote SSH host) - see hostUsage.js.
    hostSystemUsage() {
      const last = this.activeHistory[this.activeHistory.length - 1];
      return last && last.systemMemTotalBytes != null
        ? { cpuPercent: last.systemCpuPercent, memUsedBytes: last.systemMemUsedBytes, memTotalBytes: last.systemMemTotalBytes }
        : null;
    },
    hostCpuSamples() {
      return this.activeHistory.map((s) => s.systemCpuPercent);
    },
    hostMemSamples() {
      return this.activeHistory.map((s) => s.systemMemUsedBytes);
    },
    // What the mem tile's corner box shows - defers to hostMemory.js to detect and correct for
    // Docker running inside something (a Proxmox LXC) that caps memory below what
    // hostSystemUsage's os.totalmem() sees. Null (same as hostSystemUsage) on a remote host.
    memHostDisplay() {
      return resolveHostMemoryDisplay({
        osUsedBytes: this.hostSystemUsage ? this.hostSystemUsage.memUsedBytes : null,
        osTotalBytes: this.hostSystemUsage ? this.hostSystemUsage.memTotalBytes : null,
        dockerTotalBytes: this.hostInfo.memTotalBytes,
        dockerUsedBytes: this.memSamples[this.memSamples.length - 1],
      });
    },
  },
  methods: {
    diskRow(type) {
      return this.diskUsage.find((r) => r.type === type) || null;
    },
    fmtGB(bytes) {
      return formatGB(bytes || 0);
    },
    fmtPercent(v) {
      return (v || 0).toFixed(1) + '%';
    },
    toggleFullscreen() {
      this.$emit('update:fullscreen', !this.fullscreen);
    },
    resetRange() {
      this.range = 'live';
      this.rangeRows = [];
      this.rangeError = null;
      this.rangeLoading = false;
      this.restartRangeRefresh();
    },
    // Only 1h keeps refreshing: its buckets are 15s wide so a poll actually moves the chart, while
    // 24h/7d buckets are 5 and 30 minutes wide and would redraw an identical chart for minutes.
    // 'live' needs no timer of its own - the root's poll updates the metricsHistory prop.
    restartRangeRefresh() {
      if (this._rangeTimer) clearInterval(this._rangeTimer);
      this._rangeTimer = null;
      if (this.range === '1h') {
        this._rangeTimer = setInterval(() => this.fetchRangeHistory({ silent: true }), POLL_MS);
      }
    },
    async fetchRangeHistory({ silent = false } = {}) {
      if (this.range === 'live' || !this.hostId) return;
      const { range, hostId } = this;
      // A background refresh must not flash the loading state over a chart already on screen -
      // only an explicit range switch does that.
      if (!silent) this.rangeLoading = true;
      try {
        const rows = await apiGetMetricsHistory(hostId, { range });
        // A slow request for a range (or host) the user has since switched away from must not
        // land over the newer one's data - same guard the root's own fetches use.
        if (this.range !== range || this.hostId !== hostId) return;
        this.rangeRows = rows;
        this.rangeError = null;
      } catch (err) {
        if (this.range === range && this.hostId === hostId) this.rangeError = err.message;
      } finally {
        if (this.range === range && this.hostId === hostId) this.rangeLoading = false;
      }
    },
    onImagesToggle(event) {
      this.imagesExpanded = event.target.open;
      if (this.imagesExpanded && !this.imagesLoaded) this.loadImages();
    },
    async loadImages() {
      if (!this.hostId) return;
      this.imagesLoading = true;
      this.imagesError = null;
      try {
        this.images = await apiGetDiskUsageImages(this.hostId);
        this.imagesLoaded = true;
      } catch (err) {
        this.imagesError = err.message;
      } finally {
        this.imagesLoading = false;
      }
    },
    imageLabel(img) {
      return (img.repository || '<none>') + ':' + (img.tag || '<none>');
    },
  },
  template: `
    <div class="host-card" :class="{ 'with-detail': withDetail, fullscreen: fullscreen }">
      <div class="host-card-header">
        <span class="host-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="6" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="2" y="11" width="16" height="6" rx="1.5" stroke="currentColor" stroke-width="1.6"/><circle cx="5.5" cy="6" r="1" fill="currentColor"/><circle cx="5.5" cy="14" r="1" fill="currentColor"/></svg></span>
        <strong>{{ hostName }}</strong>
        <span class="host-card-meta">
          <span class="meta-item"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2.5 17 6.5V13.5L10 17.5 3 13.5V6.5L10 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 6.5 10 10.5 17 6.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 10.5V17.5" stroke="currentColor" stroke-width="1.6"/></svg> {{ hostInfo.containers }} containers</span>
          <span class="meta-item"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h7l7 7-7 7-7-7V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.7" cy="6.7" r="1.3" fill="currentColor"/></svg> {{ hostInfo.serverVersion }}</span>
        </span>
        <div v-if="fullscreen" class="view-toggle host-range-toggle">
          <button
            v-for="r in ranges"
            :key="r.key"
            :class="{ active: range === r.key }"
            @click="range = r.key"
          >{{ r.label }}</button>
        </div>
        <button
          class="small-btn"
          @click="toggleFullscreen"
          :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen - stack CPU/RAM/Disk full-width for a closer look'"
        >
          {{ fullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen' }}
        </button>
      </div>
      <p v-if="rangeError" class="error host-range-status">{{ rangeError }}</p>
      <p v-else-if="rangeLoading && !activeHistory.length" class="muted small host-range-status">Loading {{ range }} history…</p>
      <p v-else-if="rangeEmpty" class="muted small host-range-status">No host metrics recorded over the last {{ range }}.</p>
      <div class="host-tiles">
        <spark-tile
          variant="cpu"
          :label="hostInfo.ncpu + ' CPU'"
          :samples="cpuSamples"
          :secondary-samples="hostSystemUsage ? hostCpuSamples : null"
          :host-total-label="hostSystemUsage ? (hostSystemUsage.cpuPercent != null ? hostSystemUsage.cpuPercent.toFixed(1) + '%' : '—') : null"
          :format-value="fmtPercent"
          :sample-times="sampleTimes"
          :slot-count="slotCount"
          :hover-index="hoverIndex"
          :detailed="fullscreen"
          @hover="hoverIndex = $event"
          @leave="hoverIndex = null"
        >
          <template #icon
            ><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="8.5" width="3" height="3" fill="currentColor"/><path d="M7 2v2M10 2v2M13 2v2M7 16v2M10 16v2M13 16v2M2 7h2M2 10h2M2 13h2M16 7h2M16 10h2M16 13h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></template
          >
        </spark-tile>
        <spark-tile
          variant="mem"
          :label="fmtGB(hostInfo.memTotalBytes)"
          :samples="memSamples"
          :secondary-samples="hostSystemUsage ? hostMemSamples : null"
          :host-total-label="memHostDisplay ? memHostDisplay.label : null"
          :host-total-heading="memHostDisplay ? memHostDisplay.heading : 'host total'"
          :secondary-label="memHostDisplay ? memHostDisplay.seriesLabel : 'host total'"
          :extra-host-label="memHostDisplay ? memHostDisplay.extraLabel : null"
          :format-value="fmtGB"
          :sample-times="sampleTimes"
          :slot-count="slotCount"
          :hover-index="hoverIndex"
          :detailed="fullscreen"
          @hover="hoverIndex = $event"
          @leave="hoverIndex = null"
        >
          <template #icon
            ><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="16" height="8" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M5 7V4.5M8 7V4.5M11 7V4.5M14 7V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></template
          >
        </spark-tile>
        <div class="host-tile disk-tile" v-if="diskUsage.length">
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
          <details class="inspect-section" @toggle="onImagesToggle">
            <summary>Images{{ diskRow('Images') ? ' (' + diskRow('Images').total + ')' : '' }}</summary>
            <div class="inspect-list">
              <div v-if="imagesLoading" class="muted small">Loading…</div>
              <div v-if="imagesError" class="error">{{ imagesError }}</div>
              <div v-for="img in images" :key="img.id" class="inspect-line">
                <span class="mono">{{ imageLabel(img) }}</span>
                <span class="muted small">&nbsp;{{ img.size }} &bull; {{ img.containers ? 'in use (' + img.containers + ')' : 'unused' }} &bull; {{ img.createdSince }}</span>
              </div>
              <div v-if="imagesLoaded && !images.length" class="muted small">None</div>
            </div>
          </details>
        </div>
      </div>
    </div>
  `,
};
