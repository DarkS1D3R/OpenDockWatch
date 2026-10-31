// The whole app's colour scheme (Settings -> Appearance): a dark/light/system preference in
// localStorage, resolved to a scheme and applied as data-theme on the root, which style.css's
// light block keys off. public/js/theme-boot.js applies it before first paint. See public/CLAUDE.md.

export const APP_THEME_STORAGE_KEY = 'odw:appTheme';
export const APP_THEME_CHANGE_EVENT = 'odw:themechange';

export const APP_THEME_OPTIONS = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
];

// Dark, not system: an existing install should not change colour under anyone who never asked.
export const DEFAULT_APP_THEME = 'dark';

// Validated on the way out, same discipline as logTheme.js - this is hand-editable storage.
export function normalizeAppTheme(raw) {
  return APP_THEME_OPTIONS.some((o) => o.id === raw) ? raw : DEFAULT_APP_THEME;
}

// 'system' follows prefers-color-scheme; the two explicit choices ignore it.
export function resolveScheme(preference, systemPrefersLight) {
  const pref = normalizeAppTheme(preference);
  if (pref === 'system') return systemPrefersLight ? 'light' : 'dark';
  return pref;
}

export function loadAppTheme(storage = globalThis.localStorage) {
  try {
    return normalizeAppTheme(storage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_THEME;
  }
}

export function saveAppTheme(preference, storage = globalThis.localStorage) {
  const pref = normalizeAppTheme(preference);
  try {
    storage.setItem(APP_THEME_STORAGE_KEY, pref);
  } catch {
    /* localStorage unavailable or full - the preference just won't survive a reload */
  }
  return pref;
}

function systemPrefersLight() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

// The scheme currently on the page, read back off the attribute rather than recomputed, so a
// canvas consumer (the Flow graph) always agrees with what the stylesheet is drawing.
export function currentScheme(doc = globalThis.document) {
  return doc?.documentElement?.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

// Sets data-theme and tells canvas-drawn views to rebuild; a no-op event when nothing changed.
export function applyAppTheme(preference, doc = globalThis.document) {
  const scheme = resolveScheme(preference, systemPrefersLight());
  const root = doc.documentElement;
  const changed = root.getAttribute('data-theme') !== scheme;
  root.setAttribute('data-theme', scheme);
  if (changed) doc.dispatchEvent(new CustomEvent(APP_THEME_CHANGE_EVENT, { detail: { scheme } }));
  return scheme;
}

// Re-applies on an OS-level switch while the preference is 'system'. Returns an unsubscribe.
export function watchSystemScheme(getPreference, doc = globalThis.document) {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (getPreference() === 'system') applyAppTheme('system', doc);
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
