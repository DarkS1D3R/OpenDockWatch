import {
  apiGetWebhookRoutes,
  apiAddWebhookRoute,
  apiUpdateWebhookRoute,
  apiDeleteWebhookRoute,
  apiTestWebhookRoute,
  apiGetHostsConfig,
} from '../api.js';
import { withStatus } from '../lib/settingsSection.js';
import { ALERT_RULES } from '../constants.js';
import { maskWebhookUrl, routeSummary, blankRoute, routeDraft, routePayload } from '../lib/webhookRoutes.js';
import ConfirmButton from './ConfirmButton.js';

// The routes half of Settings > Webhook: extra destinations, each taking the alerts its host, rules
// and severity filters match. One form serves add and edit (editingId null means add). Emits `count`
// so the parent can offer "main webhook gets only unmatched alerts" once there is a route to match.
export default {
  name: 'SettingsWebhookRoutes',
  components: { ConfirmButton },
  emits: ['count'],
  data() {
    return {
      routes: [],
      hosts: [],
      draft: blankRoute(),
      editingId: null,
      saving: false,
      testingId: null,
      error: null,
      status: null,
      alertRules: ALERT_RULES,
    };
  },
  async mounted() {
    try {
      [this.routes, this.hosts] = await Promise.all([apiGetWebhookRoutes(), apiGetHostsConfig()]);
      this.$emit('count', this.routes.length);
    } catch (err) {
      this.error = err.message;
    }
  },
  computed: {
    formTitle() {
      return this.editingId === null ? 'Add a route' : 'Edit route';
    },
  },
  methods: {
    maskWebhookUrl,
    summary(route) {
      return routeSummary(
        route,
        this.hosts.map((h) => ({ id: h.id, name: h.name || h.id }))
      );
    },
    setRoutes(routes) {
      this.routes = routes;
      this.$emit('count', routes.length);
    },
    startEdit(route) {
      this.editingId = route.id;
      this.draft = routeDraft(route);
      this.error = null;
      this.status = null;
    },
    cancelEdit() {
      this.editingId = null;
      this.draft = blankRoute();
    },
    submit() {
      return withStatus(this, 'saving', async () => {
        const adding = this.editingId === null;
        const body = routePayload(this.draft);
        this.setRoutes(adding ? await apiAddWebhookRoute(body) : await apiUpdateWebhookRoute(this.editingId, body));
        this.cancelEdit();
        this.status = adding ? 'Route added.' : 'Route updated.';
      });
    },
    remove(id) {
      return withStatus(this, 'saving', async () => {
        this.setRoutes(await apiDeleteWebhookRoute(id));
        if (this.editingId === id) this.cancelEdit();
        this.status = 'Route removed.';
      });
    },
    async test(route) {
      this.testingId = route.id;
      this.error = null;
      this.status = null;
      try {
        await apiTestWebhookRoute(route.id);
        this.status = `Test alert sent to ${route.name}.`;
      } catch (err) {
        this.error = `${route.name}: ${err.message}`;
      } finally {
        this.testingId = null;
      }
    },
  },
  template: `
    <div>
      <h4 class="settings-subheading">Routes</h4>
      <p class="muted small">
        Extra destinations. Every enabled route whose filters match gets the alert - not just the
        first. Leave the rules unticked to take every rule. A route with a delay is an escalation: it
        only hears about alerts nobody acknowledged in time.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="status" class="muted small" role="status">{{ status }}</p>
      <p v-if="!routes.length" class="muted small">No routes - every alert goes to the main webhook only.</p>

      <div v-for="r in routes" :key="r.id" class="host-row" :class="{ 'route-disabled': !r.enabled }">
        <div class="host-row-main">
          <strong>{{ r.name }}</strong>
          <span class="muted small">{{ maskWebhookUrl(r.url) }}</span>
          <span v-if="!r.enabled" class="muted small">(off)</span>
        </div>
        <p class="muted small">{{ summary(r) }}{{ r.notifyRecovery ? ' · sends resolved messages' : '' }}</p>
        <div class="modal-actions">
          <button class="small-btn" :disabled="saving" @click="startEdit(r)">Edit</button>
          <button class="small-btn" :disabled="testingId === r.id" @click="test(r)">Send test alert</button>
          <confirm-button label="Remove" hint="Deletes this route - its alerts stop going to this destination" :disabled="saving" @confirm="remove(r.id)"></confirm-button>
        </div>
      </div>

      <hr />
      <h4 class="settings-subheading">{{ formTitle }}</h4>
      <label class="modal-field">
        Name
        <input type="text" v-model="draft.name" maxlength="60" placeholder="Ops phone" />
      </label>
      <label class="modal-field">
        URL
        <input type="text" v-model="draft.url" placeholder="ntfy://ntfy.sh/your-topic" />
      </label>
      <label class="modal-field">
        Format override
        <select v-model="draft.format">
          <option value="">Auto</option>
          <option value="slack">Force Slack {text} shape</option>
        </select>
      </label>
      <label class="modal-field">
        Host
        <select v-model="draft.hostId">
          <option value="">Any host</option>
          <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name || h.id }}</option>
        </select>
      </label>
      <label class="modal-field">
        Severity
        <select v-model="draft.minSeverity">
          <option value="warning">Warning and critical</option>
          <option value="critical">Critical only</option>
        </select>
      </label>
      <div class="modal-field">
        Rules (none ticked = every rule)
        <div class="checkbox-grid">
          <label v-for="ar in alertRules" :key="ar.value" class="checkbox-label">
            <input type="checkbox" v-model="draft.rules" :value="ar.value" /> {{ ar.label }}
          </label>
        </div>
      </div>
      <label class="modal-field">
        Only after unacknowledged for (minutes, 0 = at once)
        <input type="number" v-model.number="draft.delayMinutes" min="0" max="1440" step="1" />
      </label>
      <p class="muted small">
        For escalation: with a delay, this route gets an alert only if nobody has acknowledged it by
        then, and it does not count as having taken the alert away from the main webhook.
      </p>
      <label class="checkbox-label">
        <input type="checkbox" v-model="draft.notifyRecovery" /> Send a resolved message when the problem clears
      </label>
      <label class="checkbox-label">
        <input type="checkbox" v-model="draft.enabled" /> Enabled
      </label>
      <div class="modal-actions">
        <button :disabled="saving || !draft.name.trim() || !draft.url" @click="submit">{{ editingId === null ? 'Add route' : 'Save route' }}</button>
        <button v-if="editingId !== null" :disabled="saving" @click="cancelEdit">Cancel</button>
      </div>
    </div>
  `,
};
