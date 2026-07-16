import { MAX_ACTIVITY_EVENTS } from '../constants.js';
import { apiGetEvents, eventsStreamUrl } from '../api.js';

// The Activity tab: an alerts column (search + acknowledge) and an events column (search,
// backed by a live SSE stream). Mounted fresh (v-if, not v-show) each time the tab is opened -
// its own mounted()/beforeUnmount() open and close the events stream, so the root no longer
// needs to know about "entering" or "leaving" the Activity view at all. `alerts` themselves stay
// fetched by the root every poll, since the topbar badge (openAlertsCount) needs them even when
// this view isn't open - only the search/filter/scroll-tracking of them lives here.
export default {
  name: 'ActivityView',
  props: {
    hostId: { type: String, required: true },
    alerts: { type: Array, default: () => [] },
  },
  emits: ['ack', 'ack-all'],
  data() {
    return {
      alertSearch: '',
      eventSearch: '',
      events: [],
      alertsAtTop: true,
      eventsAtTop: true,
    };
  },
  computed: {
    // Acknowledge-all acts on every open alert for this host, not just the ones the current
    // search happens to match - clearing the badge should always actually clear the badge.
    hasUnacknowledged() {
      return this.alerts.some((a) => !a.acknowledged);
    },
    searchedAlerts() {
      const q = this.alertSearch.trim().toLowerCase();
      if (!q) return this.alerts;
      return this.alerts.filter(
        (a) =>
          (a.rule || '').toLowerCase().includes(q) ||
          (a.message || '').toLowerCase().includes(q) ||
          (a.containerName || '').toLowerCase().includes(q)
      );
    },
    searchedEvents() {
      const q = this.eventSearch.trim().toLowerCase();
      if (!q) return this.events;
      return this.events.filter(
        (e) => (e.containerName || e.containerId || '').toLowerCase().includes(q) || (e.action || '').toLowerCase().includes(q)
      );
    },
  },
  watch: {
    hostId() {
      this.loadEvents();
    },
  },
  created() {
    this._stream = null;
  },
  mounted() {
    this.loadEvents();
  },
  beforeUnmount() {
    this.closeStream();
  },
  methods: {
    async loadEvents() {
      if (!this.hostId) return;
      try {
        this.events = await apiGetEvents(this.hostId, { limit: 200 });
      } catch {
        /* events are best-effort */
      }
      this.openStream();
    },
    openStream() {
      this.closeStream();
      this._stream = new EventSource(eventsStreamUrl(this.hostId));
      this._stream.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          this.events.unshift(event);
          if (this.events.length > MAX_ACTIVITY_EVENTS) this.events.length = MAX_ACTIVITY_EVENTS;
        } catch {
          /* ignore malformed event */
        }
      };
    },
    closeStream() {
      if (this._stream) {
        this._stream.close();
        this._stream = null;
      }
    },
    formatEventTime(ts) {
      return new Date(ts).toLocaleTimeString();
    },
    onAlertsScroll() {
      const el = this.$refs.alertsListView;
      if (el) this.alertsAtTop = el.scrollTop < 40;
    },
    scrollAlertsToTop() {
      const el = this.$refs.alertsListView;
      if (el) el.scrollTop = 0;
      this.alertsAtTop = true;
    },
    onEventsScroll() {
      const el = this.$refs.eventsListView;
      if (el) this.eventsAtTop = el.scrollTop < 40;
    },
    scrollEventsToTop() {
      const el = this.$refs.eventsListView;
      if (el) el.scrollTop = 0;
      this.eventsAtTop = true;
    },
  },
  template: `
    <div class="activity-wrap">
      <div class="activity-column">
        <div class="log-section-header">
          <h3>Alerts</h3>
          <button v-if="hasUnacknowledged" class="small-btn" @click="$emit('ack-all')">Acknowledge all</button>
        </div>
        <input type="text" v-model="alertSearch" placeholder="Search alerts…" class="activity-search" />
        <p v-if="!searchedAlerts.length" class="muted">{{ alerts.length ? 'No matching alerts.' : 'No alerts.' }}</p>
        <div v-else class="activity-list-wrap">
          <div class="activity-list" ref="alertsListView" @scroll="onAlertsScroll">
            <div v-for="a in searchedAlerts" :key="a.id" class="alert-row" :class="'severity-' + a.severity">
              <div class="alert-row-main">
                <strong>{{ a.rule }}</strong>
                <span class="alert-time">{{ formatEventTime(a.ts) }}</span>
              </div>
              <div class="alert-message">{{ a.message }}</div>
              <button v-if="!a.acknowledged" class="small-btn" @click="$emit('ack', a)">Acknowledge</button>
              <span v-else class="ack-tick">✓ Acknowledged</span>
            </div>
          </div>
          <button v-show="!alertsAtTop" class="scroll-top-btn" @click="scrollAlertsToTop" title="Scroll to top">&#8593; Top</button>
        </div>
      </div>
      <div class="activity-column">
        <h3>Events</h3>
        <input type="text" v-model="eventSearch" placeholder="Search events…" class="activity-search" />
        <p v-if="!searchedEvents.length" class="muted">{{ events.length ? 'No matching events.' : 'No events yet.' }}</p>
        <div v-else class="activity-list-wrap">
          <div class="activity-list" ref="eventsListView" @scroll="onEventsScroll">
            <table class="containers">
              <thead><tr><th>Time</th><th>Container</th><th>Action</th></tr></thead>
              <tbody>
                <tr v-for="(e, i) in searchedEvents" :key="i">
                  <td class="muted">{{ formatEventTime(e.ts) }}</td>
                  <td>{{ e.containerName || e.containerId || '—' }}</td>
                  <td class="muted">{{ e.action }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button v-show="!eventsAtTop" class="scroll-top-btn" @click="scrollEventsToTop" title="Scroll to top">&#8593; Top</button>
        </div>
      </div>
    </div>
  `,
};
