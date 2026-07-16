import { healthColor, healthLabel } from '../format.js';

// The List view: containers grouped by compose project, each with a collapsible table, mini
// CPU/RAM spark bars, and start/stop/restart/Logs actions. Selection, actions, and opening the
// log viewer are all owned by the root (they interact with state well beyond this view - the
// Flow view's cy selection, the log viewer panel, the settings panel) so this component only
// emits what happened; collapsedGroups is the one bit of UI state that's genuinely local.
export default {
  name: 'ContainerList',
  props: {
    groupedContainers: { type: Array, required: true },
    stats: { type: Object, default: () => ({}) },
    metricsView: { type: Object, default: () => ({}) },
    actionInFlight: { type: Object, default: () => ({}) },
    selectedContainerId: { type: String, default: null },
    isAdmin: { type: Boolean, default: false },
  },
  emits: ['select', 'action', 'open-logs'],
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
                <span :class="stateClass(c)">{{ c.status }}</span>
                <span
                  v-if="c.health"
                  class="health-dot"
                  :style="{ background: healthDotColor(c.health) }"
                  :title="healthTitle(c.health)"
                ></span>
                <span v-if="c.restartCount1h" class="restart-badge" title="Restarts in the last hour">⟳ {{ c.restartCount1h }}</span>
              </td>
              <td class="muted">
                <div class="cell-metric-row">
                  <span>{{ statFor(c.id).cpuPerc || '—' }}</span>
                  <div class="mini-spark">
                    <div
                      v-for="(v, i) in metricsFor(c.id).cpu"
                      :key="i"
                      class="mini-bar mini-cpu"
                      :class="{ current: i === metricsFor(c.id).cpu.length - 1 }"
                      :style="{ height: (metricsFor(c.id).cpuPeak ? (v / metricsFor(c.id).cpuPeak * 100) : 0) + '%' }"
                    ></div>
                  </div>
                </div>
              </td>
              <td class="muted">
                <div class="cell-metric-row">
                  <span>{{ statFor(c.id).memUsage || '—' }}</span>
                  <div class="mini-spark">
                    <div
                      v-for="(v, i) in metricsFor(c.id).mem"
                      :key="i"
                      class="mini-bar mini-mem"
                      :class="{ current: i === metricsFor(c.id).mem.length - 1 }"
                      :style="{ height: (metricsFor(c.id).memPeak ? (v / metricsFor(c.id).memPeak * 100) : 0) + '%' }"
                    ></div>
                  </div>
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
