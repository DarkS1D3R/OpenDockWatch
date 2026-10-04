// The log viewer's readable-colors preference: a background/text pair applied to every log pane via
// two CSS custom properties on the document root (--log-bg/--log-text), so LogViewer/LogsView panes
// pick it up without prop drilling - the same reason app.js applies it once at mount rather than
// each pane reading storage itself. localStorage, not sessionStorage: this is a personal reading
// preference worth keeping for weeks, the same grain as graph/persistence.js's node positions, not
// a per-tab thing like logsPersistence.js's open panes. See public/CLAUDE.md.

const STORAGE_KEY = 'odw:logTheme';

// A handful of tested combos, not just the current default - each pair clears WCAG AA's 4.5:1
// normal-text contrast ratio, since the whole point of this feature is readability.
export const LOG_THEME_PRESETS = [
  { id: 'default', label: 'Default', bg: '#0d0e11', text: '#e4e6eb' },
  { id: 'high-contrast', label: 'High contrast', bg: '#000000', text: '#ffffff' },
  { id: 'solarized', label: 'Solarized dark', bg: '#002b36', text: '#93a1a1' },
  { id: 'paper', label: 'Paper (light)', bg: '#f5f5f0', text: '#1b1b1b' },
  { id: 'amber', label: 'Amber terminal', bg: '#1a1005', text: '#ffb000' },
  { id: 'matrix', label: 'Matrix green', bg: '#060a06', text: '#33ff66' },
];

export const DEFAULT_LOG_THEME = { bg: LOG_THEME_PRESETS[0].bg, text: LOG_THEME_PRESETS[0].text };

// Accepts what a native <input type="color"> produces (#rrggbb) plus the shorter/alpha hex forms,
// since this also has to survive a hand-edited localStorage entry. Anything else degrades to the
// default rather than reaching a CSS custom property unvalidated.
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export function isValidLogColor(value) {
  return typeof value === 'string' && COLOR_RE.test(value.trim());
}

// Validated on the way out, not merely parsed - same discipline as logsPersistence.js's
// normalizeOpenPanes: a malformed or missing field degrades to the matching default field rather
// than reaching applyLogTheme (and from there, the log body's actual color) unvalidated.
export function normalizeLogTheme(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LOG_THEME };
  const bg = isValidLogColor(raw.bg) ? toRrggbb(raw.bg) : DEFAULT_LOG_THEME.bg;
  const text = isValidLogColor(raw.text) ? toRrggbb(raw.text) : DEFAULT_LOG_THEME.text;
  return { bg, text };
}

// Canonical lowercase #rrggbb, alpha dropped: the only form <input type="color"> can show (it reads
// anything else as black) and the form the preset buttons' active check compares against.
function toRrggbb(value) {
  let hex = value.trim().slice(1).toLowerCase();
  if (hex.length < 6) hex = [...hex].map((c) => c + c).join('');
  return `#${hex.slice(0, 6)}`;
}

export function loadLogTheme() {
  try {
    return normalizeLogTheme(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_LOG_THEME };
  }
}

export function saveLogTheme(theme) {
  const normalized = normalizeLogTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* localStorage unavailable or full - the preference just won't survive a reload */
  }
  return normalized;
}

// 'light' or 'dark' for a background, by WCAG relative luminance - 0.179 is where black and white
// text contrast equally. Fixed-colour log text (ANSI spans) is tuned for dark and needs to know.
export function logSchemeFor(bg) {
  const hex = toRrggbb(String(bg)).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? 'light' : 'dark';
}

// The one place the theme actually reaches the page: two custom properties on the root, which
// style.css's .log-view (and its alternating-row stripe) read with the current defaults as a
// fallback, so a page that hasn't called this yet still renders exactly as before this feature.
export function applyLogTheme(theme) {
  const normalized = normalizeLogTheme(theme);
  document.documentElement.style.setProperty('--log-bg', normalized.bg);
  document.documentElement.style.setProperty('--log-text', normalized.text);
  document.documentElement.setAttribute('data-log-scheme', logSchemeFor(normalized.bg));
  return normalized;
}
