import { stateEmoji } from '../format.js';
import { MAX_OPEN_LOG_PANES } from '../constants.js';
import { loadOpenPanes, saveOpenPanes } from '../lib/logsPersistence.js';
import LogViewer from './LogViewer.js';
import LogSearchPanel from './LogSearchPanel.js';

// The Logs tab: a container list on the left and up to MAX_OPEN_LOG_PANES embedded LogViewers
// on the right, scroll-synced by timestamp (peer-to-peer by default; a pane can be marked "main"
// for leader-follower, or opt out of sync via `disabledSyncIds`). Full sync design in public/CLAUDE.md.
export default {
  name: 'LogsView',
  components: { LogViewer, LogSearchPanel },
  props: {
    hostId: { type: String, required: true },
    groupedContainers: { type: Array, required: true },
    // Set by the List view's "Logs" button (see app.js's openLogsFor) to land straight on this
    // container in single-pane mode. Read once at mount - this component is v-if'd, so it remounts
    // fresh every time the tab is switched into, never patched while already showing.
    openContainerId: { type: String, default: null },
    // With openContainerId: open that pane on the log around this time (an alert's timestamp).
    openSeekTsMs: { type: Number, default: null },
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
      // Panes to open on the log around a time rather than at the tail. Read once at each pane's
      // mount; dropped when the pane closes (see the openIds watcher) so reopening it goes live.
      seekTsMsById: {},
      // Measured, not guessed - see updateWrapHeight.
      wrapHeightPx: 420,
      // One toggle for the whole tab rather than one per pane (LogViewer's own header has this too,
      // but only when !embedded - here it'd mean repeating it in every already-crowded pane header
      // for a setting that's more useful applied uniformly anyway).
      wrapLines: true,
      // The compose project the search panel is for, and whether it is showing. Hidden rather than
      // closed after a result is opened, so "Back to results" returns to the same list.
      searchProject: null,
      searchVisible: false,
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
    allContainerIds() {
      return this.allContainers.map((c) => c.id);
    },
  },
  watch: {
    // Switching host restores that host's own saved panes rather than clearing - the memory is
    // keyed per host precisely because a container id means nothing on a different daemon, so
    // "what did I have open here" is a question each host answers for itself.
    hostId(id) {
      this.restoreOpenPanes(id);
      this.closeSearch();
    },
    // Anything naming a pane is worth remembering; the scroll positions (lastSyncTsMs,
    // joinTsMsById) deliberately are not, since every pane re-tails on return and a saved
    // timeframe would land the group somewhere the logs no longer are.
    openIds(ids) {
      this.persistOpenPanes();
      const kept = Object.keys(this.seekTsMsById).filter((id) => ids.includes(id));
      if (kept.length !== Object.keys(this.seekTsMsById).length) {
        this.seekTsMsById = Object.fromEntries(kept.map((id) => [id, this.seekTsMsById[id]]));
      }
    },
    viewMode: 'persistOpenPanes',
    disabledSyncIds: 'persistOpenPanes',
    mainId: 'persistOpenPanes',
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
    this.restoreOpenPanes(this.hostId);
    // Arriving from the List view's "Logs" button overrides whatever was remembered: that click
    // names a container, which is a more specific request than "put back what I had".
    if (this.openContainerId) {
      this.viewMode = 'single';
      this.openIds = [this.openContainerId];
      this.disabledSyncIds = [];
      this.mainId = null;
      if (this.openSeekTsMs != null) this.seekTsMsById = { [this.openContainerId]: this.openSeekTsMs };
    }
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
    // Deliberately does *not* filter against the current container list - after a host switch that
    // list is still the previous host's, so filtering would drop every restored id and persist the
    // emptiness. The allContainers watcher prunes on the first real poll instead. See public/CLAUDE.md.
    restoreOpenPanes(hostId) {
      const saved = loadOpenPanes(hostId);
      this.viewMode = saved ? saved.viewMode : 'multi';
      this.openIds = saved ? saved.openIds : [];
      this.disabledSyncIds = saved ? saved.disabledSyncIds : [];
      this.mainId = saved ? saved.mainId : null;
      // Scroll state is per visit, not per host: the panes re-tail from scratch on return.
      this.lastSyncTsMs = null;
      this.joinTsMsById = {};
    },
    persistOpenPanes() {
      saveOpenPanes(this.hostId, {
        viewMode: this.viewMode,
        openIds: this.openIds,
        disabledSyncIds: this.disabledSyncIds,
        mainId: this.mainId,
      });
    },
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
    // "Ungrouped" is app.js's synthetic bucket for standalone containers - no project to search.
    isRealGroup(name) {
      return name !== 'Ungrouped';
    },
    openSearch(project) {
      this.searchProject = project;
      this.searchVisible = true;
    },
    closeSearch() {
      this.searchProject = null;
      this.searchVisible = false;
    },
    // A search result: open that container's pane on the log around the matched line. seekToTsMs is
    // read once at a pane's mount, so a pane that's already open is closed and remounted to take it.
    async openAt({ containerId, tsMs }) {
      this.searchVisible = false;
      if (!this.allContainers.some((c) => c.id === containerId)) return;
      if (this.openIds.includes(containerId)) {
        this.openIds = this.openIds.filter((id) => id !== containerId);
        await this.$nextTick();
      }
      if (this.viewMode === 'single') {
        this.openIds = [];
        this.disabledSyncIds = [];
        this.mainId = null;
        this.joinTsMsById = {};
      } else if (this.atCap) {
        // Full grid: the oldest pane that isn't main makes room, so the result always opens.
        const evict = this.openIds.find((id) => id !== this.mainId) ?? this.openIds[0];
        this.openIds = this.openIds.filter((id) => id !== evict);
        this.disabledSyncIds = this.disabledSyncIds.filter((id) => id !== evict);
        if (this.mainId === evict) this.mainId = null;
      }
      this.seekTsMsById = { ...this.seekTsMsById, [containerId]: tsMs };
      this.openIds = [...this.openIds, containerId];
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
            :class="{ active: viewMode === 'single' }" :aria-pressed="String(viewMode === 'single')"
            @click="setViewMode('single')"
            title="One pane - click a container to swap it in"
          >Single</button>
          <button
            class="small-btn"
            :class="{ active: viewMode === 'multi' }" :aria-pressed="String(viewMode === 'multi')"
            @click="setViewMode('multi')"
            :title="'Up to ' + maxPanes + ' panes side by side, synced by timestamp'"
          >Multi</button>
        </div>
        <button
          class="small-btn logs-tab-wrap-toggle"
          :class="{ active: wrapLines }" :aria-pressed="String(wrapLines)"
          @click="wrapLines = !wrapLines"
          :title="wrapLines ? 'Wrapping long lines in every open pane - turn off to scroll sideways instead' : 'Not wrapping - long lines scroll sideways in every open pane'"
        >
          {{ wrapLines ? '↵ Wrap lines' : '↔ No wrap' }}
        </button>
        <button v-if="searchProject && !searchVisible" class="small-btn logs-tab-back-to-search" @click="searchVisible = true" :title="'Back to the search results for ' + searchProject">
          ← Results: {{ searchProject }}
        </button>
        <div class="search-clear-wrap logs-tab-search-wrap">
          <input type="text" v-model="search" placeholder="Filter containers…" aria-label="Filter containers by name" class="logs-tab-search" />
          <button aria-label="Clear filter" v-if="search" class="filter-clear-btn" @click="search = ''" title="Clear filter">✕</button>
        </div>
        <p v-if="!filteredGroups.length" class="muted">No containers found.</p>
        <div v-for="[groupName, items] in filteredGroups" :key="groupName" class="logs-tab-group">
          <div class="logs-tab-group-label">
            <span class="logs-tab-group-name">{{ groupName }}</span>
            <button
              v-if="isRealGroup(groupName)"
              class="logs-tab-group-search"
              :class="{ active: searchVisible && searchProject === groupName }" :aria-pressed="String(searchVisible && searchProject === groupName)"
              @click="openSearch(groupName)"
              title="Search the logs of every container in this project at once"
            >Search</button>
          </div>
          <div
            v-for="c in items"
            :key="c.id"
            class="logs-tab-row row-clickable"
            :class="{ 'row-selected': openIds.includes(c.id) }"
            :title="viewMode === 'multi' && atCap && !openIds.includes(c.id) ? 'Close a pane first - up to ' + maxPanes + ' at a time' : ''"
            role="button"
            tabindex="0"
            :aria-pressed="String(openIds.includes(c.id))"
            @click="toggleOpen(c.id)"
            @keydown.enter.prevent="toggleOpen(c.id)"
            @keydown.space.prevent="toggleOpen(c.id)"
          >
            <span class="logs-tab-row-icon" v-html="stateIcon(c.state, c.health)"></span>
            <span class="logs-tab-row-name">{{ c.name }}</span>
          </div>
        </div>
      </div>
      <div class="logs-tab-viewer">
        <log-search-panel
          v-if="searchProject"
          v-show="searchVisible"
          class="logs-tab-search-overlay"
          :host-id="hostId"
          :project="searchProject"
          :container-ids="allContainerIds"
          :wrap="wrapLines"
          @open-at="openAt"
          @close="closeSearch"
        ></log-search-panel>
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
            :seek-to-ts-ms="seekTsMsById[c.id] ?? null"
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
