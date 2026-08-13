import { apiGetWebhookConfig, apiSaveWebhookConfig, apiClearWebhookConfig, apiTestWebhook } from '../api.js';
import { withStatus } from '../lib/settingsSection.js';

// The Settings panel's Webhook tab - split out of the former single SettingsPanel.js so each
// section owns its own data instead of one file juggling four prefixed copies of the same shape.
export default {
  name: 'SettingsWebhook',
  data() {
    return {
      url: '',
      format: '',
      overridden: false,
      saving: false,
      testing: false,
      error: null,
      status: null,
    };
  },
  async mounted() {
    try {
      const config = await apiGetWebhookConfig();
      this.url = config.url;
      this.format = config.format;
      this.overridden = config.overridden;
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    save() {
      return withStatus(this, 'saving', async () => {
        const config = await apiSaveWebhookConfig(this.url, this.format);
        this.overridden = config.overridden;
        this.status = 'Saved.';
      });
    },
    clear() {
      return withStatus(this, 'saving', async () => {
        const config = await apiClearWebhookConfig();
        this.url = config.url;
        this.format = config.format;
        this.overridden = config.overridden;
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
        Sets ALERT_WEBHOOK_URL for all hosts. Supports
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
      <p v-if="overridden" class="muted small">Overriding the .env default.</p>
      <p v-else class="muted small">Using the .env default (if any) — no override saved yet.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="status" class="muted small">{{ status }}</p>
      <div class="modal-actions">
        <button :disabled="saving" @click="save">Save</button>
        <button :disabled="saving || !overridden" @click="clear">Clear override</button>
        <button :disabled="testing" @click="test">Send test alert</button>
      </div>
    </div>
  `,
};
