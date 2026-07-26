import { HOST_METRICS_HISTORY_LEN } from '../constants.js';
import { padSlots, sparkPaths, hoverPoints, axisTickIndices } from '../lib/spark.js';

const AXIS_TICK_COUNT = 4;
const AXIS_TICK_COUNT_DETAILED = 8;
// Grid divisions - how many bands the 0-30 viewBox height/0-100 width are cut into. The detailed
// form doubles both: there's a lot more actual screen space to resolve finer gridlines into once
// the chart is tall and full-width (host card fullscreen, or the container metrics modal) instead
// of sharing a row with a sibling tile.
const H_GRID_DIVISIONS = 4;
const H_GRID_DIVISIONS_DETAILED = 8;
const V_GRID_DIVISIONS = 10;
const V_GRID_DIVISIONS_DETAILED = 20;

// One metric tile: label/value header, an optional corner box, the sparkline SVG (a primary line
// plus an optional lighter secondary line sharing one peak so the two sit on a common y-axis -
// see secondaryPaths/sharedPeak), the hover crosshair + dots, an x-axis time row, and the legend.
// `variant` drives the spark-*-<variant> class pairs defined in style.css.
//
// Used by HostCard for host CPU/RAM (where the secondary series is the host total behind the
// Docker one) and by ContainerMetricsModal for one container's CPU/RAM/Net/Block (where it's the
// tx half of an rx/tx pair). The second series is deliberately named for its *role* rather than
// for the host - it was `hostSamples` when this only ever drew host usage, which would read as a
// plain lie on a Net I/O chart. The corner-box props below stay host-named because they genuinely
// are host-total-only; the modal never passes them.
//
// Hover is a controlled prop rather than local state: the parent owns one shared hoverIndex and
// passes it to every tile, so hovering any graph shows the crosshair at the same x position on
// all of them - the whole point being to let you correlate a CPU spike with what RAM (or the
// network) was doing at that same moment.
export default {
  name: 'SparkTile',
  props: {
    variant: { type: String, required: true }, // 'cpu' | 'mem' | 'net' | 'block' - selects the spark-*-<variant> classes
    label: { type: String, required: true }, // host-tile-label text, e.g. "16 CPU" or "16.4 GB"
    samples: { type: Array, required: true }, // raw primary samples, unpadded
    secondarySamples: { type: Array, default: null }, // raw second-series samples, unpadded; null/omitted hides that layer entirely
    primaryLabel: { type: String, default: 'Docker' }, // hover-dot title + legend text for the primary series
    secondaryLabel: { type: String, default: 'host total' }, // hover-dot title + legend text for the second series
    hostTotalLabel: { type: String, default: null }, // precomputed "host total" box text; null hides the box
    hostTotalHeading: { type: String, default: 'host total' }, // corner-box heading - see hostMemory.js for the LXC-divergence case
    extraHostLabel: { type: String, default: null }, // optional small line under the corner box (e.g. a demoted physical-host total)
    formatValue: { type: Function, required: true }, // raw sample -> display string, used for now/avg/peak and dot titles
    sampleTimes: { type: Array, default: () => [] }, // bucket timestamps (ms), unpadded, aligned 1:1 with `samples`
    hoverIndex: { type: Number, default: null }, // shared hover position, owned by the parent - see HostCard
    // Total chart width in slots - samples are right-aligned into this many, so a series shorter
    // than the window draws in the right-hand part of the chart instead of stretching across it.
    // The host card's live window and the modal's 1h/24h/7d ranges have different bucket counts.
    slotCount: { type: Number, default: HOST_METRICS_HISTORY_LEN },
    detailed: { type: Boolean, default: false }, // finer grid + more axis ticks, for a chart with real height to spend
  },
  emits: ['hover', 'leave'],
  computed: {
    secondaryAvailable() {
      return !!this.secondarySamples;
    },
    chartSlots() {
      return padSlots(this.samples, this.slotCount);
    },
    secondaryChartSlots() {
      return padSlots(this.secondarySamples || [], this.slotCount);
    },
    timeSlots() {
      return padSlots(this.sampleTimes, this.slotCount);
    },
    // Nulls are ordinary here - a padded slot before the series starts, or an I/O bucket whose
    // rate couldn't be derived (see metricsHistory.js) - and Math.max would turn one into NaN and
    // flatten the whole chart, so they're filtered before any of these reduce over the samples.
    realSamples() {
      return this.samples.filter((v) => v != null);
    },
    realSecondarySamples() {
      return (this.secondarySamples || []).filter((v) => v != null);
    },
    peak() {
      return this.realSamples.length ? Math.max(...this.realSamples) : 0;
    },
    secondaryPeak() {
      return this.realSecondarySamples.length ? Math.max(...this.realSecondarySamples) : 0;
    },
    sharedPeak() {
      return Math.max(this.peak, this.secondaryPeak);
    },
    now() {
      return this.realSamples.length ? this.realSamples[this.realSamples.length - 1] : 0;
    },
    avg() {
      return this.realSamples.length ? this.realSamples.reduce((a, b) => a + b, 0) / this.realSamples.length : 0;
    },
    primaryPaths() {
      return sparkPaths(this.chartSlots, this.sharedPeak);
    },
    secondaryPaths() {
      return sparkPaths(this.secondaryChartSlots, this.sharedPeak);
    },
    hoverPts() {
      return hoverPoints(this.hoverIndex, this.chartSlots, this.secondaryChartSlots, this.sharedPeak);
    },
    // x-axis tick labels - up to AXIS_TICK_COUNT (more when detailed, since there's a lot more
    // width to fill), evenly spaced, skipping the still-empty part of the padded window (a
    // freshly-selected host with only a few real samples so far).
    axisTicks() {
      const n = this.timeSlots.length;
      const count = this.detailed ? AXIS_TICK_COUNT_DETAILED : AXIS_TICK_COUNT;
      return axisTickIndices(this.timeSlots, count).map((i) => ({
        x: n > 1 ? (i / (n - 1)) * 100 : 100,
        label: this.formatTime(this.timeSlots[i]),
        // First tick hugs the left edge, last hugs the right edge, the rest center on their
        // point - otherwise the end labels would overflow outside the chart width.
        align: i === 0 ? 'left' : i === n - 1 ? 'right' : 'center',
      }));
    },
    // Gridline positions - more/finer bands when detailed (see the constants above).
    hGridLines() {
      const divisions = this.detailed ? H_GRID_DIVISIONS_DETAILED : H_GRID_DIVISIONS;
      return Array.from({ length: divisions - 1 }, (_, k) => ((k + 1) / divisions) * 30);
    },
    vGridLines() {
      const divisions = this.detailed ? V_GRID_DIVISIONS_DETAILED : V_GRID_DIVISIONS;
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
      this.$emit('hover', Math.round(frac * (this.slotCount - 1)));
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
        <div v-if="hostTotalLabel" class="host-tile-system">
          {{ hostTotalHeading }}<br />{{ hostTotalLabel }}
          <div v-if="extraHostLabel" class="muted small">{{ extraHostLabel }}</div>
        </div>
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
          <path v-if="secondaryAvailable" :class="'spark-area spark-area-' + variant + '-alt'" :d="secondaryPaths.area"></path>
          <path v-if="secondaryAvailable" :class="'spark-line spark-line-' + variant + '-alt'" :d="secondaryPaths.line" vector-effect="non-scaling-stroke"></path>
          <path :class="'spark-area spark-area-' + variant" :d="primaryPaths.area"></path>
          <path :class="'spark-line spark-line-' + variant" :d="primaryPaths.line" vector-effect="non-scaling-stroke"></path>
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
          v-if="primaryPaths.dot && !hoverPts"
          :class="'spark-dot spark-dot-' + variant"
          :style="{ left: primaryPaths.dot.x + '%', top: (primaryPaths.dot.y / 30 * 100) + '%' }"
          :title="formatValue(now)"
        ></span>
        <span
          v-if="hoverPts && hoverPts.primary"
          :class="'spark-dot spark-dot-' + variant"
          :style="{ left: hoverPts.primary.x + '%', top: (hoverPts.primary.y / 30 * 100) + '%' }"
          :title="primaryLabel + ': ' + formatValue(hoverPts.primary.v)"
        ></span>
        <span
          v-if="hoverPts && hoverPts.secondary"
          :class="'spark-dot spark-dot-' + variant + '-alt'"
          :style="{ left: hoverPts.secondary.x + '%', top: (hoverPts.secondary.y / 30 * 100) + '%' }"
          :title="secondaryLabel + ': ' + formatValue(hoverPts.secondary.v)"
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
      <p v-if="secondaryAvailable" class="muted legend host-usage-legend">
        <span class="legend-item"><span :class="'bar-swatch bar-swatch-' + variant"></span> {{ primaryLabel }}</span>
        <span class="legend-item"><span :class="'bar-swatch bar-swatch-' + variant + '-alt'"></span> {{ secondaryLabel }}</span>
      </p>
    </div>
  `,
};
