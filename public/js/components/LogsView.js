import { stateEmoji } from '../format.js';
import { MAX_OPEN_LOG_PANES } from '../constants.js';
import LogViewer from './LogViewer.js';

// The Logs tab: a container list on the left and up to MAX_OPEN_LOG_PANES embedded LogViewers
// on the right, scroll-synced by timestamp (peer-to-peer by default; a pane can be marked "main"
// for leader-follower, or opt out of sync via `disabledSyncIds`). Full sync design in CLAUDE.md.
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
      // 'multi': click toggles a pane open/closed, up to MAX_OPEN_LOG_PANES. 'single': one pane,
      // click swaps which container fills it - see setViewMode/toggleOpen.
      viewMode: 'multi',
      openIds: [],
      lastSyncTsMs: null,
      disabledSyncIds: [],
      mainId: null,
      // The join-at timestamp handed to a pane at the moment it opens - see joinAtTsMs on LogViewer.
      // Keyed by id and left in place after use; it's read once at that pane's mount, so a stale
      // entry sitting here for a still-open pane has no further effect.
      joinTsMsById: {},
      // Measured, not guessed - see updateWrapHeight.
      wrapHeightPx: 420,
      // One toggle for the whole tab rather than one per pane (LogViewer's own header has this too,
      // but only when !embedded - here it'd mean repeating it in every already-crowded pane header
      // for a setting that's more useful applied uniformly anyway).
      wrapLines: true,
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
      this.disabledSyncIds = [];
      this.mainId = null;
      this.joinTsMsById = {};
    },
    // A container that disappears from the list (removed, or filtered out by the topbar's state
    // toggle) shouldn't leave a pane stuck rendering a stream for an id no longer in it - or leave
    // its sync-disabled/main status lingering for a *different* container that later reuses the id.
    allContainers() {
      const stillThere = new Set(this.allContainers.map((c) => c.id));
      if (this.openIds.some((id) => !stillThere.has(id))) {
        this.openIds = this.openIds.filter((id) => stillThere.has(id));
        this.disabledSyncIds = this.disabledSyncIds.filter((id) => stillThere.has(id));
        if (this.mainId != null && !stillThere.has(this.mainId)) this.mainId = null;
      }
    },
  },
  created() {
    this._panes = {};
  },
  mounted() {
    this.updateWrapHeight();
    // document.body doesn't actually resize with the viewport (its box is content-driven, not
    // viewport-driven - a ResizeObserver on it never fires just because the window did), so the
    // window's own resize event is the real signal here, not a proxy for it.
    window.addEventListener('resize', this.updateWrapHeight);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.updateWrapHeight);
  },
  methods: {
    updateWrapHeight() {
      const el = this.$refs.wrap;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      // 16px so the pane border doesn't sit flush against the very bottom edge of the window.
      this.wrapHeightPx = Math.max(420, Math.floor(window.innerHeight - top - 16));
    },
    registerPane(id, el) {
      if (el) this._panes[id] = el;
      else delete this._panes[id];
    },
    toggleOpen(id) {
      if (this.viewMode === 'single') {
        // One pane, no sync partners to track - clicking the open row closes it (mirrors multi
        // mode's toggle-off), clicking any other row just swaps the pane's container outright.
        this.openIds = this.openIds[0] === id ? [] : [id];
        this.disabledSyncIds = [];
        this.mainId = null;
        this.joinTsMsById = {};
        return;
      }
      if (this.openIds.includes(id)) {
        this.openIds = this.openIds.filter((openId) => openId !== id);
        this.disabledSyncIds = this.disabledSyncIds.filter((x) => x !== id);
        if (this.mainId === id) this.mainId = null;
        return;
      }
      if (this.atCap) return;
      this.openIds = [...this.openIds, id];
      // Slot the new pane into the group's current timeframe instead of at its own live tail - the
      // pane itself applies this once its first real burst of lines has loaded (joinAtTsMs prop).
      if (this.lastSyncTsMs != null) {
        this.joinTsMsById = { ...this.joinTsMsById, [id]: this.lastSyncTsMs };
      }
    },
    setViewMode(mode) {
      if (this.viewMode === mode) return;
      this.viewMode = mode;
      if (mode !== 'single' || this.openIds.length <= 1) return;
      // Collapsing multiple panes down to one: keep the main pane if there was one, else whichever
      // was opened most recently - both read as "the one I was just looking at".
      const keepId = this.mainId != null && this.openIds.includes(this.mainId) ? this.mainId : this.openIds[this.openIds.length - 1];
      this.openIds = [keepId];
      this.disabledSyncIds = [];
      this.mainId = null;
      this.joinTsMsById = {};
    },
    // The one place sync actually moves a pane. Gated on mainId first: once a pane is main, only
    // its scrolling drives the group - others' scroll-sync events still arrive but are ignored.
    // Then skips the sender and any sync-disabled pane.
    broadcastFrom(senderId, tsMs) {
      if (this.mainId != null && senderId !== this.mainId) return;
      if (this.disabledSyncIds.includes(senderId)) return;
      this.lastSyncTsMs = tsMs;
      for (const id of this.openIds) {
        if (id === senderId || this.disabledSyncIds.includes(id)) continue;
        const pane = this._panes[id];
        if (pane) pane.scrollToTimestamp(tsMs);
      }
    },
    onScrollSync({ containerId, tsMs }) {
      this.broadcastFrom(containerId, tsMs);
    },
    toggleSync(id) {
      if (this.disabledSyncIds.includes(id)) {
        this.disabledSyncIds = this.disabledSyncIds.filter((x) => x !== id);
        // Re-enabling the main pane should pull the rest to it right away, not wait for its next
        // scroll - that's the whole point of scrolling it to a spot *while* desynced first.
        if (id === this.mainId) {
          const pane = this._panes[id];
          const tsMs = pane && pane.visibleTopTsMs();
          if (tsMs != null) this.broadcastFrom(id, tsMs);
        }
      } else {
        this.disabledSyncIds = [...this.disabledSyncIds, id];
      }
    },
    setMain(id) {
      this.mainId = this.mainId === id ? null : id;
      // Same immediate-broadcast reasoning as toggleSync above, for the other order: marking an
      // already-synced pane main should assert its position as the reference right away too.
      if (this.mainId === id && !this.disabledSyncIds.includes(id)) {
        const pane = this._panes[id];
        const tsMs = pane && pane.visibleTopTsMs();
        if (tsMs != null) this.broadcastFrom(id, tsMs);
      }
    },
    stateIcon(state, health) {
      return stateEmoji(state, health);
    },
  },
  template: `
    <div class="logs-tab-wrap" ref="wrap" :style="{ height: wrapHeightPx + 'px' }">
      <div class="logs-tab-list">
        <div class="logs-tab-viewmode">
          <button
            class="small-btn"
            :class="{ active: viewMode === 'single' }"
            @click="setViewMode('single')"
            title="One pane - click a container to swap it in"
          >Single</button>
          <button
            class="small-btn"
            :class="{ active: viewMode === 'multi' }"
            @click="setViewMode('multi')"
            :title="'Up to ' + maxPanes + ' panes side by side, synced by timestamp'"
          >Multi</button>
        </div>
        <button
          class="small-btn logs-tab-wrap-toggle"
          :class="{ active: wrapLines }"
          @click="wrapLines = !wrapLines"
          :title="wrapLines ? 'Wrapping long lines in every open pane - turn off to scroll sideways instead' : 'Not wrapping - long lines scroll sideways in every open pane'"
        >
          {{ wrapLines ? '↵ Wrap lines' : '↔ No wrap' }}
        </button>
        <input type="text" v-model="search" placeholder="Filter containers…" class="logs-tab-search" />
        <p v-if="!filteredGroups.length" class="muted">No containers found.</p>
        <div v-for="[groupName, items] in filteredGroups" :key="groupName" class="logs-tab-group">
          <div class="logs-tab-group-label">{{ groupName }}</div>
          <div
            v-for="c in items"
            :key="c.id"
            class="logs-tab-row row-clickable"
            :class="{ 'row-selected': openIds.includes(c.id) }"
            :title="viewMode === 'multi' && atCap && !openIds.includes(c.id) ? 'Close a pane first - up to ' + maxPanes + ' at a time' : ''"
            @click="toggleOpen(c.id)"
          >
            <span class="logs-tab-row-icon" v-html="stateIcon(c.state, c.health)"></span>
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
            :multi-pane="openContainers.length > 1"
            :sync-enabled="!disabledSyncIds.includes(c.id)"
            :is-main="mainId === c.id"
            :join-at-ts-ms="joinTsMsById[c.id] ?? null"
            :wrap="wrapLines"
            @scroll-sync="onScrollSync"
            @toggle-sync="toggleSync(c.id)"
            @set-main="setMain(c.id)"
            @close="toggleOpen(c.id)"
          ></log-viewer>
        </div>
        <div v-else class="logs-tab-empty muted">{{ viewMode === 'single' ? 'Select a container on the left to view its logs.' : 'Select up to ' + maxPanes + ' containers on the left to view their logs side by side.' }}</div>
      </div>
    </div>
  `,
};
