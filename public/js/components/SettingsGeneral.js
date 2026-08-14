import { apiGetDefaultView, apiSaveDefaultView, apiClearDefaultView } from '../api.js';
import { withStatus } from '../lib/settingsSection.js';

const VIEWS = [
  { value: 'list', label: 'List' },
  { value: 'flow', label: 'Flow' },
  { value: 'logs', label: 'Logs' },
  { value: 'activity', label: 'Activity' },
];

// The Settings panel's General tab: currently just the default landing tab, env-default +
// DB-override like the other sections - see server/index.js's getDefaultView.
export default {
  name: 'SettingsGeneral',
  data() {
    return {
      defaultView: 'list',
      overridden: false,
      saving: false,
      error: null,
      status: null,
      views: VIEWS,
    };
  },
  async mounted() {
    try {
      const config = await apiGetDefaultView();
      this.defaultView = config.defaultView;
      this.overridden = config.overridden;
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    save() {
      return withStatus(this, 'saving', async () => {
        const config = await apiSaveDefaultView(this.defaultView);
        this.defaultView = config.defaultView;
        this.overridden = config.overridden;
        this.status = 'Saved.';
      });
    },
    clear() {
      return withStatus(this, 'saving', async () => {
        const config = await apiClearDefaultView();
        this.defaultView = config.defaultView;
        this.overridden = config.overridden;
        this.status = 'Cleared - using the .env default.';
      });
    },
  },
  template: `
    <div>
      <p class="muted small">
        Which tab the app lands on right after login, for every user regardless of role. Sets
        DEFAULT_VIEW - can also be set (and changed without a restart) from here.
      </p>
      <label class="modal-field">
        Default tab
        <select v-model="defaultView">
          <option v-for="v in views" :key="v.value" :value="v.value">{{ v.label }}</option>
        </select>
      </label>
      <p v-if="overridden" class="muted small">Overriding the .env default.</p>
      <p v-else class="muted small">Using the .env default (if any) — no override saved yet.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="status" class="muted small">{{ status }}</p>
      <div class="modal-actions">
        <button :disabled="saving" @click="save">Save</button>
        <button :disabled="saving || !overridden" @click="clear">Clear override</button>
      </div>
    </div>
  `,
};
