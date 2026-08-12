import { METRICS_HISTORY_LEN } from '../constants.js';
import { padSlots, sparkPaths } from '../lib/spark.js';

// The cell-sized sparkline in each List-view row - stripped SparkTile drawing with no header/
// axis/legend/crosshair (see CLAUDE.md). Scale is per container against its own peak, not shared
// across rows (which would flatten quiet containers to a line) - the peak goes in the title attr.
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
