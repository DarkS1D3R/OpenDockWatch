import { HOST_METRICS_HISTORY_LEN } from '../constants.js';
import { padSlots, sparkPaths, hoverPoints } from '../lib/spark.js';

// One CPU-or-RAM host-usage tile: label/value header, the host-total box, the sparkline SVG
// (Docker line + optional lighter host-total line sharing one peak so the two are on a common
// y-axis - see hostPaths/sharedPeak), the hover crosshair + dots, and the legend. Used twice by
// HostCard with variant 'cpu' or 'mem' driving the spark-*-cpu/spark-*-mem class name pairs
// already defined in style.css.
export default {
  name: 'SparkTile',
  props: {
    variant: { type: String, required: true }, // 'cpu' | 'mem' - selects the spark-*-<variant> classes
    label: { type: String, required: true }, // host-tile-label text, e.g. "16 CPU" or "16.4 GB"
    samples: { type: Array, required: true }, // raw Docker samples, unpadded
    hostSamples: { type: Array, default: null }, // raw host-total samples, unpadded; null/omitted hides the host layer entirely
    hostTotalLabel: { type: String, default: null }, // precomputed "host total" box text; null hides the box
    formatValue: { type: Function, required: true }, // raw sample -> display string, used for now/avg/peak and dot titles
  },
  data() {
    return {
      hoverIndex: null,
    };
  },
  computed: {
    hostAvailable() {
      return !!this.hostSamples;
    },
    chartSlots() {
      return padSlots(this.samples, HOST_METRICS_HISTORY_LEN);
    },
    hostChartSlots() {
      return padSlots(this.hostSamples || [], HOST_METRICS_HISTORY_LEN);
    },
    peak() {
      return this.samples.length ? Math.max(...this.samples) : 0;
    },
    hostPeak() {
      return this.hostSamples && this.hostSamples.length ? Math.max(...this.hostSamples) : 0;
    },
    sharedPeak() {
      return Math.max(this.peak, this.hostPeak);
    },
    now() {
      return this.samples.length ? this.samples[this.samples.length - 1] : 0;
    },
    avg() {
      return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
    },
    dockerPaths() {
      return sparkPaths(this.chartSlots, this.sharedPeak);
    },
    hostPaths() {
      return sparkPaths(this.hostChartSlots, this.sharedPeak);
    },
    hoverPts() {
      return hoverPoints(this.hoverIndex, this.chartSlots, this.hostChartSlots, this.sharedPeak);
    },
  },
  methods: {
    onHover(event) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width) {
        this.hoverIndex = null;
        return;
      }
      const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      this.hoverIndex = Math.round(frac * (HOST_METRICS_HISTORY_LEN - 1));
    },
    onLeave() {
      this.hoverIndex = null;
    },
  },
  template: `
    <div class="host-tile">
      <div class="host-tile-top">
        <div class="host-tile-left">
          <div class="host-tile-label"><span class="tile-icon" :class="'tile-icon-' + variant"><slot name="icon"></slot></span> {{ label }}</div>
          <div class="host-tile-value-row">
            <span class="host-tile-value">{{ formatValue(now) }}</span>
            <span class="host-tile-sub">avg {{ formatValue(avg) }} &bull; pk {{ formatValue(peak) }}</span>
          </div>
        </div>
        <div v-if="hostTotalLabel" class="host-tile-system">host total<br />{{ hostTotalLabel }}</div>
      </div>
      <div class="sparkline" @mousemove="onHover" @mouseleave="onLeave">
        <svg class="spark-svg" viewBox="0 0 100 30" preserveAspectRatio="none">
          <line
            v-for="y in [7.5, 15, 22.5]"
            :key="'h' + y"
            x1="0"
            :y1="y"
            x2="100"
            :y2="y"
            class="spark-grid-line"
            vector-effect="non-scaling-stroke"
          />
          <line
            v-for="x in [10, 20, 30, 40, 50, 60, 70, 80, 90]"
            :key="'v' + x"
            :x1="x"
            y1="0"
            :x2="x"
            y2="30"
            class="spark-grid-line"
            vector-effect="non-scaling-stroke"
          />
          <path v-if="hostAvailable" :class="'spark-area spark-area-' + variant + '-host'" :d="hostPaths.area"></path>
          <path v-if="hostAvailable" :class="'spark-line spark-line-' + variant + '-host'" :d="hostPaths.line" vector-effect="non-scaling-stroke"></path>
          <path :class="'spark-area spark-area-' + variant" :d="dockerPaths.area"></path>
          <path :class="'spark-line spark-line-' + variant" :d="dockerPaths.line" vector-effect="non-scaling-stroke"></path>
          <line
            v-if="hoverPts"
            class="spark-hover-line"
            :x1="hoverPts.x"
            y1="0"
            :x2="hoverPts.x"
            y2="30"
            vector-effect="non-scaling-stroke"
          ></line>
        </svg>
        <span
          v-if="dockerPaths.dot && !hoverPts"
          :class="'spark-dot spark-dot-' + variant"
          :style="{ left: dockerPaths.dot.x + '%', top: (dockerPaths.dot.y / 30 * 100) + '%' }"
          :title="formatValue(now)"
        ></span>
        <span
          v-if="hoverPts && hoverPts.docker"
          :class="'spark-dot spark-dot-' + variant"
          :style="{ left: hoverPts.docker.x + '%', top: (hoverPts.docker.y / 30 * 100) + '%' }"
          :title="'Docker: ' + formatValue(hoverPts.docker.v)"
        ></span>
        <span
          v-if="hoverPts && hoverPts.host"
          :class="'spark-dot spark-dot-' + variant + '-host'"
          :style="{ left: hoverPts.host.x + '%', top: (hoverPts.host.y / 30 * 100) + '%' }"
          :title="'host total: ' + formatValue(hoverPts.host.v)"
        ></span>
      </div>
      <p v-if="hostAvailable" class="muted legend host-usage-legend">
        <span class="legend-item"><span :class="'bar-swatch bar-swatch-' + variant"></span> Docker</span>
        <span class="legend-item"><span :class="'bar-swatch bar-swatch-' + variant + '-host'"></span> host total</span>
      </p>
    </div>
  `,
};
