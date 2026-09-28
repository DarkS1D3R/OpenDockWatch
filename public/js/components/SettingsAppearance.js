import { LOG_THEME_PRESETS, DEFAULT_LOG_THEME, loadLogTheme, saveLogTheme, applyLogTheme } from '../lib/logTheme.js';

// Settings panel's Appearance tab: the log viewer's background/text colors. Applied immediately on
// every change rather than behind a Save button - unlike the other four tabs, there's no server
// round trip and no wrong-order-of-operations to guard against, so withStatus's saving/error/status
// dance (lib/settingsSection.js) would only add a step nothing here needs. Stored in localStorage
// (lib/logTheme.js), so it's this browser's preference, not shared with other signed-in users - see
// public/CLAUDE.md.
export default {
  name: 'SettingsAppearance',
  data() {
    return {
      presets: LOG_THEME_PRESETS,
      theme: { ...DEFAULT_LOG_THEME },
    };
  },
  mounted() {
    this.theme = loadLogTheme();
  },
  methods: {
    applyPreset(preset) {
      this.theme = { bg: preset.bg, text: preset.text };
      this.persist();
    },
    persist() {
      this.theme = saveLogTheme(this.theme);
      applyLogTheme(this.theme);
    },
    reset() {
      this.theme = saveLogTheme(DEFAULT_LOG_THEME);
      applyLogTheme(this.theme);
    },
  },
  template: `
    <div>
      <p class="muted small">
        Text and background colors for the log viewer, for easier reading. This browser only -
        applied immediately, nothing to save.
      </p>
      <div class="log-theme-presets">
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          class="log-theme-preset-btn"
          :class="{ active: theme.bg === p.bg && theme.text === p.text }"
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
        <button type="button" @click="reset">Reset to default</button>
      </div>
    </div>
  `,
};
