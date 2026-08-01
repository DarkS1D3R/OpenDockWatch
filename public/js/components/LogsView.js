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
      openIds: [],
      lastSyncTsMs: null,
      disabledSyncIds: [],
      mainId: null,
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
      if (this.openIds.includes(id)) {
        this.openIds = this.openIds.filter((openId) => openId !== id);
        this.disabledSyncIds = this.disabledSyncIds.filter((x) => x !== id);
        if (this.mainId === id) this.mainId = null;
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
    stateIcon(state) {
      return stateEmoji(state);
    },
  },
  template: `
    <div class="logs-tab-wrap" ref="wrap" :style="{ height: wrapHeightPx + 'px' }">
      <div class="logs-tab-list">
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
            :multi-pane="openContainers.length > 1"
            :sync-enabled="!disabledSyncIds.includes(c.id)"
            :is-main="mainId === c.id"
            :wrap="wrapLines"
            @scroll-sync="onScrollSync"
            @toggle-sync="toggleSync(c.id)"
            @set-main="setMain(c.id)"
            @close="toggleOpen(c.id)"
          ></log-viewer>
        </div>
        <div v-else class="logs-tab-empty muted">Select up to {{ maxPanes }} containers on the left to view their logs side by side.</div>
      </div>
    </div>
  `,
};
