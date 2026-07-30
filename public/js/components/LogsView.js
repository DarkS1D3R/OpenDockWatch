import { stateEmoji } from '../format.js';
import { MAX_OPEN_LOG_PANES } from '../constants.js';
import LogViewer from './LogViewer.js';

// The Logs tab: a compact, always-visible container list on the left (grouped by compose
// project, search-filterable) and up to MAX_OPEN_LOG_PANES embedded LogViewers on the right -
// clicking a row toggles it open/closed rather than replacing a single selection, so several
// containers' logs can sit side by side. Mounted fresh (v-if, not v-show) like
// ActivityView/LogViewer - each embedded LogViewer child owns its own stream lifecycle via its
// own mounted()/beforeUnmount(), keyed on container id so opening/closing a pane tears down or
// starts a stream rather than reusing a stale one.
//
// Scroll sync: every open pane emits `scroll-sync` (LogViewer.js) with its own container id and
// the epoch-ms timestamp of whichever line the *user* just scrolled to the top of its viewport.
// onScrollSync calls scrollToTimestamp on every *other* open pane - never the sender, which is
// already there and would otherwise fight the scroll gesture that got it there by re-snapping its
// own scrollTop to the nearest line boundary on every frame - so they all line up on the same
// point in time regardless of how many lines each container happens to log. Panes are looked
// up by container id via `_panes` (a plain, non-reactive map populated by a function :ref, since
// Vue only turns `ref` into an array automatically for elements directly inside a v-for that are
// *always* rendered that way - this template renders 1 pane the same way it renders 4, so a plain
// id-keyed map is both correct and simpler than reasoning about array order). lastSyncTsMs is kept
// so a pane opened *after* the group has already scrolled somewhere joins at that same point
// instead of jumping in at the live tail while its siblings are looking at history.
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
      openIds: [],
      lastSyncTsMs: null,
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
    // In open order (the order containers were clicked), not list order - so a newly opened pane
    // lands last in the grid instead of jumping around as other panes open/close around it.
    openContainers() {
      return this.openIds.map((id) => this.allContainers.find((c) => c.id === id)).filter(Boolean);
    },
    atCap() {
      return this.openIds.length >= MAX_OPEN_LOG_PANES;
    },
    maxPanes() {
      return MAX_OPEN_LOG_PANES;
    },
  },
  watch: {
    hostId() {
      this.openIds = [];
      this.lastSyncTsMs = null;
    },
    // A container that disappears from the list (removed, or filtered out by the topbar's state
    // toggle) shouldn't leave a pane stuck rendering a stream for an id no longer in it.
    allContainers() {
      const stillThere = new Set(this.allContainers.map((c) => c.id));
      if (this.openIds.some((id) => !stillThere.has(id))) {
        this.openIds = this.openIds.filter((id) => stillThere.has(id));
      }
    },
  },
  created() {
    this._panes = {};
  },
  methods: {
    registerPane(id, el) {
      if (el) this._panes[id] = el;
      else delete this._panes[id];
    },
    toggleOpen(id) {
      if (this.openIds.includes(id)) {
        this.openIds = this.openIds.filter((openId) => openId !== id);
        return;
      }
      if (this.atCap) return;
      this.openIds = [...this.openIds, id];
      // Slot the new pane into the group's current timeframe instead of at its own live tail -
      // wait a tick for it to mount and load its first burst of lines before moving it.
      if (this.lastSyncTsMs != null) {
        const tsMs = this.lastSyncTsMs;
        this.$nextTick(() => {
          const pane = this._panes[id];
          if (pane) pane.scrollToTimestamp(tsMs);
        });
      }
    },
    onScrollSync({ containerId, tsMs }) {
      this.lastSyncTsMs = tsMs;
      // Not the sender - it's already there by definition, and re-snapping its own scrollTop to
      // the nearest line boundary every frame would fight the scroll gesture that got it there,
      // most noticeably on whichever pane has the most lines to actually scroll through.
      for (const id of this.openIds) {
        if (id === containerId) continue;
        const pane = this._panes[id];
        if (pane) pane.scrollToTimestamp(tsMs);
      }
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
            :class="{ 'row-selected': openIds.includes(c.id) }"
            :title="atCap && !openIds.includes(c.id) ? 'Close a pane first - up to ' + maxPanes + ' at a time' : ''"
            @click="toggleOpen(c.id)"
          >
            <span class="logs-tab-row-icon" v-html="stateIcon(c.state)"></span>
            <span class="logs-tab-row-name">{{ c.name }}</span>
          </div>
        </div>
      </div>
      <div class="logs-tab-viewer">
        <div v-if="openContainers.length" class="logs-tab-panes" :class="{ 'panes-grid': openContainers.length > 1 }">
          <log-viewer
            v-for="c in openContainers"
            :key="c.id"
            :ref="(el) => registerPane(c.id, el)"
            :host-id="hostId"
            :container-id="c.id"
            :container-name="c.name"
            :embedded="true"
            :closable="openContainers.length > 1"
            @scroll-sync="onScrollSync"
            @close="toggleOpen(c.id)"
          ></log-viewer>
        </div>
        <div v-else class="logs-tab-empty muted">Select up to {{ maxPanes }} containers on the left to view their logs side by side.</div>
      </div>
    </div>
  `,
};
