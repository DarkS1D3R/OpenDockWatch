// The one source for the colours the container state and health axes are drawn in. They used to be
// hex literals in four places - format.js's state icons, graph/style.js's CY_STYLE, svgExport.js's
// hand-drawn nodes, and style.css - so changing one silently disagreed with the rest. See CLAUDE.md.

// Palette tokens, not states: ACCENT and MUTED are the same two values style.css exposes as
// --accent and --muted, and several things besides container state are drawn in them.
export const ACCENT = '#4f8cff';
export const MUTED = '#8b909c';

// Keyed by what the container *is*, never by where it is drawn. `running`/`starting`/`unhealthy`
// are the health axis laid over the running state (see format.js's stateEmoji), and `created` is
// deliberately ACCENT rather than MUTED - created-but-never-started is not the same fact as exited.
export const STATE_COLORS = {
  running: '#3fb950',
  stopped: MUTED,
  created: ACCENT,
  starting: '#d29922',
  unhealthy: '#f85149',
};

// A selected node borrows the accent rather than owning a colour, which is why CY_STYLE orders
// created -> starting -> unhealthy -> selected: the more urgent fact wins the border.
export const SELECTED = ACCENT;

// The style.css custom property carrying each state's value, so test/theme.test.js can hold the
// two sides together across a boundary no import can cross. `unhealthy` is deliberately absent -
// the CSS has no counterpart for it. See CLAUDE.md.
export const CSS_VAR_FOR_STATE = {
  running: '--ok',
  stopped: '--muted',
  created: '--accent',
  starting: '--warn',
};
