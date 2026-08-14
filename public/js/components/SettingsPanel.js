import SettingsGeneral from './SettingsGeneral.js';
import SettingsWebhook from './SettingsWebhook.js';
import SettingsThresholds from './SettingsThresholds.js';
import SettingsContainerRules from './SettingsContainerRules.js';
import SettingsHosts from './SettingsHosts.js';

// The Settings panel: a tab strip over five independent sections, each owning its own data/fetch
// (General/Webhook/Thresholds/ContainerRules/Hosts - see those files). v-if, not v-show, per tab:
// each child is a cheap admin-only GET-config panel with no stream to preserve across a switch, so
// remounting fresh keeps data always-current (e.g. add a host, then flip to Container Rules and
// see it in the dropdown) at the cost of one harmless refetch per tab click.
export default {
  name: 'SettingsPanel',
  components: { SettingsGeneral, SettingsWebhook, SettingsThresholds, SettingsContainerRules, SettingsHosts },
  emits: ['close', 'hosts-changed'],
  data() {
    return { activeTab: 'general' };
  },
  template: `
    <aside class="detail-panel">
      <div class="detail-header">
        <strong>Settings</strong>
        <button @click="$emit('close')">✕</button>
      </div>
      <div class="view-toggle settings-tabs">
        <button :class="{active: activeTab==='general'}" @click="activeTab='general'">General</button>
        <button :class="{active: activeTab==='webhook'}" @click="activeTab='webhook'">Webhook</button>
        <button :class="{active: activeTab==='thresholds'}" @click="activeTab='thresholds'">Thresholds</button>
        <button :class="{active: activeTab==='container-rules'}" @click="activeTab='container-rules'">Container Rules</button>
        <button :class="{active: activeTab==='hosts'}" @click="activeTab='hosts'">Hosts</button>
      </div>
      <div class="detail-body">
        <settings-general v-if="activeTab==='general'"></settings-general>
        <settings-webhook v-if="activeTab==='webhook'"></settings-webhook>
        <settings-thresholds v-if="activeTab==='thresholds'"></settings-thresholds>
        <settings-container-rules v-if="activeTab==='container-rules'"></settings-container-rules>
        <settings-hosts v-if="activeTab==='hosts'" @hosts-changed="$emit('hosts-changed')"></settings-hosts>
      </div>
    </aside>
  `,
};
