// The one source for the colours the container state and health axes are drawn in. They used to be
// hex literals in four places - format.js's state icons, graph/style.js's CY_STYLE, svgExport.js's
// hand-drawn nodes, and style.css - so changing one silently disagreed with the rest. See docs/architecture/frontend.md.

// One palette per app colour scheme (lib/appTheme.js picks which). Light is not dark inverted:
// every hue is a darker step so it still clears 4.5:1 as text on the light panel. See docs/architecture/frontend.md.
export const PALETTES = {
  dark: {
    accent: '#4f8cff',
    muted: '#8b909c',
    states: { running: '#3fb950', starting: '#d29922', unhealthy: '#f85149' },
  },
  light: {
    accent: '#2860c8',
    muted: '#5b626e',
    states: { running: '#17702f', starting: '#865a00', unhealthy: '#c0202b' },
  },
};

// Keyed by what the container *is*, never by where it is drawn. `running`/`starting`/`unhealthy`
// are the health axis laid over the running state (see format.js's stateEmoji), and `created` is
// deliberately the accent rather than muted - created-but-never-started is not the same fact as exited.
export function stateColorsFor(scheme) {
  const p = PALETTES[scheme] || PALETTES.dark;
  return { running: p.states.running, stopped: p.muted, created: p.accent, starting: p.states.starting, unhealthy: p.states.unhealthy };
}

// The dark values under their historical names - the default scheme, and what the tests pin.
export const ACCENT = PALETTES.dark.accent;
export const MUTED = PALETTES.dark.muted;
export const STATE_COLORS = stateColorsFor('dark');

// A selected node borrows the accent rather than owning a colour, which is why CY_STYLE orders
// created -> starting -> unhealthy -> selected: the more urgent fact wins the border.
export const SELECTED = ACCENT;

// The style.css custom property carrying each state's value, in both the :root block and the
// light one, so test/theme.test.js can hold the two sides together across a boundary no import
// can cross. DOM consumers (format.js's icons) reference these instead of a hex. See docs/architecture/frontend.md.
export const CSS_VAR_FOR_STATE = {
  running: '--ok',
  stopped: '--muted',
  created: '--accent',
  starting: '--warn',
  unhealthy: '--unhealthy',
};

// `var(--ok)` etc. - for anything that renders into the live DOM and so should follow a theme
// switch with no re-render. A standalone export (svgExport) has no stylesheet and uses hexes.
export const STATE_VARS = Object.fromEntries(Object.entries(CSS_VAR_FOR_STATE).map(([s, v]) => [s, `var(${v})`]));

// The inverse, for a string headed somewhere with no stylesheet: format.js's state icons are
// embedded in the standalone SVG export, where `var(--ok)` would resolve to nothing at all.
export function resolveStateVars(markup, scheme) {
  const colors = stateColorsFor(scheme);
  const hexFor = Object.fromEntries(Object.entries(CSS_VAR_FOR_STATE).map(([s, v]) => [v, colors[s]]));
  return String(markup ?? '').replace(/var\((--[a-z]+)\)/g, (m, name) => hexFor[name] || m);
}
