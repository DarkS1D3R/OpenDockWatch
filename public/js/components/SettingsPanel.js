import {
  apiGetWebhookConfig,
  apiSaveWebhookConfig,
  apiClearWebhookConfig,
  apiTestWebhook,
  apiGetThresholdConfig,
  apiSaveThresholdConfig,
  apiClearThresholdConfig,
  apiGetHostsConfig,
  apiAddHost,
  apiUpdateHost,
  apiDeleteHost,
} from '../api.js';

// The Settings panel: webhook config, alert thresholds, and host management. Mounted fresh
// (v-if) each time it's opened - mounted() does the three config fetches openSettings() used to
// do directly. Emits 'hosts-changed' after add/edit/remove so the root refreshes the host
// selector dropdown, since that list lives in the root (it's used well beyond this panel).
//
// Every save/clear/add/edit/remove action follows the same saving-flag/error/status shape;
// runSection(section, savingField, fn) collapses all of them to a one-line body. The saving flag
// is a separate parameter rather than derived from `section` because "Send test alert" has its
// own independent loading flag (webhookTesting) from "Save"/"Clear override" (webhookSaving) -
// so clicking one doesn't disable the other.
export default {
  name: 'SettingsPanel',
  emits: ['close', 'hosts-changed'],
  data() {
    return {
      webhookUrl: '',
      webhookFormat: '',
      webhookOverridden: false,
      webhookSaving: false,
      webhookTesting: false,
      webhookError: null,
      webhookStatus: null,

      thresholds: { cpuThreshold: 0, memThreshold: 0, sustainMinutes: 5, diskThresholdGb: 0 },
      thresholdsOverridden: false,
      thresholdsSaving: false,
      thresholdsError: null,
      thresholdsStatus: null,

      settingsHosts: [],
      newHost: { id: '', name: '', dockerHost: '' },
      hostsSaving: false,
      hostsError: null,
      hostsStatus: null,
      editingHostId: null,
      editHostDraft: { name: '', dockerHost: '' },
    };
  },
  async mounted() {
    try {
      const config = await apiGetWebhookConfig();
      this.webhookUrl = config.url;
      this.webhookFormat = config.format;
      this.webhookOverridden = config.overridden;
    } catch (err) {
      this.webhookError = err.message;
    }
    try {
      const config = await apiGetThresholdConfig();
      this.thresholds = config;
      this.thresholdsOverridden = config.overridden;
    } catch (err) {
      this.thresholdsError = err.message;
    }
    try {
      this.settingsHosts = await apiGetHostsConfig();
    } catch (err) {
      this.hostsError = err.message;
    }
  },
  methods: {
    async runSection(section, savingField, fn) {
      this[savingField] = true;
      this[`${section}Error`] = null;
      this[`${section}Status`] = null;
      try {
        await fn();
      } catch (err) {
        this[`${section}Error`] = err.message;
      } finally {
        this[savingField] = false;
      }
    },
    saveWebhookConfig() {
      return this.runSection('webhook', 'webhookSaving', async () => {
        const config = await apiSaveWebhookConfig(this.webhookUrl, this.webhookFormat);
        this.webhookOverridden = config.overridden;
        this.webhookStatus = 'Saved.';
      });
    },
    clearWebhookConfig() {
      return this.runSection('webhook', 'webhookSaving', async () => {
        const config = await apiClearWebhookConfig();
        this.webhookUrl = config.url;
        this.webhookFormat = config.format;
        this.webhookOverridden = config.overridden;
        this.webhookStatus = 'Cleared - using the .env default.';
      });
    },
    testWebhook() {
      return this.runSection('webhook', 'webhookTesting', async () => {
        await apiTestWebhook();
        this.webhookStatus = 'Test alert sent.';
      });
    },
    saveThresholds() {
      return this.runSection('thresholds', 'thresholdsSaving', async () => {
        const config = await apiSaveThresholdConfig(this.thresholds);
        this.thresholds = config;
        this.thresholdsOverridden = config.overridden;
        this.thresholdsStatus = 'Saved.';
      });
    },
    clearThresholds() {
      return this.runSection('thresholds', 'thresholdsSaving', async () => {
        const config = await apiClearThresholdConfig();
        this.thresholds = config;
        this.thresholdsOverridden = config.overridden;
        this.thresholdsStatus = 'Cleared - using the .env default.';
      });
    },
    addHost() {
      return this.runSection('hosts', 'hostsSaving', async () => {
        this.settingsHosts = await apiAddHost(this.newHost);
        this.newHost = { id: '', name: '', dockerHost: '' };
        this.hostsStatus = 'Host added.';
        this.$emit('hosts-changed');
      });
    },
    startEditHost(host) {
      this.editingHostId = host.id;
      this.editHostDraft = { name: host.name || '', dockerHost: host.dockerHost || '' };
      this.hostsError = null;
      this.hostsStatus = null;
    },
    cancelEditHost() {
      this.editingHostId = null;
    },
    saveEditHost(id) {
      return this.runSection('hosts', 'hostsSaving', async () => {
        this.settingsHosts = await apiUpdateHost(id, this.editHostDraft);
        this.editingHostId = null;
        this.hostsStatus = 'Host updated.';
        this.$emit('hosts-changed');
      });
    },
    removeHost(id) {
      return this.runSection('hosts', 'hostsSaving', async () => {
        this.settingsHosts = await apiDeleteHost(id);
        this.hostsStatus = 'Host removed.';
        this.$emit('hosts-changed');
      });
    },
  },
  template: `
    <aside class="detail-panel">
      <div class="detail-header">
        <strong>Settings</strong>
        <button @click="$emit('close')">✕</button>
      </div>
      <div class="detail-body">
          <p class="muted small">
            Sets ALERT_WEBHOOK_URL for all hosts. Supports
            <code>discord://</code>, <code>ntfy://</code>, <code>gotify://</code> / <code>gotifys://</code>, or any
            <code>http(s)://</code> URL (auto-detected for Slack, generic JSON otherwise).
          </p>
          <label class="modal-field">
            Webhook URL
            <input type="text" v-model="webhookUrl" placeholder="discord://webhook_id/webhook_token" />
          </label>
          <label class="modal-field">
            Format override
            <select v-model="webhookFormat">
              <option value="">Auto</option>
              <option value="slack">Force Slack {text} shape</option>
            </select>
          </label>
          <p v-if="webhookOverridden" class="muted small">Overriding the .env default.</p>
          <p v-else class="muted small">Using the .env default (if any) — no override saved yet.</p>
          <p v-if="webhookError" class="error">{{ webhookError }}</p>
          <p v-if="webhookStatus" class="muted small">{{ webhookStatus }}</p>
          <div class="modal-actions">
            <button :disabled="webhookSaving" @click="saveWebhookConfig">Save</button>
            <button :disabled="webhookSaving || !webhookOverridden" @click="clearWebhookConfig">Clear override</button>
            <button :disabled="webhookTesting" @click="testWebhook">Send test alert</button>
          </div>

          <hr />

          <strong>Resource thresholds</strong>
          <p class="muted small">
            Alert when a value stays over threshold for the sustain window. Leave a threshold at 0 to disable that
            rule. CPU% is raw <code>docker stats</code> CPU (per-core cumulative, so 4 cores fully busy reads 400%).
            Mem% needs a container memory limit set to mean much. Docker disk usage is Docker's own footprint
            (images/containers/volumes/cache), not host free disk space — it's a prune reminder, not a disk-full alert.
            Skip a container entirely with the <code>opendockwatch.alerts=off</code> label.
          </p>
          <label class="modal-field">
            Container/host CPU threshold (%)
            <input type="number" min="0" max="100" v-model.number="thresholds.cpuThreshold" />
          </label>
          <label class="modal-field">
            Container/host memory threshold (%)
            <input type="number" min="0" max="100" v-model.number="thresholds.memThreshold" />
          </label>
          <label class="modal-field">
            Sustain window (minutes)
            <input type="number" min="0" v-model.number="thresholds.sustainMinutes" />
          </label>
          <label class="modal-field">
            Docker disk usage threshold (GB)
            <input type="number" min="0" v-model.number="thresholds.diskThresholdGb" />
          </label>
          <p v-if="thresholdsOverridden" class="muted small">Overriding the .env defaults.</p>
          <p v-else class="muted small">Using the .env defaults (if any) — no override saved yet.</p>
          <p v-if="thresholdsError" class="error">{{ thresholdsError }}</p>
          <p v-if="thresholdsStatus" class="muted small">{{ thresholdsStatus }}</p>
          <div class="modal-actions">
            <button :disabled="thresholdsSaving" @click="saveThresholds">Save</button>
            <button :disabled="thresholdsSaving || !thresholdsOverridden" @click="clearThresholds">Clear override</button>
          </div>

          <hr />

          <strong>Hosts</strong>
          <p class="muted small">
            Docker hosts this dashboard monitors. Add a remote one as
            <code>ssh://user@host[:port]</code> — the container's docker CLI reaches it using the
            SSH keys already mounted in, no password needed here. Changes apply immediately, no
            restart required.
          </p>
          <p v-if="hostsError" class="error">{{ hostsError }}</p>
          <p v-if="hostsStatus" class="muted small">{{ hostsStatus }}</p>

          <div v-for="h in settingsHosts" :key="h.id" class="host-row">
            <template v-if="editingHostId === h.id">
              <label class="modal-field">
                Display name
                <input type="text" v-model="editHostDraft.name" :placeholder="h.id" />
              </label>
              <label class="modal-field">
                Docker host
                <input type="text" v-model="editHostDraft.dockerHost" placeholder="ssh://user@host (blank = local socket)" />
              </label>
              <div class="modal-actions">
                <button :disabled="hostsSaving" @click="saveEditHost(h.id)">Save</button>
                <button :disabled="hostsSaving" @click="cancelEditHost">Cancel</button>
              </div>
            </template>
            <template v-else>
              <div class="host-row-main">
                <strong>{{ h.name || h.id }}</strong>
                <span class="muted small">{{ h.dockerHost || 'local socket' }}</span>
              </div>
              <div class="modal-actions">
                <button class="small-btn" :disabled="hostsSaving" @click="startEditHost(h)">Edit</button>
                <button class="small-btn" :disabled="hostsSaving" @click="removeHost(h.id)">Remove</button>
              </div>
            </template>
          </div>

          <label class="modal-field">
            ID
            <input type="text" v-model="newHost.id" placeholder="prod" />
          </label>
          <label class="modal-field">
            Display name (optional)
            <input type="text" v-model="newHost.name" placeholder="Production" />
          </label>
          <label class="modal-field">
            Docker host (blank = local socket)
            <input type="text" v-model="newHost.dockerHost" placeholder="ssh://deploy@prod.example.com" />
          </label>
          <div class="modal-actions">
            <button :disabled="hostsSaving || !newHost.id" @click="addHost">Add host</button>
          </div>
      </div>
    </aside>
  `,
};
