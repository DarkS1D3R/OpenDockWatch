import { healthColor, healthLabel, formatBytes, iconFor, badgeInnerHtml, badgeTitle, badgeIsTile } from '../format.js';
import { SORT_KEYS, DEFAULT_SORT_DIR, sortContainers, loadSort, saveSort } from '../lib/containerSort.js';
import { rowActions, groupActions, actionLabel, shortStatus, memoryCell, portsCell } from '../lib/containerRow.js';
import MiniSpark from './MiniSpark.js';

const SORT_LABELS = { name: 'Name', cpu: 'CPU', mem: 'Memory', restarts: 'Restarts (1h)' };

// The List view: containers grouped by compose project, with mini sparklines, Logs, and the
// start/stop/restart actions that apply to each container's state (lib/containerRow.js). Selection/actions/log-viewer/metrics-modal are owned by the
// root; this component only emits what happened. collapsedGroups is the one bit of local UI state.
export default {
  name: 'ContainerList',
  components: { MiniSpark },
  props: {
    groupedContainers: { type: Array, required: true },
    stats: { type: Object, default: () => ({}) },
    metricsView: { type: Object, default: () => ({}) },
    actionInFlight: { type: Object, default: () => ({}) },
    groupActionInFlight: { type: Object, default: () => ({}) },
    selectedContainerId: { type: String, default: null },
    isAdmin: { type: Boolean, default: false },
    // Docker's view of host memory, to tell a real memory limit from "no limit" in docker stats.
    hostMemTotalBytes: { type: Number, default: null },
  },
  emits: ['select', 'action', 'group-action', 'open-logs', 'open-metrics'],
  data() {
    return {
      collapsedGroups: {},
      search: '',
      // { key, dir } or null for docker's own order. Applied within each group - the groups
      // themselves stay alphabetical - and remembered per browser, see lib/containerSort.js.
      sort: loadSort(),
    };
  },
  computed: {
    // Same shape as LogsView's own container filter - groups with no matching container drop out
    // entirely rather than rendering an empty table.
    filteredGroups() {
      const q = this.search.trim().toLowerCase();
      const groups = q
        ? this.groupedContainers
            .map(([name, items]) => [name, items.filter((c) => c.name.toLowerCase().includes(q))])
            .filter(([, items]) => items.length)
        : this.groupedContainers;
      if (!this.sort) return groups;
      return groups.map(([name, items]) => [name, sortContainers(items, this.sort, this.stats)]);
    },
    sortOptions() {
      return SORT_KEYS.map((key) => ({ key, label: SORT_LABELS[key] }));
    },
  },
  methods: {
    setSort(sort) {
      this.sort = sort;
      saveSort(sort);
    },
    // The select picks a column and starts it in that column's natural direction.
    onSortSelect(key) {
      this.setSort(key ? { key, dir: DEFAULT_SORT_DIR[key] } : null);
    },
    // A header click on the active column flips its direction; on another column it switches to it.
    sortBy(key) {
      if (this.sort && this.sort.key === key) this.setSort({ key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' });
      else this.setSort({ key, dir: DEFAULT_SORT_DIR[key] });
    },
    flipSortDir() {
      if (this.sort) this.setSort({ key: this.sort.key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' });
    },
    sortArrow(key) {
      if (!this.sort || this.sort.key !== key) return '';
      return this.sort.dir === 'asc' ? '▲' : '▼';
    },
    ariaSort(key) {
      if (!this.sort || this.sort.key !== key) return 'none';
      return this.sort.dir === 'asc' ? 'ascending' : 'descending';
    },
    // "Ungrouped" is the synthetic bucket for standalone containers (see app.js's
    // groupedContainers) - there is no compose project behind it to batch-act on.
    isRealGroup(name) {
      return name !== 'Ungrouped';
    },
    toggleGroup(name) {
      this.collapsedGroups = { ...this.collapsedGroups, [name]: !this.collapsedGroups[name] };
    },
    rowActions(c) {
      return rowActions(c.state).map((action) => ({ action, label: actionLabel(action) }));
    },
    groupActions(items) {
      return groupActions(items).map((action) => ({ action, label: `${actionLabel(action)} all` }));
    },
    shortStatus,
    portsCell,
    memoryCell(id) {
      return memoryCell(this.statFor(id).memUsage, this.hostMemTotalBytes);
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
      if (container.state === 'running') return 'state-running';
      if (container.state === 'created') return 'state-created';
      return 'state-stopped';
    },
    healthDotColor(health) {
      return healthColor(health);
    },
    healthTitle(health) {
      return healthLabel(health);
    },
    // Called three times per row per render, which is only affordable because iconFor is memoised.
    badgeFor(c) {
      return iconFor(c.image, c.composeService, c.iconOverride, c.iconHint);
    },
    badgeHtml(c) {
      return badgeInnerHtml(this.badgeFor(c));
    },
    badgeLabel(c) {
      return badgeTitle(this.badgeFor(c)) || null;
    },
    badgeTile(c) {
      return badgeIsTile(this.badgeFor(c));
    },
  },
  template: `
    <div>
      <div class="container-list-toolbar">
        <div class="search-clear-wrap container-list-search-wrap">
          <input type="text" v-model="search" placeholder="Filter containers…" aria-label="Filter containers by name" class="container-list-search" />
          <button aria-label="Clear filter" v-if="search" class="filter-clear-btn" @click="search = ''" title="Clear filter">✕</button>
        </div>
        <div class="container-list-sort">
          <label class="muted small" for="container-sort">Sort by</label>
          <select id="container-sort" :value="sort ? sort.key : ''" @change="onSortSelect($event.target.value)">
            <option value="">Default</option>
            <option v-for="o in sortOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
          <button
            v-if="sort"
            class="small-btn"
            @click="flipSortDir"
            :title="sort.dir === 'asc' ? 'Ascending - click for descending' : 'Descending - click for ascending'"
            :aria-label="sort.dir === 'asc' ? 'Sorted ascending - switch to descending' : 'Sorted descending - switch to ascending'"
          >
            {{ sort.dir === 'asc' ? '▲' : '▼' }}
          </button>
        </div>
      </div>
      <p v-if="search.trim() && !filteredGroups.length" class="muted">No containers match "{{ search.trim() }}".</p>
      <div v-for="[groupName, items] in filteredGroups" :key="groupName" class="group-block">
        <div class="group-header" @click="toggleGroup(groupName)">
          <button type="button" class="group-toggle" :aria-expanded="String(!collapsedGroups[groupName])" @click.stop="toggleGroup(groupName)">
            <span class="chevron" :class="{open: !collapsedGroups[groupName]}" aria-hidden="true">&#9656;</span>
            {{ groupName }} <span class="muted">({{ items.length }})</span>
          </button>
          <div v-if="isAdmin && isRealGroup(groupName)" class="group-actions" @click.stop title="Batch action for every container in this compose project">
            <button v-for="g in groupActions(items)" :key="g.action" :disabled="!!groupActionInFlight[groupName]" @click="$emit('group-action', groupName, g.action)">{{ g.label }}</button>
          </div>
        </div>
        <table v-show="!collapsedGroups[groupName]" class="containers">
          <thead>
            <tr>
              <th class="sortable" :aria-sort="ariaSort('name')"><button type="button" class="th-sort-btn" @click="sortBy('name')" title="Sort by name">Name <span class="sort-arrow" aria-hidden="true">{{ sortArrow('name') }}</span></button></th>
              <th>Image</th>
              <th>Status</th>
              <th class="sortable" :aria-sort="ariaSort('cpu')"><button type="button" class="th-sort-btn" @click="sortBy('cpu')" title="Sort by CPU">CPU <span class="sort-arrow" aria-hidden="true">{{ sortArrow('cpu') }}</span></button></th>
              <th class="sortable" :aria-sort="ariaSort('mem')"><button type="button" class="th-sort-btn" @click="sortBy('mem')" title="Sort by memory used">Memory <span class="sort-arrow" aria-hidden="true">{{ sortArrow('mem') }}</span></button></th>
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
              tabindex="0"
              :aria-label="c.name + ', ' + c.status + ' - press Enter for details'"
              @click="$emit('select', c.id)"
              @keydown.enter.self="$emit('select', c.id)"
              @keydown.space.self.prevent="$emit('select', c.id)"
            >
              <td><span class="svc-badge" :class="{ 'svc-tile': badgeTile(c) }" :style="{ background: badgeFor(c).bg }" :title="badgeLabel(c)" aria-hidden="true" v-html="badgeHtml(c)"></span><a v-if="c.url" :href="c.url" target="_blank" rel="noopener noreferrer" class="container-link" title="Open the service's own UI">{{ c.name }} ↗</a><template v-else>{{ c.name }}</template></td>
              <td class="muted"><span v-if="c.imageUpdate && c.imageUpdate.status === 'outdated'" class="image-update-badge" role="img" aria-label="Newer image available" title="Newer image available">⬆</span>{{ c.image }}</td>
              <td>
                <div class="status-cell">
                  <span class="status-text" :class="stateClass(c)" :title="c.status">{{ shortStatus(c.status) }}</span>
                  <span
                    v-if="c.health"
                    class="health-dot"
                    :style="{ background: healthDotColor(c.health) }"
                    :title="healthTitle(c.health)"
                    role="img"
                    :aria-label="healthTitle(c.health)"
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
                    :aria-label="'CPU history for ' + c.name"
                    @click.stop="$emit('open-metrics', c.id)"
                  >
                    <mini-spark :samples="metricsFor(c.id).cpu" variant="cpu"></mini-spark>
                  </button>
                </div>
              </td>
              <td class="muted">
                <div class="cell-metric-row">
                  <span :title="statFor(c.id).memUsage">{{ memoryCell(c.id) || '—' }}</span>
                  <button
                    class="mini-spark-btn"
                    :title="sparkTitle(c.id, 'mem')"
                    :aria-label="'Memory history for ' + c.name"
                    @click.stop="$emit('open-metrics', c.id)"
                  >
                    <mini-spark :samples="metricsFor(c.id).mem" variant="mem"></mini-spark>
                  </button>
                </div>
              </td>
              <td class="muted" :title="c.ports">{{ portsCell(c.ports) }}</td>
              <td class="actions" @click.stop>
                <button @click="$emit('open-logs', c.id)" title="Open the log viewer for this container">Logs</button>
                <template v-if="isAdmin">
                  <button v-for="a in rowActions(c)" :key="a.action" :disabled="!!actionInFlight[c.id]" @click="$emit('action', c, a.action)">{{ a.label }}</button>
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
