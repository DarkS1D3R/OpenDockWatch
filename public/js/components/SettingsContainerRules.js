import {
  apiGetContainerRules,
  apiAddContainerRule,
  apiUpdateContainerRule,
  apiDeleteContainerRule,
  apiReorderContainerRules,
  apiGetHostsConfig,
} from '../api.js';
import { withStatus } from '../lib/settingsSection.js';

const EVENT_RULES = [
  { value: 'container_crashed', label: 'Container crashed' },
  { value: 'crash_loop', label: 'Crash loop' },
  { value: 'unhealthy', label: 'Unhealthy' },
];

function blankRule() {
  return { hostId: '', matchType: 'name', matchValue: '', cpuThreshold: '', memThreshold: '', sustainMinutes: '', mutedRules: [] };
}

// The Settings panel's Container Rules tab: per-container/name/compose-project overrides on top
// of SettingsThresholds' global defaults - see alerts.js's resolveContainerConfig for the
// first-match-wins ordered-list semantics this list is editing.
export default {
  name: 'SettingsContainerRules',
  data() {
    return {
      rules: [],
      hosts: [],
      newRule: blankRule(),
      editingRuleId: null,
      editDraft: null,
      saving: false,
      error: null,
      status: null,
      eventRules: EVENT_RULES,
    };
  },
  async mounted() {
    try {
      this.rules = await apiGetContainerRules();
      this.hosts = await apiGetHostsConfig();
    } catch (err) {
      this.error = err.message;
    }
  },
  methods: {
    hostLabel(hostId) {
      if (!hostId) return 'All hosts';
      const h = this.hosts.find((x) => x.id === hostId);
      return h ? h.name || h.id : hostId;
    },
    matchSummary(rule) {
      return rule.matchType === 'name' ? `name contains "${rule.matchValue}"` : `compose project "${rule.matchValue}"`;
    },
    ruleLabel(name) {
      const r = EVENT_RULES.find((e) => e.value === name);
      return r ? r.label : name;
    },
    addRule() {
      return withStatus(this, 'saving', async () => {
        this.rules = await apiAddContainerRule(this.newRule);
        this.newRule = blankRule();
        this.status = 'Rule added.';
      });
    },
    startEdit(rule) {
      this.editingRuleId = rule.id;
      // hostId back to '' (never null) or the "All hosts" <option value=""> matches nothing and the
      // select renders blank - Vue compares option values as strings, and String(null) is "null".
      this.editDraft = { ...rule, hostId: rule.hostId || '', mutedRules: [...rule.mutedRules] };
      this.error = null;
      this.status = null;
    },
    cancelEdit() {
      this.editingRuleId = null;
      this.editDraft = null;
    },
    saveEdit(id) {
      return withStatus(this, 'saving', async () => {
        this.rules = await apiUpdateContainerRule(id, this.editDraft);
        this.editingRuleId = null;
        this.editDraft = null;
        this.status = 'Rule updated.';
      });
    },
    removeRule(id) {
      return withStatus(this, 'saving', async () => {
        this.rules = await apiDeleteContainerRule(id);
        this.status = 'Rule removed.';
      });
    },
    moveRule(index, dir) {
      return withStatus(this, 'saving', async () => {
        const j = index + dir;
        if (j < 0 || j >= this.rules.length) return;
        const ids = this.rules.map((r) => r.id);
        [ids[index], ids[j]] = [ids[j], ids[index]];
        this.rules = await apiReorderContainerRules(ids);
      });
    },
  },
  template: `
    <div>
      <p class="muted small">
        Per-container overrides on top of the global Thresholds tab. Rules are checked in order -
        the <strong>first</strong> one whose host and matcher fit a container is used in full for
        it (not merged with any other rule); a blank threshold on the matched rule still inherits
        the global default. Match by container name (case-insensitive, contains) or an exact
        compose project name - no glob/regex. Independent of the <code>opendockwatch.alerts=off</code>
        label, which still silences threshold alerts for a container unconditionally regardless of
        any rule here.
      </p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="status" class="muted small">{{ status }}</p>

      <p v-if="!rules.length" class="muted small">No container rules yet - matched containers use the global defaults.</p>

      <div v-for="(r, i) in rules" :key="r.id" class="host-row">
        <template v-if="editingRuleId === r.id">
          <label class="modal-field">
            Host
            <select v-model="editDraft.hostId">
              <option value="">All hosts</option>
              <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name || h.id }}</option>
            </select>
          </label>
          <label class="modal-field">
            Match
            <select v-model="editDraft.matchType">
              <option value="name">Container name contains</option>
              <option value="composeProject">Compose project is</option>
            </select>
          </label>
          <label class="modal-field">
            Value
            <input type="text" v-model="editDraft.matchValue" />
          </label>
          <label class="modal-field">
            CPU threshold (%) - blank inherits global, over 100 is valid (per-core cumulative)
            <input type="number" min="0" v-model="editDraft.cpuThreshold" />
          </label>
          <label class="modal-field">
            Memory threshold (%) - blank inherits global
            <input type="number" min="0" max="100" v-model="editDraft.memThreshold" />
          </label>
          <label class="modal-field">
            Sustain window (minutes) - blank inherits global
            <input type="number" min="0" v-model="editDraft.sustainMinutes" />
          </label>
          <div class="modal-field">
            Mute event rules for matched containers
            <label v-for="er in eventRules" :key="er.value" class="checkbox-label">
              <input type="checkbox" v-model="editDraft.mutedRules" :value="er.value" /> {{ er.label }}
            </label>
          </div>
          <div class="modal-actions">
            <button :disabled="saving" @click="saveEdit(r.id)">Save</button>
            <button :disabled="saving" @click="cancelEdit">Cancel</button>
          </div>
        </template>
        <template v-else>
          <div class="host-row-main">
            <strong>{{ hostLabel(r.hostId) }}</strong>
            <span class="muted small">{{ matchSummary(r) }}</span>
          </div>
          <p class="muted small">
            CPU: {{ r.cpuThreshold ?? 'inherit' }}{{ r.cpuThreshold != null ? '%' : '' }},
            Mem: {{ r.memThreshold ?? 'inherit' }}{{ r.memThreshold != null ? '%' : '' }},
            Sustain: {{ r.sustainMinutes ?? 'inherit' }}{{ r.sustainMinutes != null ? 'm' : '' }}
          </p>
          <p v-if="r.mutedRules.length" class="muted small">Muted: {{ r.mutedRules.map(ruleLabel).join(', ') }}</p>
          <div class="modal-actions">
            <button class="small-btn" :disabled="saving || i === 0" @click="moveRule(i, -1)" title="Move up">▲</button>
            <button class="small-btn" :disabled="saving || i === rules.length - 1" @click="moveRule(i, 1)" title="Move down">▼</button>
            <button class="small-btn" :disabled="saving" @click="startEdit(r)">Edit</button>
            <button class="small-btn" :disabled="saving" @click="removeRule(r.id)">Remove</button>
          </div>
        </template>
      </div>

      <hr />

      <label class="modal-field">
        Host
        <select v-model="newRule.hostId">
          <option value="">All hosts</option>
          <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name || h.id }}</option>
        </select>
      </label>
      <label class="modal-field">
        Match
        <select v-model="newRule.matchType">
          <option value="name">Container name contains</option>
          <option value="composeProject">Compose project is</option>
        </select>
      </label>
      <label class="modal-field">
        Value
        <input type="text" v-model="newRule.matchValue" placeholder="redis" />
      </label>
      <label class="modal-field">
        CPU threshold (%) - blank inherits global, over 100 is valid (per-core cumulative)
        <input type="number" min="0" v-model="newRule.cpuThreshold" />
      </label>
      <label class="modal-field">
        Memory threshold (%) - blank inherits global
        <input type="number" min="0" max="100" v-model="newRule.memThreshold" />
      </label>
      <label class="modal-field">
        Sustain window (minutes) - blank inherits global
        <input type="number" min="0" v-model="newRule.sustainMinutes" />
      </label>
      <div class="modal-field">
        Mute event rules for matched containers
        <label v-for="er in eventRules" :key="er.value" class="checkbox-label">
          <input type="checkbox" v-model="newRule.mutedRules" :value="er.value" /> {{ er.label }}
        </label>
      </div>
      <div class="modal-actions">
        <button :disabled="saving || !newRule.matchValue" @click="addRule">Add rule</button>
      </div>
    </div>
  `,
};
