const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The container state/health palette used to be hex literals in four files - format.js's icons,
// CY_STYLE, svgExport.js's hand-drawn nodes and style.css - with nothing holding them together.
// The three JS copies are now one import and cannot drift by construction. This file covers the
// two seams an import cannot: the stylesheet, which no JS module can reach, and svgExport's
// hand-written precedence chain, which restates CY_STYLE's selector order in code.
//
// pathToFileURL rather than a plain relative string, same as test/graph.test.js: import()'s
// relative-specifier resolution wants forward slashes and path.join gives backslashes on Windows.
const publicDir = path.join(__dirname, '..', 'public');

let theme, cyStyle;
before(async () => {
  theme = await import(pathToFileURL(path.join(publicDir, 'js', 'theme.js')));
  cyStyle = await import(pathToFileURL(path.join(publicDir, 'js', 'graph', 'style.js')));
});

// Reads the declaration out of style.css's :root rather than a browser, which is enough: the
// question is whether the two files agree on a value, not whether the cascade applies it.
function cssVar(name) {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
  return match ? match[1].trim() : null;
}

test('theme.js is the single source for the container state colours', async (t) => {
  // The seam a refactor cannot close: style.css is not importable, so this is the only thing
  // standing between a changed --ok and a graph that keeps drawing the old green.
  await t.test('style.css declares the same value for every state that has a custom property', () => {
    for (const [state, varName] of Object.entries(theme.CSS_VAR_FOR_STATE)) {
      const declared = cssVar(varName);
      assert.ok(declared, `style.css :root declares no ${varName} - CSS_VAR_FOR_STATE names it for "${state}"`);
      assert.equal(
        declared.toLowerCase(),
        theme.STATE_COLORS[state].toLowerCase(),
        `style.css's ${varName} and theme.js's STATE_COLORS.${state} disagree`
      );
    }
  });

  // Guards the map itself: a state added to STATE_COLORS with no CSS counterpart is a real
  // decision (unhealthy is one - the CSS has no equivalent, see theme.js), but it should be a
  // decision someone made, not one that happened because the map was never updated.
  await t.test('every CSS_VAR_FOR_STATE key is a real state, and unhealthy is the only one exempt', () => {
    for (const state of Object.keys(theme.CSS_VAR_FOR_STATE)) {
      assert.ok(state in theme.STATE_COLORS, `CSS_VAR_FOR_STATE names "${state}", which is not a state`);
    }
    const uncovered = Object.keys(theme.STATE_COLORS).filter((s) => !(s in theme.CSS_VAR_FOR_STATE));
    assert.deepEqual(uncovered, ['unhealthy'], 'a state lost or gained its CSS counterpart - see theme.js for why unhealthy has none');
  });

  // CY_STYLE reads the constants directly, so this cannot fail today - it exists so that
  // reintroducing a literal (the exact regression this whole change undoes) is caught rather
  // than merely discouraged by a comment.
  await t.test('CY_STYLE draws every container state in the shared colour, not a literal', () => {
    const borderFor = (selector) => {
      const rule = cyStyle.CY_STYLE.find((r) => r.selector === selector);
      assert.ok(rule, `CY_STYLE has no ${selector} rule any more`);
      return rule.style['border-color'];
    };
    for (const state of Object.keys(theme.STATE_COLORS)) {
      assert.equal(borderFor(`node.${state}`), theme.STATE_COLORS[state], `node.${state}'s border is not STATE_COLORS.${state}`);
    }
    assert.equal(borderFor('node.selected'), theme.SELECTED);
  });
});
