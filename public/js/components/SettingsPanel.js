import SettingsGeneral from './SettingsGeneral.js';
import SettingsWebhook from './SettingsWebhook.js';
import SettingsThresholds from './SettingsThresholds.js';
import SettingsContainerRules from './SettingsContainerRules.js';
import SettingsHosts from './SettingsHosts.js';
import SettingsAppearance from './SettingsAppearance.js';
import SettingsAudit from './SettingsAudit.js';
import { rememberFocus, modalOpenAbove } from '../lib/focus.js';

// The Settings panel: a tab strip over seven independent sections, each owning its own data/fetch
// (General/Webhook/Thresholds/ContainerRules/Hosts/Appearance/Audit - see those files). v-if, not v-show,
// per tab: each child is a cheap admin-only GET-config panel with no stream to preserve across a
// switch, so remounting fresh keeps data always-current (e.g. add a host, then flip to Container
// Rules and see it in the dropdown) at the cost of one harmless refetch per tab click - Appearance
// has no fetch at all (localStorage only), but stays v-if for the same reason as its neighbors.
export default {
  name: 'SettingsPanel',
  components: {
    SettingsGeneral,
    SettingsWebhook,
    SettingsThresholds,
    SettingsContainerRules,
    SettingsHosts,
    SettingsAppearance,
    SettingsAudit,
  },
  emits: ['close', 'hosts-changed'],
  data() {
    return { activeTab: 'general' };
  },
  // A non-modal dialog: the page stays usable beside it, so no Tab trap - but focus moves in on open,
  // back to the Settings button on close, and Escape closes it unless a field or a modal has the key.
  mounted() {
    this._restoreFocus = rememberFocus();
    this._onKeydown = (event) => {
      if (event.key !== 'Escape' || modalOpenAbove(this.$el)) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName)) return;
      this.$emit('close');
    };
    window.addEventListener('keydown', this._onKeydown);
    this.$refs.closeBtn.focus();
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this._onKeydown);
    this._restoreFocus();
  },
  template: `
    <aside class="detail-panel settings-panel" role="dialog" aria-labelledby="settings-panel-title">
      <div class="detail-header">
        <strong id="settings-panel-title">Settings</strong>
        <button ref="closeBtn" @click="$emit('close')" aria-label="Close settings" title="Close settings">✕</button>
      </div>
      <div class="view-toggle settings-tabs" role="group" aria-label="Settings sections">
        <button :class="{active: activeTab==='general'}" :aria-current="activeTab==='general' ? 'true' : null" @click="activeTab='general'">General</button>
        <button :class="{active: activeTab==='webhook'}" :aria-current="activeTab==='webhook' ? 'true' : null" @click="activeTab='webhook'">Webhook</button>
        <button :class="{active: activeTab==='thresholds'}" :aria-current="activeTab==='thresholds' ? 'true' : null" @click="activeTab='thresholds'">Thresholds</button>
        <button :class="{active: activeTab==='container-rules'}" :aria-current="activeTab==='container-rules' ? 'true' : null" @click="activeTab='container-rules'">Container Rules</button>
        <button :class="{active: activeTab==='hosts'}" :aria-current="activeTab==='hosts' ? 'true' : null" @click="activeTab='hosts'">Hosts</button>
        <button :class="{active: activeTab==='appearance'}" :aria-current="activeTab==='appearance' ? 'true' : null" @click="activeTab='appearance'">Appearance</button>
        <button :class="{active: activeTab==='audit'}" :aria-current="activeTab==='audit' ? 'true' : null" @click="activeTab='audit'">Audit log</button>
      </div>
      <div class="detail-body">
        <settings-general v-if="activeTab==='general'"></settings-general>
        <settings-webhook v-if="activeTab==='webhook'"></settings-webhook>
        <settings-thresholds v-if="activeTab==='thresholds'"></settings-thresholds>
        <settings-container-rules v-if="activeTab==='container-rules'"></settings-container-rules>
        <settings-hosts v-if="activeTab==='hosts'" @hosts-changed="$emit('hosts-changed')"></settings-hosts>
        <settings-appearance v-if="activeTab==='appearance'"></settings-appearance>
        <settings-audit v-if="activeTab==='audit'"></settings-audit>
      </div>
    </aside>
  `,
};
