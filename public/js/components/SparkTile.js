import { HOST_METRICS_HISTORY_LEN } from '../constants.js';
import { padSlots, sparkPaths, hoverPoints, axisTickIndices } from '../lib/spark.js';

const AXIS_TICK_COUNT = 4;
const AXIS_TICK_COUNT_FULLSCREEN = 8;
// Grid divisions - how many bands the 0-30 viewBox height/0-100 width are cut into. Fullscreen
// doubles both: there's a lot more actual screen space to resolve finer gridlines into once the
// tile is taller and full-width instead of sharing a row with its sibling.
const H_GRID_DIVISIONS = 4;
const H_GRID_DIVISIONS_FULLSCREEN = 8;
const V_GRID_DIVISIONS = 10;
const V_GRID_DIVISIONS_FULLSCREEN = 20;

// One CPU-or-RAM host-usage tile: label/value header, the host-total box, the sparkline SVG
// (Docker line + optional lighter host-total line sharing one peak so the two are on a common
// y-axis - see hostPaths/sharedPeak), the hover crosshair + dots, an x-axis time row, and the
// legend. Used twice by HostCard with variant 'cpu' or 'mem' driving the spark-*-cpu/spark-*-mem
// class name pairs already defined in style.css.
//
// Hover is a controlled prop rather than local state: HostCard owns one shared hoverIndex and
// passes it to both tiles, so hovering either the CPU or RAM graph shows the crosshair at the
// same x position on both - the whole point being to let you correlate a CPU spike with what RAM
// was doing at that same moment.
export default {
  name: 'SparkTile',
  props: {
    variant: { type: String, required: true }, // 'cpu' | 'mem' - selects the spark-*-<variant> classes
    label: { type: String, required: true }, // host-tile-label text, e.g. "16 CPU" or "16.4 GB"
    samples: { type: Array, required: true }, // raw Docker samples, unpadded
    hostSamples: { type: Array, default: null }, // raw host-total samples, unpadded; null/omitted hides the host layer entirely
    hostTotalLabel: { type: String, default: null }, // precomputed "host total" box text; null hides the box
    formatValue: { type: Function, required: true }, // raw sample -> display string, used for now/avg/peak and dot titles
    sampleTimes: { type: Array, default: () => [] }, // bucket timestamps (ms), unpadded, aligned 1:1 with `samples`
    hoverIndex: { type: Number, default: null }, // shared hover position, owned by the parent - see HostCard
    fullscreen: { type: Boolean, default: false }, // taller box + finer grid/axis detail - see HostCard
  },
  emits: ['hover', 'leave'],
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
    timeSlots() {
      return padSlots(this.sampleTimes, HOST_METRICS_HISTORY_LEN);
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
    // x-axis tick labels - up to AXIS_TICK_COUNT (more when fullscreen, since there's a lot more
    // width to fill), evenly spaced, skipping the still-empty part of the padded window (a
    // freshly-selected host with only a few real samples so far).
    axisTicks() {
      const n = this.timeSlots.length;
      const count = this.fullscreen ? AXIS_TICK_COUNT_FULLSCREEN : AXIS_TICK_COUNT;
      return axisTickIndices(this.timeSlots, count).map((i) => ({
        x: n > 1 ? (i / (n - 1)) * 100 : 100,
        label: this.formatTime(this.timeSlots[i]),
        // First tick hugs the left edge, last hugs the right edge, the rest center on their
        // point - otherwise the end labels would overflow outside the chart width.
        align: i === 0 ? 'left' : i === n - 1 ? 'right' : 'center',
      }));
    },
    // Gridline positions - more/finer bands when fullscreen (see the constants above).
    hGridLines() {
      const divisions = this.fullscreen ? H_GRID_DIVISIONS_FULLSCREEN : H_GRID_DIVISIONS;
      return Array.from({ length: divisions - 1 }, (_, k) => ((k + 1) / divisions) * 30);
    },
    vGridLines() {
      const divisions = this.fullscreen ? V_GRID_DIVISIONS_FULLSCREEN : V_GRID_DIVISIONS;
      return Array.from({ length: divisions - 1 }, (_, k) => ((k + 1) / divisions) * 100);
    },
    hoverTimeLabel() {
      if (this.hoverIndex == null) return null;
      const t = this.timeSlots[this.hoverIndex];
      return t == null ? null : this.formatTime(t);
    },
  },
  methods: {
    onHover(event) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width) {
        this.$emit('leave');
        return;
      }
      const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      this.$emit('hover', Math.round(frac * (HOST_METRICS_HISTORY_LEN - 1)));
    },
    onLeave() {
      this.$emit('leave');
    },
    formatTime(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
            v-for="y in hGridLines"
            :key="'h' + y"
            x1="0"
            :y1="y"
            x2="100"
            :y2="y"
            class="spark-grid-line"
            vector-effect="non-scaling-stroke"
          />
          <line
            v-for="x in vGridLines"
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
        <span v-if="hoverPts && hoverTimeLabel" class="spark-hover-time" :style="{ left: hoverPts.x + '%' }">{{ hoverTimeLabel }}</span>
      </div>
      <div class="spark-axis">
        <span
          v-for="tick in axisTicks"
          :key="tick.x"
          class="spark-axis-tick"
          :class="'spark-axis-tick-' + tick.align"
          :style="{ left: tick.x + '%' }"
          >{{ tick.label }}</span
        >
      </div>
      <p v-if="hostAvailable" class="muted legend host-usage-legend">
        <span class="legend-item"><span :class="'bar-swatch bar-swatch-' + variant"></span> Docker</span>
        <span class="legend-item"><span :class="'bar-swatch bar-swatch-' + variant + '-host'"></span> host total</span>
      </p>
    </div>
  `,
};
