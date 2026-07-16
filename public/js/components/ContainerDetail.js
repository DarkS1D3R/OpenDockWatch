import { MAX_LOG_LINES, PREVIEW_TAIL } from '../constants.js';
import { healthColor, healthLabel, formatRatePair, highlightLine } from '../format.js';
import { logsUrl, apiGetContainerInspect } from '../api.js';
import { createLogStream } from '../lib/logStream.js';

// The right-hand detail panel for one container: status/stats rows, `docker inspect` details
// (env/mounts/labels), start/stop/restart, and the small log preview. Mounted once per selection
// and stays mounted while switching between containers (the root's v-if only turns on/off for
// "no container selected" vs "some container selected") - the `container.id` watcher below is
// what notices a same-mount switch from one container to another and resets accordingly, since a
// plain watch on the `container` prop object itself would refire every 5s poll (the root replaces
// its whole `containers` array each poll, so the object reference changes even when the id
// doesn't - watching the id specifically avoids restarting the stream/inspect fetch on every poll).
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
      previewLines: [],
      atBottom: true,
      loading: false,
    };
  },
  computed: {
    stat() {
      return this.stats[this.container.id] || {};
    },
  },
  watch: {
    'container.id': {
      immediate: true,
      handler(newId) {
        this.closeStream();
        this.previewLines = [];
        this.loading = false;
        this.containerInspect = null;
        if (newId) {
          this.openStream(newId);
          this.fetchInspect(newId);
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
    openStream(id) {
      this.atBottom = true;
      this._stream = createLogStream({
        url: logsUrl(this.hostId, id, PREVIEW_TAIL),
        onFlush: (lines) => this.appendLines(lines),
        onLoadingChange: (loading) => {
          this.loading = loading;
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
      for (const line of lines) this.previewLines.push(line);
      if (this.previewLines.length > MAX_LOG_LINES) {
        this.previewLines.splice(0, this.previewLines.length - MAX_LOG_LINES);
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
    formatPreviewLine(text) {
      return highlightLine(text, '', false);
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
      return this.container.state === 'running' ? 'state-running' : 'state-stopped';
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
        <div class="detail-row"><span class="label">CPU</span><span>{{ stat.cpuPerc || '—' }}</span></div>
        <div class="detail-row"><span class="label">Memory</span><span>{{ stat.memUsage || '—' }}</span></div>
        <div class="detail-row"><span class="label">Net I/O</span><span>{{ fmtRatePair(stat.netRxRate, stat.netTxRate) }}</span></div>
        <div class="detail-row"><span class="label">Block I/O</span><span>{{ fmtRatePair(stat.blockReadRate, stat.blockWriteRate) }}</span></div>
        <div class="detail-row"><span class="label">Ports</span><span>{{ container.ports || '—' }}</span></div>
        <div class="detail-row"><span class="label">Networks</span><span>{{ container.networks.join(', ') || '—' }}</span></div>

        <template v-if="containerInspect">
          <div class="detail-row"><span class="label">Created</span><span>{{ fmtCreated(containerInspect.createdAt) }}</span></div>
          <div class="detail-row"><span class="label">Restart Policy</span><span>{{ fmtRestartPolicy(containerInspect) }}</span></div>

          <details class="inspect-section">
            <summary>Environment ({{ containerInspect.env.length }})</summary>
            <div class="inspect-list">
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
          <button class="small-btn" @click="$emit('open-log-viewer')" title="Open larger log view with filtering">Log Viewer ⤢</button>
        </div>
        <div class="log-view-wrap">
          <div v-if="loading" class="log-loading-overlay"><span class="spinner"></span> Loading…</div>
          <pre class="log-view detail-log" ref="previewLogView" @scroll="onScroll"><div v-for="line in previewLines" :key="line.id" v-html="formatPreviewLine(line.text)"></div></pre>
          <button v-show="!atBottom" class="scroll-bottom-btn" @click="scrollToBottom" title="Scroll to bottom">&#8595; Bottom</button>
        </div>
      </div>
    </aside>
  `,
};
