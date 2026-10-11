import { apiGetImageUpdateConfig, apiSaveImageUpdateConfig, apiClearImageUpdateConfig } from '../api.js';
import { withStatus } from '../lib/settingsSection.js';

// The image-update half of Settings > General: how often every running image is compared with its
// registry. 0 is off, the default - periodic checks contact Docker Hub and other registries. The
// detail panel's Check now works either way. See server/imageUpdates.js.
export default {
  name: 'SettingsImageUpdates',
  data() {
    return { hours: 0, overridden: false, saving: false, error: null, status: null };
  },
  async mounted() {
    try {
      this.apply(await apiGetImageUpdateConfig());
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    apply(config) {
      this.hours = config.hours;
      this.overridden = config.overridden;
    },
    save() {
      return withStatus(this, 'saving', async () => {
        this.apply(await apiSaveImageUpdateConfig(Number(this.hours) || 0));
        this.status = this.hours ? 'Saved.' : 'Saved - periodic checks are off.';
      });
    },
    clear() {
      return withStatus(this, 'saving', async () => {
        this.apply(await apiClearImageUpdateConfig());
        this.status = 'Cleared - using the .env default.';
      });
    },
  },
  template: `
    <div>
      <h4 class="settings-subheading">Image updates</h4>
      <p class="muted small">
        Compares each container's image with what its tag points at on the registry, and marks the
        ones with a newer image. Detection only - nothing is pulled or restarted. Checking contacts
        each image's registry (one lightweight request per tag), so it is off until set here or with
        IMAGE_UPDATE_CHECK_HOURS. Images on private registries show as not checkable.
      </p>
      <label class="modal-field">
        Check every (hours, 0 = off)
        <input type="number" min="0" max="720" v-model="hours" />
      </label>
      <p v-if="overridden" class="muted small">Overriding the .env default.</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="status" class="muted small" role="status">{{ status }}</p>
      <div class="modal-actions">
        <button :disabled="saving" @click="save">Save</button>
        <button :disabled="saving || !overridden" @click="clear">Clear override</button>
      </div>
    </div>
  `,
};
