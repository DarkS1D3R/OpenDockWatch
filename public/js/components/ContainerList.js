import { healthColor, healthLabel, formatBytes } from '../format.js';
import MiniSpark from './MiniSpark.js';

// The List view: containers grouped by compose project, with mini sparklines and
// start/stop/restart/Logs actions. Selection/actions/log-viewer/metrics-modal are owned by the
// root; this component only emits what happened. collapsedGroups is the one bit of local UI state.
export default {
  name: 'ContainerList',
  components: { MiniSpark },
  props: {
    groupedContainers: { type: Array, required: true },
    stats: { type: Object, default: () => ({}) },
    metricsView: { type: Object, default: () => ({}) },
    actionInFlight: { type: Object, default: () => ({}) },
    selectedContainerId: { type: String, default: null },
    isAdmin: { type: Boolean, default: false },
  },
  emits: ['select', 'action', 'open-logs', 'open-metrics'],
  data() {
    return {
      collapsedGroups: {},
    };
  },
  methods: {
    toggleGroup(name) {
      this.collapsedGroups = { ...this.collapsedGroups, [name]: !this.collapsedGroups[name] };
    },
    statFor(id) {
      return this.stats[id] || {};
    },
    metricsFor(id) {
      return this.metricsView[id] || { cpu: [], mem: [], cpuPeak: 0, memPeak: 0 };
    },
    // The peak the row's sparkline is scaled against - a cell has no room to label its own y-axis,
    // so this goes in the title attribute to make the scale discoverable on hover.
    sparkTitle(id, metric) {
      const m = this.metricsFor(id);
      const peak = metric === 'cpu' ? m.cpuPeak : m.memPeak;
      if (!peak) return 'No samples yet - click for full history';
      const formatted = metric === 'cpu' ? peak.toFixed(1) + '%' : formatBytes(peak);
      return `Peak ${formatted} over the last couple of minutes - click for full history`;
    },
    stateClass(container) {
      return container.state === 'running' ? 'state-running' : 'state-stopped';
    },
    healthDotColor(health) {
      return healthColor(health);
    },
    healthTitle(health) {
      return healthLabel(health);
    },
  },
  template: `
    <div>
      <div v-for="[groupName, items] in groupedContainers" :key="groupName" class="group-block">
        <div class="group-header" @click="toggleGroup(groupName)">
          <span class="chevron" :class="{open: !collapsedGroups[groupName]}">&#9656;</span>
          {{ groupName }} <span class="muted">({{ items.length }})</span>
        </div>
        <table v-show="!collapsedGroups[groupName]" class="containers">
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>Status</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Ports</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in items"
              :key="c.id"
              class="row-clickable"
              :class="{'row-selected': c.id === selectedContainerId}"
              @click="$emit('select', c.id)"
            >
              <td>{{ c.name }}</td>
              <td class="muted">{{ c.image }}</td>
              <td>
                <div class="status-cell">
                  <span class="status-text" :class="stateClass(c)" :title="c.status">{{ c.status }}</span>
                  <span
                    v-if="c.health"
                    class="health-dot"
                    :style="{ background: healthDotColor(c.health) }"
                    :title="healthTitle(c.health)"
                  ></span>
                  <span v-if="c.restartCount1h" class="restart-badge" title="Restarts in the last hour">⟳ {{ c.restartCount1h }}</span>
                </div>
              </td>
              <td class="muted">
                <div class="cell-metric-row">
                  <span>{{ statFor(c.id).cpuPerc || '—' }}</span>
                  <button
                    class="mini-spark-btn"
                    :title="sparkTitle(c.id, 'cpu')"
                    @click.stop="$emit('open-metrics', c.id)"
                  >
                    <mini-spark :samples="metricsFor(c.id).cpu" variant="cpu"></mini-spark>
                  </button>
                </div>
              </td>
              <td class="muted">
                <div class="cell-metric-row">
                  <span>{{ statFor(c.id).memUsage || '—' }}</span>
                  <button
                    class="mini-spark-btn"
                    :title="sparkTitle(c.id, 'mem')"
                    @click.stop="$emit('open-metrics', c.id)"
                  >
                    <mini-spark :samples="metricsFor(c.id).mem" variant="mem"></mini-spark>
                  </button>
                </div>
              </td>
              <td class="muted" :title="c.ports">{{ c.ports }}</td>
              <td class="actions" @click.stop>
                <button @click="$emit('open-logs', c.id)" title="Open the log viewer for this container">Logs</button>
                <template v-if="isAdmin">
                  <button :disabled="!!actionInFlight[c.id]" @click="$emit('action', c, 'start')">Start</button>
                  <button :disabled="!!actionInFlight[c.id]" @click="$emit('action', c, 'stop')">Stop</button>
                  <button :disabled="!!actionInFlight[c.id]" @click="$emit('action', c, 'restart')">Restart</button>
                </template>
                <span v-else class="muted small">read-only</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
};
