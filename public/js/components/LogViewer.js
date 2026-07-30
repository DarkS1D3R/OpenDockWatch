import { MAX_LOG_LINES } from '../constants.js';
import { detectLogLevel, highlightLine, stripAnsi, parseLineTsMs } from '../format.js';
import { logsUrl, downloadLogsUrl } from '../api.js';
import { createLogStream } from '../lib/logStream.js';
import { closestIndexByTs } from '../lib/logSync.js';

// The full-size log panel: level/filter/tail controls, download, fullscreen, and the streamed
// log body. Mounted fresh by the root each time "Logs" is opened for a container (v-if, not
// v-show) - its own mounted()/beforeUnmount() start and stop the stream, so the root no longer
// needs to orchestrate that. `fullscreen` is the one bit of state the root still needs to know
// about directly (v-model) - it hides the host card and other panels, which is the root's layout
// to control, not this component's.
//
// `embedded` is the other mode this renders in: the Logs tab (LogsView) mounts one of these per
// selected container inside its own right-hand pane instead of the root's overlay slot. There's
// no "fullscreen" in that context (the pane already fills the tab), so that button is hidden and
// the panel fills its parent's height via CSS instead of the fullscreen vh-calc. `closable` is
// independent of `embedded` - LogsView only sets it once 2+ panes are open side by side, so a
// single embedded pane still has no close button (picking a different row is the equivalent, same
// as before multi-pane existed).
//
// `scroll-sync` is the other half of LogsView's multi-pane sync: emitted with { containerId,
// tsMs } - this pane's own id and the epoch-ms timestamp of whichever line is now at the top of
// the viewport - whenever the *user* scrolls (not when `scrollToTimestamp` moves this pane in
// response to another one's sync event - `_programmatic` guards that). LogsView listens on every
// open pane and calls `scrollToTimestamp` on every *other* one - not the sender itself, which
// would otherwise re-snap its own scrollTop to the nearest line boundary every frame and fight a
// continuous scroll gesture (most visible on whichever pane has the most lines to scroll through).
export default {
  name: 'LogViewer',
  props: {
    hostId: { type: String, required: true },
    containerId: { type: String, required: true },
    containerName: { type: String, default: '' },
    withDetail: { type: Boolean, default: false },
    fullscreen: { type: Boolean, default: false },
    embedded: { type: Boolean, default: false },
    closable: { type: Boolean, default: false },
  },
  emits: ['close', 'update:fullscreen', 'scroll-sync'],
  data() {
    return {
      tail: 200,
      filter: '',
      regexMode: false,
      levels: { error: true, warn: true, info: true, debug: true },
      lines: [],
      atBottom: true,
      loading: false,
      showTimestamps: true,
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
    filteredLines() {
      const filterText = this.filter.trim();
      const filterLower = filterText.toLowerCase();
      const regexMode = this.regexMode;
      const testRegex = this.testRegex;
      return this.lines
        .filter((line) => {
          const level = detectLogLevel(stripAnsi(line.text));
          if (level && !this.levels[level]) return false;
          if (!filterText) return true;
          if (regexMode) return testRegex ? testRegex.test(line.text) : true;
          return line.text.toLowerCase().includes(filterLower);
        })
        .map((line) => ({
          id: line.id,
          html: highlightLine(line.text, filterText, regexMode && !!testRegex),
          tsMs: parseLineTsMs(line.text),
        }));
    },
  },
  created() {
    this._stream = null;
    this._programmatic = false;
    this._syncRaf = null;
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
  },
  beforeUnmount() {
    if (this._stream) {
      this._stream.stop();
      this._stream = null;
    }
    if (this._syncRaf) cancelAnimationFrame(this._syncRaf);
  },
  methods: {
    startStream() {
      if (this._stream) this._stream.stop();
      this.lines = [];
      this.atBottom = true;
      this._stream = createLogStream({
        url: logsUrl(this.hostId, this.containerId, this.tail),
        onFlush: (lines) => this.appendLines(lines),
        onLoadingChange: (loading) => {
          this.loading = loading;
        },
      });
      this._stream.start();
    },
    appendLines(lines) {
      for (const line of lines) this.lines.push(line);
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
      // A sync-driven scroll (scrollToTimestamp, called from LogsView in response to a *different*
      // pane's user scroll) shouldn't itself broadcast - every pane doing that would ping-pong
      // forever. rAF-throttled the same way logStream.js throttles its own flush, since a real drag
      // scroll fires this dozens of times a frame otherwise.
      if (this._programmatic || this._syncRaf) return;
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
    scrollToBottom() {
      this.atBottom = true;
      const el = this.$refs.logView;
      if (el) el.scrollTop = el.scrollHeight;
    },
    toggleLevel(level) {
      this.levels = { ...this.levels, [level]: !this.levels[level] };
    },
    toggleFullscreen() {
      this.$emit('update:fullscreen', !this.fullscreen);
    },
  },
  template: `
    <div class="log-panel" :class="{ 'with-detail': withDetail && !fullscreen, fullscreen: fullscreen, embedded: embedded }">
      <div class="log-panel-header">
        <strong>{{ containerName }}</strong>
        <div class="log-panel-controls">
          <div class="log-level-toggle">
            <button :class="{active: levels.error}" class="level-error" @click="toggleLevel('error')">Error</button>
            <button :class="{active: levels.warn}" class="level-warn" @click="toggleLevel('warn')">Warn</button>
            <button :class="{active: levels.info}" class="level-info" @click="toggleLevel('info')">Info</button>
            <button :class="{active: levels.debug}" class="level-debug" @click="toggleLevel('debug')">Debug</button>
          </div>
          <div class="log-filter-group">
            <div class="log-filter-input-wrap">
              <input
                type="text"
                v-model="filter"
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
            <span v-else-if="filter" class="filter-count-text">{{ filteredLines.length }} / {{ lines.length }}</span>
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
          <button v-if="!embedded" @click="$emit('close')">Close</button>
          <button v-else-if="closable" class="small-btn log-pane-close-btn" @click="$emit('close')" title="Close this pane">
            ✕
          </button>
        </div>
      </div>
      <div class="log-view-wrap">
        <div v-if="loading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
        <pre class="log-view log-viewer-pane" :class="{ 'hide-ts': !showTimestamps }" ref="logView" @scroll="onScroll"><div v-for="line in filteredLines" :key="line.id" v-html="line.html"></div></pre>
        <button v-show="!atBottom" class="scroll-bottom-btn" @click="scrollToBottom" title="Scroll to bottom">&#8595; Bottom</button>
      </div>
    </div>
  `,
};
