import { MAX_LOG_LINES } from '../constants.js';
import { logsUrl, downloadLogsUrl } from '../api.js';
import { createLogStream } from '../lib/logStream.js';
import { closestIndexByTs } from '../lib/logSync.js';
import { decorateLines, selectLines, hitIndexFor, stepHitId } from '../lib/logLines.js';
import { pushCapped } from '../lib/logBuffer.js';

// The match strip drags by its own top edge (the boundary with the log body), not by the
// browser's native `resize` corner: the strip is anchored to the bottom of the panel, so the
// corner handle sits diagonally opposite the edge that actually moves, is invisible until found
// by accident, and grows the strip downward off the end of a fixed-height panel. Bounds are
// resolved live against the log body rather than fixed here - the strip can only take what the
// body can spare, since the panel is a fixed-height flex column.
const MATCH_MIN_PX = 60;
const MIN_LOG_BODY_PX = 120;
const MATCH_KEY_STEP_PX = 24;

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
    // A timestamp to scroll to once this pane's first real burst of lines has loaded, instead of
    // live-tailing at the bottom - LogsView sets this when opening a pane into an already-scrolled
    // group. Read once at mount, in startStream; a later prop change doesn't re-trigger it.
    joinAtTsMs: { type: Number, default: null },
  },
  emits: ['close', 'update:fullscreen', 'update:wrap', 'scroll-sync', 'toggle-sync', 'set-main'],
  data() {
    return {
      tail: 1000,
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
      // Which matching line the search-hits box is parked on, held as that line's id rather than
      // its position - the buffer trims from the front while tailing, so a position stops meaning
      // the same line. null is "nothing picked yet", which reads as the first hit. See lib/logLines.js.
      activeMatchId: null,
      // Clicking a hit sets this instead of clearing the filter - filteredLines then keeps every
      // line (context included) rather than just the matches, while the hits box/count still track
      // matches only via matchLines. Typing a new filter term drops back out of it (see the filter
      // watcher); clearing the filter entirely just turns searchActive off, which hides all of it.
      revealAll: false,
      // Manual pause (space bar / the header button), distinct from `suspended` above: the stream
      // stays connected and its lines are buffered off-screen in _pendingLines, so resuming shows
      // what arrived rather than re-tailing. Dropping the connection would cost a re-tail instead.
      paused: false,
      pendingCount: 0,
      // The filtered-results strip: the match list rendered under the log body as its own
      // scrollable pane, single-pane only (multiPane has no room). Off by default - see matchPaneVisible.
      showMatchPane: false,
      // The strip's dragged height, held here rather than as an inline style the drag writes
      // directly, because the list is v-if'd twice over (the pane toggle, then searchActive) and
      // would otherwise lose the height the moment the strip is hidden or the filter is cleared.
      matchListHeight: null,
      matchResizing: false,
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
    // The match strip already lists the hits, so narrowing the body to them as well would hide the
    // surrounding context the strip exists to jump *into* - it makes revealAll's behaviour the
    // default while it's open, rather than something you get only after clicking a hit.
    showAllLines() {
      return this.revealAll || this.matchPaneVisible;
    },
    filteredLines() {
      return selectLines(this.lines, {
        levels: this.levels,
        filterText: this.filter.trim(),
        regexMode: this.regexMode,
        testRegex: this.testRegex,
        hideNonMatching: !this.showAllLines,
      });
    },
    // The actual hit list, independent of revealAll - the count/prev/next controls step through
    // matches only, even while filteredLines is showing every line for context.
    matchLines() {
      if (!this.searchActive) return [];
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
    // Resolves the id back to a position in matchLines on every render, so the highlight follows
    // its line as the list shifts underneath it (append, trim, level toggle) instead of staying put
    // while the lines move past. Computed, so the lookup runs once per render pass, not per line.
    activeHitIndex() {
      return hitIndexFor(this.matchLines, this.activeMatchId);
    },
    // The concrete id activeHitIndex resolved to (including the "null cursor = first hit" fallback)
    // - what the template actually compares against, since filteredLines and matchLines can now be
    // different arrays with different indices for the same line.
    activeHitId() {
      const idx = this.activeHitIndex;
      return idx >= 0 ? this.matchLines[idx].id : null;
    },
    // Single-pane only: a quarter-width pane in the 4-up grid has no vertical room to give up,
    // and the strip would push the log body down to nothing. The standalone viewer counts as
    // single too - it's one pane with the whole width, which is exactly what this wants.
    matchPaneVisible() {
      return this.showMatchPane && !this.multiPane;
    },
    matchListStyle() {
      return this.matchListHeight ? { height: this.matchListHeight + 'px' } : null;
    },
    // One badge rather than a span per state: the three are mutually exclusive, and "active" only
    // reads as meaningful because it sits in the same spot the paused states do. Manual pause wins
    // over suspension - if the user paused it, that's the answer to "why isn't this moving".
    statusBadge() {
      if (this.paused) {
        return {
          cls: 'log-status-paused',
          text: `⏸ paused${this.pendingCount ? ' · ' + this.pendingCount + ' held' : ''}`,
          title: 'Paused - new lines are being held. Press space (or click Resume) to catch up.',
        };
      }
      if (this.suspended) {
        return {
          cls: 'log-status-suspended',
          text: '⏸ suspended',
          title: 'Paused while this tab was in the background - it resumes from the latest lines when you come back',
        };
      }
      return { cls: 'log-status-active', text: '▶ active', title: 'Streaming live - press space to pause' };
    },
  },
  created() {
    this._stream = null;
    this._programmatic = false;
    this._syncRaf = null;
    this._pendingJoinTsMs = null;
    // Deliberately not reactive: this holds up to MAX_LOG_LINES decorated lines that nothing
    // renders while paused, so reactivity on it would be pure overhead. pendingCount carries the
    // only part the template needs.
    this._pendingLines = [];
    this._hovered = false;
  },
  watch: {
    // A new search term (or flipping regex mode) is a new hit list, so the cursor goes back to the
    // first of them rather than staying on a line that may not even match any more. Also drops
    // revealAll - typing a further term means "search again", i.e. narrow back down to just the
    // hits, per selectMatch below. An edit down to an empty filter turns searchActive off instead,
    // which is what actually hides the hits box/highlighting - revealAll itself being stale by then
    // doesn't matter, since nothing reads it while search is inactive.
    filter() {
      this.revealAll = false;
      this.resetMatchCursor();
    },
    regexMode() {
      this.revealAll = false;
      this.resetMatchCursor();
    },
    // Keeps the match pane's own highlight on screen while ▲/▼ (or Enter) walk the hit list - the
    // main body already scrolls itself via scrollToActiveMatch, and the two move together.
    activeHitId() {
      if (this.matchPaneVisible) this.$nextTick(() => this.scrollMatchRowIntoView());
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
    document.addEventListener('keydown', this.onKeydown);
  },
  beforeUnmount() {
    if (this._stream) {
      this._stream.stop();
      this._stream = null;
    }
    if (this._syncRaf) cancelAnimationFrame(this._syncRaf);
    this.endMatchResize();
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onKeydown);
  },
  methods: {
    // How tall the strip may currently be: whatever it is now, plus whatever the log body can give
    // up without dropping under MIN_LOG_BODY_PX. Computed per drag rather than baked into CSS
    // because the panel's own height varies (fullscreen is a viewport calc, embedded is measured
    // by LogsView) - a fixed px cap eats the whole log on a short window, and a vh cap is only
    // right for the fullscreen one.
    matchMaxHeight() {
      const list = this.$refs.matchList;
      const body = this.$refs.logView;
      const current = list ? list.offsetHeight : MATCH_MIN_PX;
      if (!body) return current;
      return current + Math.max(0, body.offsetHeight - MIN_LOG_BODY_PX);
    },
    setMatchListHeight(px) {
      this.matchListHeight = Math.round(Math.min(this.matchMaxHeight(), Math.max(MATCH_MIN_PX, px)));
    },
    // Listeners go on window, not the handle: a fast drag outruns the element under the cursor,
    // and the pointer regularly ends up over the log body or outside the panel entirely.
    startMatchResize(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      // The header doubles as the drag handle, so the ✕ inside it has to keep working as a button -
      // without this, pressing it starts a zero-distance drag and preventDefault eats the click.
      if (ev.target.closest('button')) return;
      const list = this.$refs.matchList;
      if (!list) return;
      ev.preventDefault();
      const startY = ev.clientY;
      const startH = list.offsetHeight;
      const maxH = this.matchMaxHeight();
      this.matchResizing = true;
      this._matchDrag = {
        move: (e) => {
          // The handle is the strip's *top* edge, so dragging up has to make it taller - the
          // delta is subtracted, not added. Getting this backwards is the whole reason the
          // native corner handle was wrong for a bottom-anchored pane.
          this.matchListHeight = Math.round(Math.min(maxH, Math.max(MATCH_MIN_PX, startH - (e.clientY - startY))));
        },
        up: () => this.endMatchResize(),
      };
      window.addEventListener('pointermove', this._matchDrag.move);
      window.addEventListener('pointerup', this._matchDrag.up);
      window.addEventListener('pointercancel', this._matchDrag.up);
    },
    endMatchResize() {
      if (!this._matchDrag) return;
      window.removeEventListener('pointermove', this._matchDrag.move);
      window.removeEventListener('pointerup', this._matchDrag.up);
      window.removeEventListener('pointercancel', this._matchDrag.up);
      this._matchDrag = null;
      this.matchResizing = false;
    },
    // The handle is a focusable separator, so the strip is resizable without a pointer at all.
    onMatchResizeKey(ev) {
      const dir = ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowDown' ? -1 : 0;
      if (!dir) return;
      ev.preventDefault();
      const list = this.$refs.matchList;
      this.setMatchListHeight((list ? list.offsetHeight : MATCH_MIN_PX) + dir * MATCH_KEY_STEP_PX);
    },
    startStream() {
      if (this._stream) this._stream.stop();
      this.lines = [];
      this.atBottom = true;
      // logStream restarts line ids from 0 for a new source, so a cursor held across one would
      // point at whatever unrelated line inherits that id. Same reason in onReset below.
      this.activeMatchId = null;
      this.revealAll = false;
      // A fresh stream is never suspended - the flag would otherwise survive from the stream this
      // one replaces (e.g. changing the tail size) and leave a live pane labelled paused.
      this.suspended = false;
      this.paused = false;
      this.clearPending();
      this._pendingJoinTsMs = this.joinAtTsMs;
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
          this.activeMatchId = null;
          this.revealAll = false;
          // Unpause rather than hold: the reset just wiped whatever was being read, so staying
          // paused would leave an empty pane that never fills - which reads as broken, not paused.
          this.paused = false;
          this.clearPending();
        },
        onSuspendChange: (suspended) => {
          this.suspended = suspended;
        },
      });
      this._stream.start();
    },
    appendLines(lines) {
      // Paused: buffer instead of rendering, capped at the same MAX_LOG_LINES the visible buffer
      // is - a chatty container left paused for an hour must not grow this without bound.
      if (this.paused) {
        pushCapped(this._pendingLines, decorateLines(lines), MAX_LOG_LINES);
        this.pendingCount = this._pendingLines.length;
        return;
      }
      pushCapped(this.lines, decorateLines(lines), MAX_LOG_LINES);
      // First real content since a pending join was requested - honor it instead of the normal
      // tail-to-bottom behavior below, then never again for this stream (one-shot).
      if (this._pendingJoinTsMs != null) {
        const tsMs = this._pendingJoinTsMs;
        this._pendingJoinTsMs = null;
        this.atBottom = false;
        this.$nextTick(() => this.scrollToTimestamp(tsMs));
        return;
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
    togglePause() {
      if (this.paused) this.resumeLogs();
      else this.paused = true;
    },
    resumeLogs() {
      this.paused = false;
      const pending = this._pendingLines;
      this._pendingLines = [];
      this.pendingCount = 0;
      if (!pending.length) return;
      // Straight onto the visible buffer rather than back through appendLines - these are already
      // decorated, and re-running that would decorate them a second time.
      pushCapped(this.lines, pending, MAX_LOG_LINES);
      if (this.atBottom) this.$nextTick(() => this.scrollToBottom());
    },
    clearPending() {
      this._pendingLines = [];
      this.pendingCount = 0;
    },
    // Space toggles pause. Ignored while typing (the filter box needs its spaces) and with any
    // modifier held, and preventDefault stops the page-scroll space would otherwise do.
    onKeydown(e) {
      if (e.key !== ' ' && e.code !== 'Space') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      // Every open pane has this listener, so in multi-pane the hovered one takes it - otherwise
      // one space would pause all four at once. A lone pane doesn't need to be hovered first.
      if (this.multiPane && !this._hovered) return;
      e.preventDefault();
      this.togglePause();
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
    resetMatchCursor() {
      this.activeMatchId = null;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
    nextMatch() {
      this.moveMatch(1);
    },
    prevMatch() {
      this.moveMatch(-1);
    },
    moveMatch(delta) {
      const id = stepHitId(this.matchLines, this.activeMatchId, delta);
      if (id == null) return;
      this.activeMatchId = id;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
    // Clicking a hit reveals the full log around it instead of parking the cursor on it within
    // the still-narrowed view - revealAll switches filteredLines over to "every line, matches
    // highlighted" (see its computed). The filter term itself, and the hits box, both stay put.
    selectMatch(id) {
      if (!this.searchActive) return;
      this.revealAll = true;
      this.activeMatchId = id;
      this.$nextTick(() => this.scrollToActiveMatch());
    },
    // Line-granularity, not per-occurrence: filteredLines' divs are the only stable scroll targets,
    // and centering on the matching line is enough to read which term hit without indexing marks.
    // Looked up by id, not activeHitIndex directly - that index is into matchLines, which is a
    // different array from filteredLines (and from its rendered divs) once revealAll is on.
    scrollToActiveMatch() {
      const el = this.$refs.logView;
      const id = this.activeHitId;
      if (!el || id == null) return;
      const idx = this.filteredLines.findIndex((l) => l.id === id);
      const child = idx === -1 ? null : el.children[idx];
      if (!child) return;
      this._programmatic = true;
      child.scrollIntoView({ block: 'center' });
      requestAnimationFrame(() => {
        this._programmatic = false;
      });
    },
    // Scrolls within the match strip only (nearest, not center) so it never yanks the page.
    scrollMatchRowIntoView() {
      const list = this.$refs.matchList;
      const id = this.activeHitId;
      if (!list || id == null) return;
      const idx = this.matchLines.findIndex((l) => l.id === id);
      const row = idx === -1 ? null : list.children[idx];
      if (row) row.scrollIntoView({ block: 'nearest' });
    },
    onFilterKeydown(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.prevMatch();
        else this.nextMatch();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.nextMatch();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.prevMatch();
      }
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
        'has-match-pane': matchPaneVisible,
      }"
      @mouseenter="_hovered = true"
      @mouseleave="_hovered = false"
    >
      <div class="log-panel-header">
        <strong class="log-panel-name" :title="containerName">{{ containerName }}</strong>
        <div class="log-panel-statusline">
          <span class="log-status-badge" :class="statusBadge.cls" :title="statusBadge.title">{{ statusBadge.text }}</span>
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
              <button class="search-hits-btn" @click="prevMatch" :disabled="!matchLines.length" title="Previous match (Shift+Enter or ↑)">▲</button>
              <span class="search-hits-count">{{ matchLines.length ? activeHitIndex + 1 : 0 }} / {{ matchLines.length }}</span>
              <button class="search-hits-btn" @click="nextMatch" :disabled="!matchLines.length" title="Next match (Enter or ↓)">▼</button>
            </div>
            <button
              v-if="!multiPane"
              class="small-btn"
              :class="{ active: showMatchPane }"
              @click="showMatchPane = !showMatchPane"
              title="List every matching line in a strip below - the log itself stays unfiltered, so clicking a match jumps to it in context"
            >
              ☰ <span class="btn-label">Matches</span>
            </button>
          </div>
          <select :value="tail" @change="changeTail($event.target.value === 'all' ? 'all' : Number($event.target.value))" title="How many lines to load">
            <option :value="1000">1000</option>
            <option :value="5000">5000</option>
            <option :value="10000">10000</option>
            <option value="all">All</option>
          </select>
          <button class="small-btn log-download-btn" @click="downloadLogs" title="Download the currently selected tail as a text file"><span class="btn-icon">⬇</span> <span class="btn-label">Download</span></button>
          <button
            class="small-btn"
            :class="{ active: paused }"
            @click="togglePause"
            :title="paused ? 'Paused - new lines are held until you resume (space)' : 'Pause the log - new lines are held rather than dropped (space)'"
          >
            {{ paused ? '▶' : '⏸' }} <span class="btn-label">{{ paused ? 'Resume' : 'Pause' }}</span>
          </button>
          <button
            class="small-btn"
            :class="{ active: showTimestamps }"
            @click="showTimestamps = !showTimestamps"
            title="Toggle the docker timestamp shown at the start of each line"
          >
            🕐 <span class="btn-label">Time</span>
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
      </div>
      <div class="log-view-wrap">
        <div v-if="loading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
        <pre class="log-view log-viewer-pane" :class="{ 'hide-ts': !showTimestamps, 'no-wrap': !wrap }" ref="logView" @scroll="onScroll"><div v-for="line in filteredLines" :key="line.id" :class="{ 'search-active-line': searchActive && line.id === activeHitId, 'search-line-clickable': searchActive && line.isMatch }" @click="line.isMatch && selectMatch(line.id)" v-html="line.html"></div></pre>
        <button v-show="!atBottom" class="scroll-bottom-btn" @click="scrollToBottom" title="Scroll to bottom">&#8595; Bottom</button>
      </div>
      <div v-if="matchPaneVisible" class="log-match-pane" :class="{ resizing: matchResizing }">
        <div
          class="log-match-pane-header"
          tabindex="0"
          aria-label="Match list header - drag, or use the arrow keys, to resize"
          title="Drag to resize"
          @pointerdown="startMatchResize"
          @keydown="onMatchResizeKey"
        >
          <span class="muted small" v-if="searchActive">{{ matchLines.length }} matching {{ matchLines.length === 1 ? 'line' : 'lines' }}</span>
          <span class="muted small" v-else>Type a filter above to list matching lines here.</span>
          <button class="small-btn log-match-close" @click="showMatchPane = false" title="Hide the match list">✕</button>
        </div>
        <div v-if="searchActive" class="log-match-list" ref="matchList" :style="matchListStyle">
          <div
            v-for="line in matchLines"
            :key="line.id"
            class="log-match-row"
            :class="{ active: line.id === activeHitId }"
            @click="selectMatch(line.id)"
            v-html="line.html"
          ></div>
          <div v-if="!matchLines.length" class="log-match-empty muted small">No matches.</div>
        </div>
      </div>
    </div>
  `,
};
