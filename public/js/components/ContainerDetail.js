import { PREVIEW_TAIL } from '../constants.js';
import { healthColor, healthLabel, formatRatePair } from '../format.js';
import { logsUrl, apiGetContainerInspect, apiGetContainerTop } from '../api.js';
import { createLogStream } from '../lib/logStream.js';
import { decorateLines } from '../lib/logLines.js';
import { cpuLimitLabel, memoryLimitLabel, pidsLimitLabel } from '../lib/resourceLimits.js';

// The right-hand detail panel for one container: status/stats, `docker inspect` details,
// start/stop/restart, and the log preview. Stays mounted across container switches; the
// `container.id` watcher (not the whole prop, which changes reference every poll) resets it.
export default {
  name: 'ContainerDetail',
  props: {
    container: { type: Object, required: true },
    stats: { type: Object, default: () => ({}) },
    hostId: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    actionInFlight: { type: Object, default: () => ({}) },
  },
  emits: ['close', 'action', 'open-log-viewer'],
  data() {
    return {
      containerInspect: null,
      // The process list: admin-only, fetched when its section is opened (not polled - a snapshot
      // you refresh by hand is what `top` is for), and refetched when the container changes under it.
      topOpen: false,
      top: null,
      topError: null,
      loadingTop: false,
      previewLines: [],
      atBottom: true,
      loading: false,
      // See LogViewer's own `suspended` - set by the stream when it releases its connection while
      // the tab is backgrounded, so a stalled preview is labelled rather than silently stale.
      suspended: false,
    };
  },
  computed: {
    stat() {
      return this.stats[this.container.id] || {};
    },
    limits() {
      return this.containerInspect ? this.containerInspect.limits : null;
    },
    cpuLimit() {
      return cpuLimitLabel(this.limits);
    },
    memoryLimit() {
      return memoryLimitLabel(this.limits);
    },
    pidsLimit() {
      return pidsLimitLabel(this.limits);
    },
    // `docker top` only works on a running container, so the section is not offered otherwise.
    canShowTop() {
      return this.isAdmin && this.container.state === 'running';
    },
  },
  watch: {
    'container.id': {
      immediate: true,
      handler(newId) {
        this.closeStream();
        this.previewLines = [];
        this.loading = false;
        this.suspended = false;
        this.containerInspect = null;
        this.top = null;
        this.topError = null;
        if (newId) {
          this.openStream(newId);
          this.fetchInspect(newId);
          if (this.topOpen && this.canShowTop) this.fetchTop(newId);
        }
      },
    },
  },
  created() {
    this._stream = null;
  },
  beforeUnmount() {
    this.closeStream();
  },
  methods: {
    async fetchInspect(id) {
      try {
        const inspect = await apiGetContainerInspect(this.hostId, id);
        // The user may have switched to a different container (or closed the panel) before this
        // resolved - only apply it if it's still the one being looked at.
        if (this.container.id === id) this.containerInspect = inspect;
      } catch {
        /* inspect details are best-effort */
      }
    },
    onTopToggle(event) {
      this.topOpen = event.target.open;
      if (this.topOpen) this.fetchTop(this.container.id);
    },
    async fetchTop(id) {
      this.loadingTop = true;
      this.topError = null;
      try {
        const top = await apiGetContainerTop(this.hostId, id);
        if (this.container.id === id) this.top = top;
      } catch (err) {
        if (this.container.id === id) {
          this.top = null;
          this.topError = err.message;
        }
      } finally {
        if (this.container.id === id) this.loadingTop = false;
      }
    },
    openStream(id) {
      this.atBottom = true;
      this._stream = createLogStream({
        url: logsUrl(this.hostId, id, PREVIEW_TAIL),
        onFlush: (lines) => this.appendLines(lines),
        onLoadingChange: (loading) => {
          this.loading = loading;
        },
        // Same as LogViewer: the stream gives its connection back while the tab is backgrounded
        // and reconnects from the tail, so the preview has to be cleared to match.
        onReset: () => {
          this.previewLines = [];
          this.atBottom = true;
        },
        onSuspendChange: (suspended) => {
          this.suspended = suspended;
        },
      });
      this._stream.start();
    },
    closeStream() {
      if (this._stream) {
        this._stream.stop();
        this._stream = null;
      }
    },
    appendLines(lines) {
      for (const line of decorateLines(lines)) this.previewLines.push(line);
      // PREVIEW_TAIL, not MAX_LOG_LINES: this pane opens with a 100-line tail and is a preview -
      // letting it grow to 3000 meant it quietly became as expensive to render as the full viewer,
      // for lines nobody can usefully read in a 520px-wide panel. The full viewer is one click away.
      if (this.previewLines.length > PREVIEW_TAIL) {
        this.previewLines.splice(0, this.previewLines.length - PREVIEW_TAIL);
      }
      if (this.atBottom) {
        this.$nextTick(() => {
          const el = this.$refs.previewLogView;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    },
    onScroll() {
      const el = this.$refs.previewLogView;
      if (el) this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
    scrollToBottom() {
      this.atBottom = true;
      const el = this.$refs.previewLogView;
      if (el) el.scrollTop = el.scrollHeight;
    },
    fmtRatePair(a, b) {
      return formatRatePair(a, b);
    },
    fmtCreated(iso) {
      return iso ? new Date(iso).toLocaleString() : '—';
    },
    fmtRestartPolicy(inspect) {
      if (!inspect || !inspect.restartPolicy) return '—';
      const labels = { no: 'No', always: 'Always', 'unless-stopped': 'Unless stopped', 'on-failure': 'On failure' };
      const label = labels[inspect.restartPolicy] || inspect.restartPolicy;
      return inspect.restartPolicy === 'on-failure' && inspect.restartMaxRetries ? `${label} (max ${inspect.restartMaxRetries})` : label;
    },
    healthDotColor(health) {
      return healthColor(health);
    },
    healthTitle(health) {
      return healthLabel(health);
    },
    stateClass() {
      if (this.container.state === 'running') return 'state-running';
      if (this.container.state === 'created') return 'state-created';
      return 'state-stopped';
    },
  },
  template: `
    <aside class="detail-panel">
      <div class="detail-header">
        <div>
          <strong>{{ container.name }}</strong>
          <div class="muted small">{{ container.composeProject || 'ungrouped' }} / {{ container.composeService || '—' }}</div>
        </div>
        <button @click="$emit('close')">✕</button>
      </div>
      <div class="detail-body">
        <div class="detail-row"><span class="label">Status</span><span :class="stateClass()">{{ container.status }}</span></div>
        <div class="detail-row" v-if="container.health"><span class="label">Health</span><span><span class="health-dot" :style="{ background: healthDotColor(container.health) }"></span> {{ healthTitle(container.health) }}</span></div>
        <div class="detail-row" v-if="container.restartCount1h"><span class="label">Restarts (1h)</span><span>{{ container.restartCount1h }}</span></div>
        <div class="detail-row"><span class="label">Image</span><span>{{ container.image }}</span></div>
        <div class="detail-row">
          <span class="label">CPU</span>
          <span>{{ stat.cpuPerc || '—' }} <span v-if="cpuLimit" class="muted small" title="The CPU limit set on this container - 100% is one full core">· limit {{ cpuLimit }}</span></span>
        </div>
        <div class="detail-row">
          <span class="label">Memory</span>
          <span>
            {{ stat.memUsage || '—' }}
            <span v-if="memoryLimit === 'no limit'" class="muted small" title="No memory limit is set, so the second figure is the host's memory, not a cap on this container">· no limit</span>
          </span>
        </div>
        <div class="detail-row" v-if="pidsLimit"><span class="label">PID limit</span><span>{{ pidsLimit }}</span></div>
        <div class="detail-row"><span class="label">Net I/O</span><span>{{ fmtRatePair(stat.netRxRate, stat.netTxRate) }}</span></div>
        <div class="detail-row"><span class="label">Block I/O</span><span>{{ fmtRatePair(stat.blockReadRate, stat.blockWriteRate) }}</span></div>
        <div class="detail-row"><span class="label">Ports</span><span>{{ container.ports || '—' }}</span></div>
        <div class="detail-row"><span class="label">Networks</span><span>{{ container.networks.join(', ') || '—' }}</span></div>

        <template v-if="containerInspect">
          <div class="detail-row"><span class="label">Created</span><span>{{ fmtCreated(containerInspect.createdAt) }}</span></div>
          <div class="detail-row"><span class="label">Restart Policy</span><span>{{ fmtRestartPolicy(containerInspect) }}</span></div>

          <details v-if="canShowTop" class="inspect-section" :open="topOpen" @toggle="onTopToggle">
            <summary>Processes<template v-if="top"> ({{ top.rows.length }})</template></summary>
            <div class="inspect-list">
              <button class="small-btn" :disabled="loadingTop" @click.prevent="fetchTop(container.id)">{{ loadingTop ? 'Loading…' : 'Refresh' }}</button>
              <div v-if="topError" class="error small">{{ topError }}</div>
              <div v-else-if="top && !top.rows.length" class="muted small">No processes.</div>
              <div v-else-if="top" class="proc-table-wrap">
                <table class="proc-table">
                  <thead><tr><th v-for="col in top.columns" :key="col">{{ col }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(row, i) in top.rows" :key="i"><td v-for="(cell, j) in row" :key="j" class="mono">{{ cell }}</td></tr>
                  </tbody>
                </table>
                <div v-if="top.truncated" class="muted small">Showing the first {{ top.rows.length }} processes.</div>
              </div>
            </div>
          </details>

          <details class="inspect-section">
            <summary>Environment ({{ containerInspect.env.length }})</summary>
            <div class="inspect-list">
              <div v-if="containerInspect.envMasked" class="muted small">Values hidden — environment values are visible to admin accounts only.</div>
              <div v-for="(line, i) in containerInspect.env" :key="i" class="inspect-line mono">{{ line }}</div>
              <div v-if="!containerInspect.env.length" class="muted small">None</div>
            </div>
          </details>

          <details class="inspect-section">
            <summary>Mounts ({{ containerInspect.mounts.length }})</summary>
            <div class="inspect-list">
              <div v-for="(m, i) in containerInspect.mounts" :key="i" class="inspect-line">
                <span class="mono">{{ m.source || m.type }}</span> → <span class="mono">{{ m.destination }}</span>
                <span class="muted small">({{ m.rw ? 'rw' : 'ro' }})</span>
              </div>
              <div v-if="!containerInspect.mounts.length" class="muted small">None</div>
            </div>
          </details>

          <details class="inspect-section">
            <summary>Labels ({{ Object.keys(containerInspect.labels).length }})</summary>
            <div class="inspect-list">
              <div v-for="(v, k) in containerInspect.labels" :key="k" class="inspect-line mono">{{ k }}={{ v }}</div>
              <div v-if="!Object.keys(containerInspect.labels).length" class="muted small">None</div>
            </div>
          </details>
        </template>

        <div class="detail-actions" v-if="isAdmin">
          <button :disabled="!!actionInFlight[container.id]" @click="$emit('action', container, 'start')">Start</button>
          <button :disabled="!!actionInFlight[container.id]" @click="$emit('action', container, 'stop')">Stop</button>
          <button :disabled="!!actionInFlight[container.id]" @click="$emit('action', container, 'restart')">Restart</button>
        </div>

        <div class="log-section-header">
          <h3>Logs</h3>
          <span v-if="suspended" class="log-paused-badge" title="Paused while this tab was in the background - it resumes from the latest lines when you come back">paused</span>
          <button class="small-btn" @click="$emit('open-log-viewer')" title="Open larger log view with filtering">Log Viewer ⤢</button>
        </div>
        <div class="log-view-wrap">
          <div v-if="loading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
          <pre class="log-view detail-log" ref="previewLogView" @scroll="onScroll"><div v-for="line in previewLines" :key="line.id" class="log-line" v-html="line.baseHtml"></div></pre>
          <button v-show="!atBottom" class="scroll-bottom-btn" @click="scrollToBottom" title="Scroll to bottom">&#8595; Bottom</button>
        </div>
      </div>
    </aside>
  `,
};
