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

// Reads declarations out of one style.css block rather than a browser, which is enough: the
// question is whether the two files agree on a value, not whether the cascade applies it.
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
function cssBlock(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `style.css has no ${selector} block`);
  return css.slice(at, css.indexOf('\n}', at));
}
function cssVar(block, name) {
  const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(block);
  return match ? match[1].trim() : null;
}
const BLOCKS = { dark: ':root', light: ":root[data-theme='light']" };

let svgExport;
before(async () => {
  svgExport = await import(pathToFileURL(path.join(publicDir, 'js', 'graph', 'svgExport.js')));
});

test('theme.js is the single source for the container state colours', async (t) => {
  // The seam a refactor cannot close: style.css is not importable, so this is the only thing
  // standing between a changed --ok and a graph that keeps drawing the old green - in either theme.
  for (const [scheme, selector] of Object.entries(BLOCKS)) {
    await t.test(`style.css's ${scheme} block declares the same value for every state`, () => {
      const block = cssBlock(selector);
      const colors = theme.stateColorsFor(scheme);
      for (const [state, varName] of Object.entries(theme.CSS_VAR_FOR_STATE)) {
        const declared = cssVar(block, varName);
        assert.ok(declared, `${selector} declares no ${varName} - CSS_VAR_FOR_STATE names it for "${state}"`);
        assert.equal(declared.toLowerCase(), colors[state].toLowerCase(), `${scheme}: ${varName} and STATE_COLORS.${state} disagree`);
      }
    });
  }

  // Every state now has a property, since format.js's icons reference them by name. A state with
  // no CSS counterpart would render as an unresolved var() - an invisible icon, not an error.
  await t.test('every state has a CSS property and every property names a real state', () => {
    assert.deepEqual(Object.keys(theme.CSS_VAR_FOR_STATE).sort(), Object.keys(theme.STATE_COLORS).sort());
  });

  // A token the light block forgets silently keeps its dark value, which is how a dark stripe ends
  // up on a light page. Every custom property :root declares must be restated for light.
  await t.test('the light block restates every custom property the dark one declares', () => {
    const names = (block) => [...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    const light = new Set(names(cssBlock(BLOCKS.light)));
    const missing = names(cssBlock(BLOCKS.dark)).filter((n) => !light.has(n));
    assert.deepEqual(missing, [], 'declared for dark but not light');
  });

  // CY_STYLE reads the constants directly, so this cannot fail today - it exists so that
  // reintroducing a literal (the exact regression this whole change undoes) is caught rather
  // than merely discouraged by a comment. Checked for both schemes' stylesheets.
  for (const scheme of Object.keys(BLOCKS)) {
    await t.test(`cyStyleFor('${scheme}') draws every container state in the shared colour`, () => {
      const rules = cyStyle.cyStyleFor(scheme);
      const borderFor = (selector) => {
        const rule = rules.find((r) => r.selector === selector);
        assert.ok(rule, `no ${selector} rule any more`);
        return rule.style['border-color'];
      };
      const colors = theme.stateColorsFor(scheme);
      for (const state of Object.keys(colors)) assert.equal(borderFor(`node.${state}`), colors[state], `node.${state}`);
      assert.equal(borderFor('node.selected'), theme.PALETTES[scheme].accent);
    });
  }

  await t.test('CY_STYLE is the dark stylesheet', () => {
    assert.deepEqual(JSON.stringify(cyStyle.CY_STYLE), JSON.stringify(cyStyle.cyStyleFor('dark')));
  });
});

test('the SVG export is standalone in both schemes', async (t) => {
  const node = {
    kind: 'container',
    x: 100,
    y: 50,
    width: 170,
    height: 100,
    data: { name: 'web', status: 'Up', emoji: '<svg><circle style="stroke:var(--ok)"/></svg>', cpuPerc: 10, memPerc: 20 },
  };
  // The state icon is live-DOM markup carrying var(--ok); a downloaded file has no stylesheet, so
  // an unresolved var() there draws nothing. resolveStateVars has to have turned all of them into hexes.
  for (const scheme of Object.keys(BLOCKS)) {
    await t.test(`${scheme}: no var() survives, and the canvas is that scheme's`, () => {
      const svg = svgExport.renderSvg({ nodes: [node], edges: [] }, { scheme });
      assert.ok(!svg.includes('var('), 'an unresolved CSS variable reached the export');
      assert.ok(svg.includes(theme.stateColorsFor(scheme).running));
      assert.ok(svg.includes(`fill="${cyStyle.graphPalette(scheme).canvas}"`));
    });
  }

  await t.test('resolveStateVars leaves properties it does not own alone', () => {
    assert.equal(theme.resolveStateVars('a var(--seq-mem) b', 'light'), 'a var(--seq-mem) b');
    assert.equal(theme.resolveStateVars('var(--unhealthy)', 'light'), theme.PALETTES.light.states.unhealthy);
  });
});
