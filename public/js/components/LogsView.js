import { stateEmoji } from '../format.js';
import LogViewer from './LogViewer.js';

// The Logs tab: a compact, always-visible container list on the left (grouped by compose
// project, search-filterable) and a single embedded LogViewer filling the pane on the right -
// switching which container's logs you're looking at is a click in the list rather than opening
// and closing the root's overlay log panel per container. Mounted fresh (v-if, not v-show) like
// ActivityView/LogViewer - the embedded LogViewer child owns its own stream lifecycle via its own
// mounted()/beforeUnmount(), keyed on the active container id so switching containers tears down
// the old stream and starts a fresh one instead of reusing a stale one.
export default {
  name: 'LogsView',
  components: { LogViewer },
  props: {
    hostId: { type: String, required: true },
    groupedContainers: { type: Array, required: true },
  },
  data() {
    return {
      search: '',
      activeContainerId: null,
    };
  },
  computed: {
    filteredGroups() {
      const q = this.search.trim().toLowerCase();
      if (!q) return this.groupedContainers;
      return this.groupedContainers
        .map(([name, items]) => [name, items.filter((c) => c.name.toLowerCase().includes(q))])
        .filter(([, items]) => items.length);
    },
    allContainers() {
      return this.groupedContainers.flatMap(([, items]) => items);
    },
    activeContainer() {
      return this.allContainers.find((c) => c.id === this.activeContainerId) || null;
    },
  },
  watch: {
    hostId() {
      this.activeContainerId = null;
    },
    // A container that disappears from the list (removed, or filtered out by the topbar's state
    // toggle) shouldn't leave the pane stuck rendering a stream for an id no longer in it.
    allContainers() {
      if (this.activeContainerId && !this.allContainers.some((c) => c.id === this.activeContainerId)) {
        this.activeContainerId = null;
      }
    },
  },
  methods: {
    select(id) {
      this.activeContainerId = id;
    },
    stateIcon(state) {
      return stateEmoji(state);
    },
  },
  template: `
    <div class="logs-tab-wrap">
      <div class="logs-tab-list">
        <input type="text" v-model="search" placeholder="Filter containers…" class="logs-tab-search" />
        <p v-if="!filteredGroups.length" class="muted">No containers found.</p>
        <div v-for="[groupName, items] in filteredGroups" :key="groupName" class="logs-tab-group">
          <div class="logs-tab-group-label">{{ groupName }}</div>
          <div
            v-for="c in items"
            :key="c.id"
            class="logs-tab-row row-clickable"
            :class="{ 'row-selected': c.id === activeContainerId }"
            @click="select(c.id)"
          >
            <span class="logs-tab-row-icon" v-html="stateIcon(c.state)"></span>
            <span class="logs-tab-row-name">{{ c.name }}</span>
          </div>
        </div>
      </div>
      <div class="logs-tab-viewer">
        <log-viewer
          v-if="activeContainer"
          :key="activeContainer.id"
          :host-id="hostId"
          :container-id="activeContainer.id"
          :container-name="activeContainer.name"
          :embedded="true"
        ></log-viewer>
        <div v-else class="logs-tab-empty muted">Select a container on the left to view its logs.</div>
      </div>
    </div>
  `,
};
