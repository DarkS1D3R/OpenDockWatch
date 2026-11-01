import { apiGetWebhookConfig, apiSaveWebhookConfig, apiClearWebhookConfig, apiTestWebhook } from '../api.js';
import { withStatus } from '../lib/settingsSection.js';
import SettingsWebhookRoutes from './SettingsWebhookRoutes.js';

// The Settings panel's Webhook section (Settings > Alerts) - split out of the former single SettingsPanel.js so each
// section owns its own data instead of one file juggling four prefixed copies of the same shape.
export default {
  name: 'SettingsWebhook',
  components: { SettingsWebhookRoutes },
  data() {
    return {
      url: '',
      format: '',
      notifyRecovery: false,
      mode: 'all',
      repeatMinutes: 0,
      routeCount: 0,
      overridden: false,
      saving: false,
      testing: false,
      error: null,
      status: null,
    };
  },
  async mounted() {
    try {
      this.apply(await apiGetWebhookConfig());
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    apply(config) {
      this.url = config.url;
      this.format = config.format;
      this.notifyRecovery = config.notifyRecovery;
      this.mode = config.mode;
      this.repeatMinutes = config.repeatMinutes;
      this.overridden = config.overridden;
    },
    save() {
      return withStatus(this, 'saving', async () => {
        this.apply(
          await apiSaveWebhookConfig({
            url: this.url,
            format: this.format,
            notifyRecovery: this.notifyRecovery,
            mode: this.mode,
            repeatMinutes: Number(this.repeatMinutes) || 0,
          })
        );
        this.status = 'Saved.';
      });
    },
    clear() {
      return withStatus(this, 'saving', async () => {
        this.apply(await apiClearWebhookConfig());
        this.status = 'Cleared - using the .env default.';
      });
    },
    test() {
      return withStatus(this, 'testing', async () => {
        await apiTestWebhook();
        this.status = 'Test alert sent.';
      });
    },
  },
  template: `
    <div>
      <p class="muted small">
        The main webhook (ALERT_WEBHOOK_URL), for every host. Supports
        <code>discord://</code>, <code>ntfy://</code>, <code>gotify://</code> / <code>gotifys://</code>, or any
        <code>http(s)://</code> URL (auto-detected for Slack, generic JSON otherwise).
      </p>
      <label class="modal-field">
        Webhook URL
        <input type="text" v-model="url" placeholder="discord://webhook_id/webhook_token" />
      </label>
      <label class="modal-field">
        Format override
        <select v-model="format">
          <option value="">Auto</option>
          <option value="slack">Force Slack {text} shape</option>
        </select>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" v-model="notifyRecovery" /> Send a resolved message when the problem clears
      </label>
      <p class="muted small">
        For a host coming back, CPU/memory/disk back under threshold, and a health check passing
        again. Crashes and OOM kills are one-off events and have no resolved message.
      </p>
      <label class="modal-field">
        Remind every (minutes, 0 = off)
        <input type="number" v-model.number="repeatMinutes" min="0" max="1440" step="1" />
      </label>
      <p class="muted small">
        Sends the alert again at this interval while the problem is still there and nobody has
        acknowledged it - a host still down, a container still unhealthy, a threshold still breached.
        Goes to the main webhook and every route that got the alert. Acknowledging it in the Activity
        tab stops the reminders.
      </p>
      <label v-if="routeCount || mode !== 'all'" class="modal-field">
        Main webhook receives
        <select v-model="mode">
          <option value="all">Every alert</option>
          <option value="unmatched">Only alerts no route below matched</option>
        </select>
      </label>
      <p v-if="overridden" class="muted small">Overriding the .env default.</p>
      <p v-else class="muted small">Using the .env default (if any) — no override saved yet.</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="status" class="muted small" role="status">{{ status }}</p>
      <div class="modal-actions">
        <button :disabled="saving" @click="save">Save</button>
        <button :disabled="saving || !overridden" @click="clear">Clear override</button>
        <button :disabled="testing" @click="test">Send test alert</button>
      </div>
      <hr />
      <settings-webhook-routes @count="routeCount = $event"></settings-webhook-routes>
    </div>
  `,
};
