import { apiGetHostsConfig, apiAddHost, apiUpdateHost, apiDeleteHost, apiTestHost } from '../api.js';
import { withStatus } from '../lib/settingsSection.js';

// The Settings panel's Hosts tab. Split out of the former single SettingsPanel.js - see
// SettingsWebhook.js for the reasoning.
export default {
  name: 'SettingsHosts',
  emits: ['hosts-changed'],
  data() {
    return {
      hosts: [],
      newHost: { id: '', name: '', dockerHost: '' },
      saving: false,
      error: null,
      status: null,
      editingHostId: null,
      editHostDraft: { name: '', dockerHost: '' },
      testingHostId: null,
      hostTestResults: {}, // hostId -> { ok, message }
    };
  },
  async mounted() {
    try {
      this.hosts = await apiGetHostsConfig();
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    addHost() {
      return withStatus(this, 'saving', async () => {
        this.hosts = await apiAddHost(this.newHost);
        this.newHost = { id: '', name: '', dockerHost: '' };
        this.status = 'Host added.';
        this.$emit('hosts-changed');
      });
    },
    startEditHost(host) {
      this.editingHostId = host.id;
      this.editHostDraft = { name: host.name || '', dockerHost: host.dockerHost || '' };
      this.error = null;
      this.status = null;
    },
    cancelEditHost() {
      this.editingHostId = null;
    },
    saveEditHost(id) {
      return withStatus(this, 'saving', async () => {
        this.hosts = await apiUpdateHost(id, this.editHostDraft);
        this.editingHostId = null;
        this.status = 'Host updated.';
        this.$emit('hosts-changed');
      });
    },
    removeHost(id) {
      return withStatus(this, 'saving', async () => {
        this.hosts = await apiDeleteHost(id);
        this.status = 'Host removed.';
        this.$emit('hosts-changed');
      });
    },
    async testHostConnection(id) {
      this.testingHostId = id;
      this.hostTestResults = { ...this.hostTestResults, [id]: null };
      try {
        await apiTestHost(id);
        this.hostTestResults = { ...this.hostTestResults, [id]: { ok: true, message: 'Connected.' } };
      } catch (err) {
        // The real docker/ssh stderr, not a generic "unreachable" - e.g. "Host key verification
        // failed" or "Permission denied (publickey)" tells the user exactly what to fix.
        this.hostTestResults = { ...this.hostTestResults, [id]: { ok: false, message: err.message } };
      } finally {
        this.testingHostId = null;
      }
    },
  },
  template: `
    <div>
      <p class="muted small">
        Docker hosts this dashboard monitors. Add a remote one as
        <code>ssh://user@host[:port]</code> — the container's docker CLI reaches it using the
        SSH keys already mounted in, no password needed here. Changes apply immediately, no
        restart required.
      </p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="status" class="muted small">{{ status }}</p>

      <div v-for="h in hosts" :key="h.id" class="host-row">
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
            <button :disabled="saving" @click="saveEditHost(h.id)">Save</button>
            <button :disabled="saving" @click="cancelEditHost">Cancel</button>
          </div>
        </template>
        <template v-else>
          <div class="host-row-main">
            <strong>{{ h.name || h.id }}</strong>
            <span class="muted small">{{ h.dockerHost || 'local socket' }}</span>
          </div>
          <p v-if="hostTestResults[h.id]" :class="hostTestResults[h.id].ok ? 'muted small' : 'error'">
            {{ hostTestResults[h.id].ok ? '✓' : '✕' }} {{ hostTestResults[h.id].message }}
          </p>
          <div class="modal-actions">
            <button class="small-btn" :disabled="testingHostId === h.id" @click="testHostConnection(h.id)">
              {{ testingHostId === h.id ? 'Testing…' : 'Test connection' }}
            </button>
            <button class="small-btn" :disabled="saving" @click="startEditHost(h)">Edit</button>
            <button class="small-btn" :disabled="saving" @click="removeHost(h.id)">Remove</button>
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
        <button :disabled="saving || !newHost.id" @click="addHost">Add host</button>
      </div>
    </div>
  `,
};
