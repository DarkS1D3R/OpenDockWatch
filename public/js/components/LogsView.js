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
// broadcastFrom (the single place sync actually happens) calls scrollToTimestamp on every *other*
// open, sync-enabled pane - never the sender, which is already there and would otherwise fight the
// scroll gesture that got it there by re-snapping its own scrollTop to the nearest line boundary
// on every frame - so they all line up on the same point in time regardless of how many lines each
// container happens to log. Panes are looked up by container id via `_panes` (a plain, non-reactive
// map populated by a function :ref, since Vue only turns `ref` into an array automatically for
// elements directly inside a v-for that are *always* rendered that way - this template renders 1
// pane the same way it renders 4, so a plain id-keyed map is both correct and simpler than
// reasoning about array order). lastSyncTsMs is kept so a pane opened *after* the group has already
// scrolled somewhere joins at that same point instead of jumping in at the live tail while its
// siblings are looking at history.
//
// Two per-pane refinements on top of that peer-to-peer default:
// - `disabledSyncIds` - a pane can opt out of sync entirely (its own toggle button). Disabled means
//   both directions: it doesn't broadcast (also guarded inside LogViewer itself) and broadcastFrom
//   skips it as a target, so it scrolls exactly like it would if it were the only pane open.
// - `mainId` - designating one pane "the main" switches the group from peer-to-peer (whoever
//   scrolls drives everyone else) to leader-follower (only the main's scrolling drives anyone,
//   enforced by broadcastFrom's very first check). This is what lets you scroll a pane to a spot of
//   interest while it's desynced, mark it main, then flip sync back on and have the rest jump to
//   match it immediately - re-enabling (toggleSync) and marking main (setMain) each broadcast the
//   pane's *current* position on the spot when the pane in question is main and sync-enabled,
//   rather than waiting for its next scroll event.
//
// `wrapLines` is a single toggle at the top of the container list, fed straight down to every open
// pane's `wrap` prop - one control for the whole tab rather than duplicating it in each pane's
// already-crowded header.
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
    // The one place sync actually moves a pane. Gated on mainId first: once a pane is designated
    // main, only *its* scrolling is allowed to drive the group - everyone else's scroll-sync events
    // still arrive here (LogViewer can't tell there's a main) but are ignored. Then skips the sender
    // and any sync-disabled pane, same as always.
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
