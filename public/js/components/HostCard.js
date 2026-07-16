import { formatGB } from '../format.js';
import SparkTile from './SparkTile.js';

// The host header (name + container count + Docker version) plus the CPU/RAM SparkTiles and the
// disk-usage tile. Owns deriving the Docker and host-total sample series from the raw metrics
// history rows, since metricsCollector writes both into the same host_metrics row every poll.
export default {
  name: 'HostCard',
  components: { SparkTile },
  props: {
    hostInfo: { type: Object, required: true },
    hostName: { type: String, required: true },
    metricsHistory: { type: Array, default: () => [] },
    diskUsage: { type: Array, default: () => [] },
    withDetail: { type: Boolean, default: false },
  },
  computed: {
    cpuSamples() {
      return this.metricsHistory.map((s) => s.cpuPercent);
    },
    memSamples() {
      return this.metricsHistory.map((s) => s.memUsedBytes);
    },
    // Host-total figures - real host-wide CPU/mem (every process, not just this app's
    // containers), local-host-only (null fields for a remote SSH host) - see hostUsage.js.
    hostSystemUsage() {
      const last = this.metricsHistory[this.metricsHistory.length - 1];
      return last && last.systemMemTotalBytes != null
        ? { cpuPercent: last.systemCpuPercent, memUsedBytes: last.systemMemUsedBytes, memTotalBytes: last.systemMemTotalBytes }
        : null;
    },
    hostCpuSamples() {
      return this.metricsHistory.map((s) => s.systemCpuPercent);
    },
    hostMemSamples() {
      return this.metricsHistory.map((s) => s.systemMemUsedBytes);
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
  },
  template: `
    <div class="host-card" :class="{ 'with-detail': withDetail }">
      <div class="host-card-header">
        <span class="host-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="6" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="2" y="11" width="16" height="6" rx="1.5" stroke="currentColor" stroke-width="1.6"/><circle cx="5.5" cy="6" r="1" fill="currentColor"/><circle cx="5.5" cy="14" r="1" fill="currentColor"/></svg></span>
        <strong>{{ hostName }}</strong>
        <span class="host-card-meta">
          <span class="meta-item"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2.5 17 6.5V13.5L10 17.5 3 13.5V6.5L10 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 6.5 10 10.5 17 6.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 10.5V17.5" stroke="currentColor" stroke-width="1.6"/></svg> {{ hostInfo.containers }} containers</span>
          <span class="meta-item"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h7l7 7-7 7-7-7V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.7" cy="6.7" r="1.3" fill="currentColor"/></svg> {{ hostInfo.serverVersion }}</span>
        </span>
      </div>
      <div class="host-tiles">
        <spark-tile
          variant="cpu"
          :label="hostInfo.ncpu + ' CPU'"
          :samples="cpuSamples"
          :host-samples="hostSystemUsage ? hostCpuSamples : null"
          :host-total-label="hostSystemUsage ? (hostSystemUsage.cpuPercent != null ? hostSystemUsage.cpuPercent.toFixed(1) + '%' : '—') : null"
          :format-value="fmtPercent"
        >
          <template #icon
            ><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="8.5" width="3" height="3" fill="currentColor"/><path d="M7 2v2M10 2v2M13 2v2M7 16v2M10 16v2M13 16v2M2 7h2M2 10h2M2 13h2M16 7h2M16 10h2M16 13h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></template
          >
        </spark-tile>
        <spark-tile
          variant="mem"
          :label="fmtGB(hostInfo.memTotalBytes)"
          :samples="memSamples"
          :host-samples="hostSystemUsage ? hostMemSamples : null"
          :host-total-label="hostSystemUsage ? fmtGB(hostSystemUsage.memUsedBytes) + ' / ' + fmtGB(hostSystemUsage.memTotalBytes) : null"
          :format-value="fmtGB"
        >
          <template #icon
            ><svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="16" height="8" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M5 7V4.5M8 7V4.5M11 7V4.5M14 7V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></template
          >
        </spark-tile>
        <div class="host-tile" v-if="diskUsage.length">
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
        </div>
      </div>
    </div>
  `,
};
