import { MAX_LOG_LINES } from '../constants.js';
import { logsUrl, downloadLogsUrl } from '../api.js';
import { createLogStream } from '../lib/logStream.js';
import { closestIndexByTs } from '../lib/logSync.js';
import { decorateLines, selectLines } from '../lib/logLines.js';

// The full-size log panel: level/filter/tail controls, download, fullscreen, and the streamed
// log body. Also renders `embedded` in LogsView's multi-pane grid (fullscreen/wrap/close/sync
// controls differ by mode - see CLAUDE.md for the full embedded/multiPane/sync design).
export default {
  name: 'LogViewer',
  props: {
    hostId: { type: String, required: true },
    containerId: { type: String, required: true },
    containerName: { type: String, default: '' },
    withDetail: { type: Boolean, default: false },
    fullscreen: { type: Boolean, default: false },
    embedded: { type: Boolean, default: false },
    multiPane: { type: Boolean, default: false },
    syncEnabled: { type: Boolean, default: true },
    isMain: { type: Boolean, default: false },
    // Whether long lines wrap or run off the side with a horizontal scrollbar. Standalone owns
    // this via its own header toggle (v-model); embedded panes never render that toggle - LogsView
    // has one wrap toggle for the whole tab and feeds this prop straight down instead.
    wrap: { type: Boolean, default: true },
  },
  emits: ['close', 'update:fullscreen', 'update:wrap', 'scroll-sync', 'toggle-sync', 'set-main'],
  data() {
    return {
      tail: 200,
      filter: '',
      regexMode: false,
      levels: { error: true, warn: true, info: true, debug: true },
      lines: [],
      atBottom: true,
      loading: false,
      // Set by the stream when it hands its connection back while the tab is in the background -
      // rendered as a note in the header so a pane that has stopped updating never looks like a
      // container that has simply gone quiet.
      suspended: false,
      showTimestamps: true,
      // The narrow-pane fallback for the level toggle - a dropdown instead of four buttons wide
      // enough to clutter a half/quarter-width pane. Which one is visible is a CSS container-query
      // call on the pane's own width, but this open/closed state exists regardless of which shows.
      levelsMenuOpen: false,
      // Which matching line the search-hits box is currently parked on - a line index into
      // filteredLines, not a byte/char offset, since navigation jumps line to line (see activeHitIndex).
      activeMatchIndex: 0,
    };
  },
  computed: {
    testRegex() {
      if (!this.regexMode) return null;
      const pattern = this.filter.trim();
      if (!pattern) return null;
      try {
        return new RegExp(pattern, 'i');
      } catch {
        return null;
      }
    },
    regexError() {
      if (!this.regexMode || !this.filter.trim()) return null;
      return this.testRegex ? null : 'Invalid regex';
    },
    // The per-line level/timestamp/HTML work this used to do on every recompute now happens once
    // per line in appendLines - see lib/logLines.js for why that mattered at four panes.
    filteredLines() {
      return selectLines(this.lines, {
        levels: this.levels,
        filterText: this.filter.trim(),
        regexMode: this.regexMode,
        testRegex: this.testRegex,
      });
    },
    searchActive() {
      return !!this.filter.trim() && !this.regexError;
    },
    // Self-heals activeMatchIndex against a filteredLines list that shrank out from under it
    // (level toggle, or the oldest matching line aging out past MAX_LOG_LINES) without a watcher.
    activeHitIndex() {
      if (!this.filteredLines.length) return -1;
      return Math.min(this.activeMatchIndex, this.filteredLines.length - 1);
    },
  },
  created() {
    this._stream = null;
    this._programmatic = false;
    this._syncRaf = null;
  },
  watch: {
    // A new search term (or flipping regex mode) makes the old activeMatchIndex mean a different
    // line, so it jumps back to the first hit rather than pointing at an unrelated match.
    filter() {
      this.activeMatchIndex = 0;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
    regexMode() {
      this.activeMatchIndex = 0;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
  },
  mounted() {
    this.startStream();
    // Embedded instances sit in a fixed spot inside the Logs tab's layout and get remounted every
    // time the active container changes (keyed by container id) - scrolling the page to align them
    // would jump the whole tab on every click instead of just swapping the stream underneath it.
    if (!this.embedded) {
      this.$nextTick(() => {
        this.$el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    document.addEventListener('click', this.onDocumentClick);
  },
  beforeUnmount() {
    if (this._stream) {
      this._stream.stop();
      this._stream = null;
    }
    if (this._syncRaf) cancelAnimationFrame(this._syncRaf);
    document.removeEventListener('click', this.onDocumentClick);
  },
  methods: {
    startStream() {
      if (this._stream) this._stream.stop();
      this.lines = [];
      this.atBottom = true;
      // A fresh stream is never suspended - the flag would otherwise survive from the stream this
      // one replaces (e.g. changing the tail size) and leave a live pane labelled paused.
      this.suspended = false;
      this._stream = createLogStream({
        url: logsUrl(this.hostId, this.containerId, this.tail),
        onFlush: (lines) => this.appendLines(lines),
        onLoadingChange: (loading) => {
          this.loading = loading;
        },
        // The stream gives its connection back while the tab is backgrounded and reconnects from
        // the tail on return, so what's on screen has to go with it or the tail arrives twice.
        onReset: () => {
          this.lines = [];
          this.atBottom = true;
        },
        onSuspendChange: (suspended) => {
          this.suspended = suspended;
        },
      });
      this._stream.start();
    },
    appendLines(lines) {
      for (const line of decorateLines(lines)) this.lines.push(line);
      if (this.lines.length > MAX_LOG_LINES) {
        this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
      }
      if (this.atBottom) {
        this.$nextTick(() => {
          const el = this.$refs.logView;
          if (!el) return;
          // Not a user scroll - tailing live shouldn't broadcast a sync that drags a sibling pane
          // along too, or a pane the user deliberately scrolled back to read history on would keep
          // getting yanked back to "now" every time a *different*, still-tailing pane got a new line.
          this._programmatic = true;
          el.scrollTop = el.scrollHeight;
          requestAnimationFrame(() => {
            this._programmatic = false;
          });
        });
      }
    },
    changeTail(newTail) {
      this.tail = newTail;
      this.startStream();
    },
    downloadLogs() {
      window.location.href = downloadLogsUrl(this.hostId, this.containerId, this.tail);
    },
    onScroll() {
      const el = this.$refs.logView;
      if (el) this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      // A sync-driven scroll (scrollToTimestamp) shouldn't itself broadcast, or every pane would
      // ping-pong forever. rAF-throttled like logStream.js's own flush, since a real drag scroll
      // fires this dozens of times a frame. A pane with sync off never broadcasts at all.
      if (this._programmatic || this._syncRaf || !this.syncEnabled) return;
      this._syncRaf = requestAnimationFrame(() => {
        this._syncRaf = null;
        const tsMs = this.visibleTopTsMs();
        if (tsMs != null) this.$emit('scroll-sync', { containerId: this.containerId, tsMs });
      });
    },
    // The line currently at the top of the scrolled viewport, found by binary-searching the
    // rendered line-divs' offsetTop against scrollTop - monotonic per line even with wrapped text,
    // since <pre>'s children are exactly filteredLines in order with no wrapper in between.
    visibleTopTsMs() {
      const el = this.$refs.logView;
      if (!el || !el.children.length) return null;
      const children = el.children;
      let lo = 0;
      let hi = children.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (children[mid].offsetTop <= el.scrollTop) lo = mid;
        else hi = mid - 1;
      }
      const line = this.filteredLines[lo];
      return line ? line.tsMs : null;
    },
    // Scrolls this pane so the line closest to tsMs sits at the top - the follower half of
    // LogsView's multi-pane sync. _programmatic suppresses the scroll-sync this would otherwise
    // trigger right back (cleared next frame, after the resulting native scroll event has fired).
    scrollToTimestamp(tsMs) {
      // LogsView already skips a sync-disabled pane when broadcasting, but guarding here too means
      // this stays correct even if something else ever calls it directly.
      if (!this.syncEnabled) return;
      const el = this.$refs.logView;
      if (!el || tsMs == null) return;
      const index = closestIndexByTs(
        this.filteredLines.map((l) => l.tsMs),
        tsMs
      );
      const child = index === -1 ? null : el.children[index];
      if (!child) return;
      this._programmatic = true;
      el.scrollTop = child.offsetTop;
      requestAnimationFrame(() => {
        this._programmatic = false;
      });
    },
    nextMatch() {
      if (!this.filteredLines.length) return;
      this.activeMatchIndex = (this.activeHitIndex + 1) % this.filteredLines.length;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
    prevMatch() {
      if (!this.filteredLines.length) return;
      this.activeMatchIndex = (this.activeHitIndex - 1 + this.filteredLines.length) % this.filteredLines.length;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
    // Line-granularity, not per-occurrence: filteredLines' divs are the only stable scroll targets,
    // and centering on the matching line is enough to read which term hit without indexing marks.
    scrollToActiveMatch() {
      const el = this.$refs.logView;
      const child = el && this.activeHitIndex >= 0 ? el.children[this.activeHitIndex] : null;
      if (!child) return;
      this._programmatic = true;
      child.scrollIntoView({ block: 'center' });
      requestAnimationFrame(() => {
        this._programmatic = false;
      });
    },
    onFilterKeydown(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.shiftKey) this.prevMatch();
      else this.nextMatch();
    },
    scrollToBottom() {
      this.atBottom = true;
      const el = this.$refs.logView;
      if (el) el.scrollTop = el.scrollHeight;
    },
    toggleLevel(level) {
      this.levels = { ...this.levels, [level]: !this.levels[level] };
    },
    // Closes the compact level dropdown on an outside click - clicks on the menu itself or its
    // toggle button are excluded so ticking several levels in a row doesn't close it after each one.
    onDocumentClick(e) {
      if (!this.levelsMenuOpen) return;
      if (this.$refs.levelsMenuWrap && !this.$refs.levelsMenuWrap.contains(e.target)) {
        this.levelsMenuOpen = false;
      }
    },
    toggleFullscreen() {
      this.$emit('update:fullscreen', !this.fullscreen);
    },
  },
  template: `
    <div
      class="log-panel"
      :class="{
        'with-detail': withDetail && !fullscreen,
        fullscreen: fullscreen,
        embedded: embedded,
        'pane-main': multiPane && isMain,
        'pane-desynced': multiPane && !syncEnabled,
      }"
    >
      <div class="log-panel-header">
        <strong>{{ containerName }}</strong>
        <span v-if="suspended" class="log-paused-badge" title="Paused while this tab was in the background - it resumes from the latest lines when you come back">paused</span>
        <div class="log-panel-controls">
          <div class="log-level-toggle log-level-toggle-full">
            <button :class="{active: levels.error}" class="level-error" @click="toggleLevel('error')">Error</button>
            <button :class="{active: levels.warn}" class="level-warn" @click="toggleLevel('warn')">Warn</button>
            <button :class="{active: levels.info}" class="level-info" @click="toggleLevel('info')">Info</button>
            <button :class="{active: levels.debug}" class="level-debug" @click="toggleLevel('debug')">Debug</button>
          </div>
          <div class="log-level-toggle-compact" ref="levelsMenuWrap">
            <button
              class="small-btn"
              :class="{ active: levelsMenuOpen }"
              @click="levelsMenuOpen = !levelsMenuOpen"
              title="Log level filters"
            >
              ☰ Levels
            </button>
            <div v-if="levelsMenuOpen" class="log-levels-menu">
              <div class="log-level-toggle log-level-toggle-stacked">
                <button :class="{active: levels.error}" class="level-error" @click="toggleLevel('error')">Error</button>
                <button :class="{active: levels.warn}" class="level-warn" @click="toggleLevel('warn')">Warn</button>
                <button :class="{active: levels.info}" class="level-info" @click="toggleLevel('info')">Info</button>
                <button :class="{active: levels.debug}" class="level-debug" @click="toggleLevel('debug')">Debug</button>
              </div>
            </div>
          </div>
          <div class="log-filter-group">
            <div class="log-filter-input-wrap">
              <span class="log-filter-icon">🔍</span>
              <input
                type="text"
                v-model="filter"
                @keydown="onFilterKeydown"
                :placeholder="regexMode ? 'Filter logs (regex)…' : 'Filter logs…'"
                :class="{ 'filter-invalid': regexError }"
              />
              <button v-if="filter" class="filter-clear-btn" @click="filter = ''" title="Clear filter">✕</button>
            </div>
            <button
              class="small-btn regex-toggle-btn"
              :class="{ active: regexMode }"
              @click="regexMode = !regexMode"
              title="Treat filter text as a regular expression"
            >
              .*
            </button>
            <span v-if="regexError" class="filter-error-text">{{ regexError }}</span>
            <div v-else-if="searchActive" class="search-hits-box">
              <button class="search-hits-btn" @click="prevMatch" :disabled="!filteredLines.length" title="Previous match (Shift+Enter)">▲</button>
              <span class="search-hits-count">{{ filteredLines.length ? activeHitIndex + 1 : 0 }} / {{ filteredLines.length }}</span>
              <button class="search-hits-btn" @click="nextMatch" :disabled="!filteredLines.length" title="Next match (Enter)">▼</button>
            </div>
          </div>
          <select :value="tail" @change="changeTail($event.target.value === 'all' ? 'all' : Number($event.target.value))">
            <option :value="100">Last 100 lines</option>
            <option :value="200">Last 200 lines</option>
            <option :value="1000">Last 1000 lines</option>
            <option :value="5000">Last 5000 lines</option>
            <option value="all">All lines</option>
          </select>
          <button class="small-btn" @click="downloadLogs" title="Download the currently selected tail as a text file">⬇ Download</button>
          <button
            class="small-btn"
            :class="{ active: showTimestamps }"
            @click="showTimestamps = !showTimestamps"
            title="Toggle the docker timestamp shown at the start of each line"
          >
            🕐 Time
          </button>
          <button v-if="!embedded" class="small-btn" @click="toggleFullscreen" :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen - hide everything else so you can see more of the log'">
            {{ fullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen' }}
          </button>
          <button
            v-if="!embedded"
            class="small-btn"
            :class="{ active: wrap }"
            @click="$emit('update:wrap', !wrap)"
            :title="wrap ? 'Wrapping long lines - turn off to scroll sideways instead' : 'Not wrapping - long lines scroll sideways'"
          >
            {{ wrap ? '↵ Wrap' : '↔ No wrap' }}
          </button>
          <template v-if="multiPane">
            <button
              class="small-btn"
              :class="{ active: syncEnabled }"
              @click="$emit('toggle-sync')"
              :title="syncEnabled ? 'Synced - scroll it to move the other open panes, or turn this off to scroll it independently' : 'Not synced - scrolling this pane does not move, or get moved by, the others'"
            >
              {{ syncEnabled ? '🔗 Synced' : '⛓️‍💥 Independent' }}
            </button>
            <button
              class="log-pane-main-btn"
              :class="{ active: isMain }"
              @click="$emit('set-main')"
              :title="isMain ? 'This is the pane the others follow when synced - click to unset' : 'Make this the pane the others follow when synced'"
            >
              {{ isMain ? '★' : '☆' }}
            </button>
          </template>
          <button v-if="!embedded" @click="$emit('close')">Close</button>
          <button v-else-if="multiPane" class="small-btn log-pane-close-btn" @click="$emit('close')" title="Close this pane">
            ✕
          </button>
        </div>
      </div>
      <div class="log-view-wrap">
        <div v-if="loading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
        <pre class="log-view log-viewer-pane" :class="{ 'hide-ts': !showTimestamps, 'no-wrap': !wrap }" ref="logView" @scroll="onScroll"><div v-for="(line, idx) in filteredLines" :key="line.id" :class="{ 'search-active-line': searchActive && idx === activeHitIndex }" v-html="line.html"></div></pre>
        <button v-show="!atBottom" class="scroll-bottom-btn" @click="scrollToBottom" title="Scroll to bottom">&#8595; Bottom</button>
      </div>
    </div>
  `,
};
