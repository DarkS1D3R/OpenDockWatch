import { apiGetThresholdConfig, apiSaveThresholdConfig, apiClearThresholdConfig } from '../api.js';
import { withStatus } from '../lib/settingsSection.js';

// The Settings panel's (global) Thresholds tab. Per-container overrides live in
// SettingsContainerRules.js instead - see alerts.js's resolveContainerConfig.
export default {
  name: 'SettingsThresholds',
  data() {
    return {
      thresholds: { cpuThreshold: 0, memThreshold: 0, sustainMinutes: 5, diskThresholdGb: 0 },
      overridden: false,
      saving: false,
      error: null,
      status: null,
    };
  },
  async mounted() {
    try {
      const config = await apiGetThresholdConfig();
      this.thresholds = config;
      this.overridden = config.overridden;
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    save() {
      return withStatus(this, 'saving', async () => {
        const config = await apiSaveThresholdConfig(this.thresholds);
        this.thresholds = config;
        this.overridden = config.overridden;
        this.status = 'Saved.';
      });
    },
    clear() {
      return withStatus(this, 'saving', async () => {
        const config = await apiClearThresholdConfig();
        this.thresholds = config;
        this.overridden = config.overridden;
        this.status = 'Cleared - using the .env default.';
      });
    },
  },
  template: `
    <div>
      <p class="muted small">
        Alert when a value stays over threshold for the sustain window. Leave a threshold at 0 to disable that
        rule. CPU% is raw <code>docker stats</code> CPU (per-core cumulative, so 4 cores fully busy reads 400%).
        Mem% needs a container memory limit set to mean much. Docker disk usage is Docker's own footprint
        (images/containers/volumes/cache), not host free disk space — it's a prune reminder, not a disk-full alert.
        These are the global defaults - see the Container Rules tab for per-container/name/compose-project
        overrides, and the <code>opendockwatch.alerts=off</code> label to skip a container entirely.
      </p>
      <label class="modal-field">
        Container/host CPU threshold (%) - over 100 is valid for containers (per-core cumulative)
        <input type="number" min="0" v-model.number="thresholds.cpuThreshold" />
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
      <p v-if="overridden" class="muted small">Overriding the .env defaults.</p>
      <p v-else class="muted small">Using the .env defaults (if any) — no override saved yet.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="status" class="muted small">{{ status }}</p>
      <div class="modal-actions">
        <button :disabled="saving" @click="save">Save</button>
        <button :disabled="saving || !overridden" @click="clear">Clear override</button>
      </div>
    </div>
  `,
};
