import { METRICS_HISTORY_LEN } from '../constants.js';
import { padSlots, sparkPaths } from '../lib/spark.js';

// The cell-sized sparkline in each List-view row - the same line/area drawing as SparkTile's
// chart, stripped of everything a table cell has no room for: no header, no axis, no legend, no
// hover crosshair. Deliberately not a variant of SparkTile: sharing that component would mean
// v-if-ing away five of its six parts.
//
// The coordinate math is lib/spark.js's (already unit-tested), and the viewBox stays 100x30
// because sparkPaths hardcodes those bounds - the SVG is then scaled to whatever the cell gives
// it by CSS, exactly as the host tiles do it.
//
// Scale is per container against its own peak, matching the bar chart this replaces. A scale
// shared across rows would be more comparable in principle, but in a 20px cell it flattens every
// container that isn't the busiest one on the host into a straight line - the peak goes in the
// title attribute instead, so the scale is at least discoverable.
export default {
  name: 'MiniSpark',
  props: {
    samples: { type: Array, required: true },
    variant: { type: String, required: true }, // 'cpu' | 'mem' - selects the spark-*-<variant> classes
    slotCount: { type: Number, default: METRICS_HISTORY_LEN },
  },
  computed: {
    slots() {
      return padSlots(this.samples, this.slotCount);
    },
    peak() {
      const real = this.samples.filter((v) => v != null);
      return real.length ? Math.max(...real) : 0;
    },
    paths() {
      return sparkPaths(this.slots, this.peak);
    },
    hasData() {
      return this.paths.line !== '';
    },
  },
  template: `
    <span class="mini-spark">
      <svg v-if="hasData" class="mini-spark-svg" viewBox="0 0 100 30" preserveAspectRatio="none">
        <path :class="'spark-area spark-area-' + variant" :d="paths.area"></path>
        <path :class="'spark-line spark-line-' + variant" :d="paths.line" vector-effect="non-scaling-stroke"></path>
      </svg>
      <span v-else class="mini-spark-empty"></span>
    </span>
  `,
};
