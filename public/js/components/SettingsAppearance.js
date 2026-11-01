import { APP_THEME_OPTIONS, loadAppTheme, saveAppTheme, applyAppTheme, currentScheme } from '../lib/appTheme.js';
import {
  LOG_THEME_PRESETS,
  DEFAULT_LOG_THEME,
  loadLogTheme,
  saveLogTheme,
  applyLogTheme,
  hasCustomLogTheme,
  clearLogTheme,
} from '../lib/logTheme.js';

// Settings panel's Appearance tab: the app's dark/light theme (lib/appTheme.js) and the log
// viewer's background/text colors, which follow it (Default on dark, Paper on light) until chosen. Applied immediately on
// every change rather than behind a Save button - unlike the other four tabs, there's no server
// round trip and no wrong-order-of-operations to guard against, so withStatus's saving/error/status
// dance (lib/settingsSection.js) would only add a step nothing here needs. Stored in localStorage
// (lib/logTheme.js), so it's this browser's preference, not shared with other signed-in users - see
// docs/architecture/frontend.md.
export default {
  name: 'SettingsAppearance',
  data() {
    return {
      appThemeOptions: APP_THEME_OPTIONS,
      appTheme: loadAppTheme(),
      presets: LOG_THEME_PRESETS,
      theme: { ...DEFAULT_LOG_THEME },
      logFollowsApp: true,
    };
  },
  mounted() {
    this.refreshLogTheme();
  },
  methods: {
    // The root re-applies the log colours on the theme-change event; this only refreshes the preview.
    setAppTheme(id) {
      this.appTheme = saveAppTheme(id);
      applyAppTheme(this.appTheme);
      this.refreshLogTheme();
    },
    refreshLogTheme() {
      this.theme = loadLogTheme(currentScheme());
      this.logFollowsApp = !hasCustomLogTheme();
    },
    applyPreset(preset) {
      this.theme = { bg: preset.bg, text: preset.text };
      this.persist();
    },
    persist() {
      this.theme = saveLogTheme(this.theme);
      this.logFollowsApp = false;
      applyLogTheme(this.theme);
    },
    reset() {
      clearLogTheme();
      this.refreshLogTheme();
      applyLogTheme(this.theme);
    },
  },
  template: `
    <div>
      <h4 class="appearance-heading">Theme</h4>
      <p class="muted small">Colors for the whole app. This browser only - applied immediately.</p>
      <div class="app-theme-options" role="group" aria-label="App theme">
        <button
          v-for="o in appThemeOptions"
          :key="o.id"
          type="button"
          class="app-theme-btn"
          :class="{ active: appTheme === o.id }" :aria-pressed="String(appTheme === o.id)"
          @click="setAppTheme(o.id)"
        >{{ o.label }}</button>
      </div>
      <h4 class="appearance-heading">Log viewer</h4>
      <p class="muted small">
        Text and background colors for the log viewer, for easier reading. This browser only -
        applied immediately, nothing to save.
      </p>
      <p class="muted small" role="status">
        {{ logFollowsApp ? 'Following the app theme: Default when dark, Paper when light.' : 'Your own choice, used in both themes.' }}
      </p>
      <div class="log-theme-presets">
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          class="log-theme-preset-btn"
          :class="{ active: theme.bg === p.bg && theme.text === p.text }" :aria-pressed="String(theme.bg === p.bg && theme.text === p.text)"
          :style="{ background: p.bg, color: p.text }"
          @click="applyPreset(p)"
        >{{ p.label }}</button>
      </div>
      <div class="log-theme-custom">
        <label class="modal-field">
          Background
          <input type="color" v-model="theme.bg" @change="persist" />
        </label>
        <label class="modal-field">
          Text
          <input type="color" v-model="theme.text" @change="persist" />
        </label>
      </div>
      <pre class="log-view log-theme-preview" :style="{ background: theme.bg, color: theme.text }"><div class="log-line">2026-09-28T12:00:00Z app started, listening on :3000</div><div class="log-line">2026-09-28T12:00:01Z GET /healthz 200 2ms</div><div class="log-line">2026-09-28T12:00:04Z GET /healthz 200 1ms</div><div class="log-line">2026-09-28T12:00:07Z WARN slow query: 812ms</div></pre>
      <div class="modal-actions">
        <button type="button" @click="reset" :disabled="logFollowsApp">Follow app theme</button>
      </div>
    </div>
  `,
};
