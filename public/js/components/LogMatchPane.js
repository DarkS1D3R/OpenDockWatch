import { clampPaneHeight, dragHeight } from '../lib/logPane.js';

// The strip's own floor and keyboard step - its policy, so it lives here. The log body's floor
// stays in LogViewer, which is the only thing that can measure the body: see maxHeightFor.
const MATCH_MIN_PX = 60;
const MATCH_KEY_STEP_PX = 24;

// The filtered-results strip under the log body: every matching line, click one to jump to it in
// context. Single-pane only (LogViewer decides - a quarter-width pane in the 4-up grid has no
// vertical room to give up). Owns its drag-resize entirely; the arithmetic is in lib/logPane.js.
export default {
  name: 'LogMatchPane',
  props: {
    lines: { type: Array, default: () => [] },
    activeId: { type: [Number, String], default: null },
    // Whether a filter is actually in force. False renders the prompt in the header and no list at
    // all - the strip stays visible so the toggle it belongs to doesn't appear to do nothing.
    searchActive: { type: Boolean, default: false },
    // Dragged height, owned by LogViewer as a v-model rather than by this component: the list sits
    // behind two v-ifs (this pane's toggle, then searchActive) and would otherwise lose the height
    // the moment the strip is hidden or the filter is cleared.
    height: { type: Number, default: null },
    // Returns how tall the strip may be given what it currently occupies. A function, not a number,
    // because offsetHeight is not reactive and only the parent can measure the sibling log body -
    // so the cap has to be read at the moment of the drag rather than passed at render time.
    maxHeightFor: { type: Function, required: true },
  },
  emits: ['select', 'close', 'update:height'],
  data() {
    return { resizing: false };
  },
  computed: {
    listStyle() {
      return this.height ? { height: this.height + 'px' } : null;
    },
  },
  watch: {
    // Keeps the strip's own highlight on screen while ▲/▼ (or Enter) walk the hit list in the
    // parent - the log body scrolls itself, and the two move together. Watching the prop rather
    // than being called by the parent keeps the parent out of this component's DOM.
    activeId() {
      this.$nextTick(() => this.scrollActiveIntoView());
    },
  },
  beforeUnmount() {
    this.endResize();
  },
  methods: {
    maxHeight() {
      const list = this.$refs.list;
      return this.maxHeightFor(list ? list.offsetHeight : MATCH_MIN_PX);
    },
    setHeight(px) {
      this.$emit('update:height', clampPaneHeight(px, { minHeight: MATCH_MIN_PX, maxHeight: this.maxHeight() }));
    },
    // Listeners go on window, not the handle: a fast drag outruns the element under the cursor, and
    // the pointer routinely ends up over the log body or outside the panel entirely.
    startResize(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      // The header doubles as the drag handle, so the ✕ inside it has to keep working as a button -
      // without this, pressing it starts a zero-distance drag and preventDefault eats the click.
      if (ev.target.closest('button')) return;
      const list = this.$refs.list;
      if (!list) return;
      ev.preventDefault();
      const startY = ev.clientY;
      const startHeight = list.offsetHeight;
      const maxHeight = this.maxHeight();
      this.resizing = true;
      this._drag = {
        move: (e) => {
          this.$emit('update:height', dragHeight({ startHeight, startY, clientY: e.clientY, minHeight: MATCH_MIN_PX, maxHeight }));
        },
        up: () => this.endResize(),
      };
      window.addEventListener('pointermove', this._drag.move);
      window.addEventListener('pointerup', this._drag.up);
      window.addEventListener('pointercancel', this._drag.up);
    },
    endResize() {
      if (!this._drag) return;
      window.removeEventListener('pointermove', this._drag.move);
      window.removeEventListener('pointerup', this._drag.up);
      window.removeEventListener('pointercancel', this._drag.up);
      this._drag = null;
      this.resizing = false;
    },
    // The handle is a focusable separator, so the strip resizes without a pointer at all.
    onResizeKey(ev) {
      const dir = ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowDown' ? -1 : 0;
      if (!dir) return;
      ev.preventDefault();
      const list = this.$refs.list;
      this.setHeight((list ? list.offsetHeight : MATCH_MIN_PX) + dir * MATCH_KEY_STEP_PX);
    },
    // Scrolls within the strip only (nearest, not center) so it never yanks the page.
    scrollActiveIntoView() {
      const list = this.$refs.list;
      if (!list || this.activeId == null) return;
      const idx = this.lines.findIndex((l) => l.id === this.activeId);
      const row = idx === -1 ? null : list.children[idx];
      if (row) row.scrollIntoView({ block: 'nearest' });
    },
  },
  template: `
    <div class="log-match-pane" :class="{ resizing }">
      <div
        class="log-match-pane-header"
        tabindex="0"
        aria-label="Match list header - drag, or use the arrow keys, to resize"
        title="Drag to resize"
        @pointerdown="startResize"
        @keydown="onResizeKey"
      >
        <span class="muted small" v-if="searchActive">{{ lines.length }} matching {{ lines.length === 1 ? 'line' : 'lines' }}</span>
        <span class="muted small" v-else>Type a filter above to list matching lines here.</span>
        <button class="small-btn log-match-close" @click="$emit('close')" title="Hide the match list">✕</button>
      </div>
      <div v-if="searchActive" class="log-match-list" ref="list" :style="listStyle">
        <div
          v-for="line in lines"
          :key="line.id"
          class="log-match-row"
          :class="{ active: line.id === activeId }"
          @click="$emit('select', line.id)"
          v-html="line.html"
        ></div>
        <div v-if="!lines.length" class="log-match-empty muted small">No matches.</div>
      </div>
    </div>
  `,
};
