# CLAUDE.md — public/

Rules for changing `public/**`. Each rule below is a must-keep, and many are test-enforced. The reasons behind them, with measurements, are in [`docs/architecture/frontend.md`](../docs/architecture/frontend.md). Read the matching section there before you change a component's behaviour, and before you "simplify" anything that looks odd. For commands and repo-wide conventions, see the [root CLAUDE.md](../CLAUDE.md). This file stays out of the image through `.dockerignore`, because `/assets` is unauthenticated.

## Shape

- There is no build step. Vue 3 uses the Options API with `template` strings compiled in the browser, loaded as native ES modules. Vendor libraries (Vue, Cytoscape, dagre, html2canvas-pro, cytoscape-expand-collapse) are checked into `public/vendor/` as global scripts.
- `js/app.js` is the root: session, host selection, the poll loop, shared state and `doAction`. Views live in `js/components/`. `js/graph.js` plus `js/graph/` own everything Cytoscape (only `FlowView` imports it). `js/api.js` is the only place `fetch` is called.
- `js/lib/` holds pure logic. **Pure logic belongs there and gets a `node --test` test** (load it with dynamic `import()`). Components are only syntax-checked.

## Connection budget and polling

- The browser allows ~6 connections per origin, and the SSE streams hold some open. A stream runs only in the view that owns it: the detail panel in List/Flow, panes in the Logs tab, the event stream in Activity. The worst case is 4 streams. Raising `MAX_OPEN_LOG_PANES` spends the margin left for the poll loop.
- Poll loops use a chained `setTimeout`, never `setInterval`. They back off on failure and stop while the tab is hidden. A view that polls on its own (Hosts, Resources) follows the same rules.
- Every request goes through `api.js` (timeouts, redirect on 401). `reportClientError` deliberately bypasses `apiFetch`, and its client-side caps are what bound it.

## Components

- Transient panels that own a stream or fetch mount with `v-if` and own their lifecycle. `ContainerList`/`FlowView` stay mounted with `v-show`.
- Shared state lives in the root and flows down as props, with events back up. Watch `container.id`, not `container`: the root replaces `containers` wholesale every poll.
- Register child components locally in the parent (`components: { ... }`). Registering on the root is not global.
- Per-line or per-row work happens once at append (`logLines.js`'s `decorateLine`) or in a computed, never in a method called from `v-for`.
- Values read back from `localStorage`/`sessionStorage` are validated on the way out (`normalize*` functions), not just parsed.
- A user-controlled key (a docker label, for example) is looked up with `Object.hasOwn`, never `obj[key]`. That is why `logoFor` exists.

## Log viewer

- The search cursor is a line **id**, never an index: the buffer trims from the front.
- `highlightLine` matches against raw text and escapes each piece on the way out, never the other way round.
- Every scroll the pane makes itself goes through `scrollWithoutBroadcast`, or synced panes ping-pong.
- Nothing but log lines goes inside the `<pre>`. `visibleTopTsMs`/`scrollToTimestamp` index into `el.children`.
- The header breakpoints and the List view's Actions/`nth-child` widths were measured. If you add a control, re-measure; don't eyeball. Don't add List columns, because that renumbers every `nth-child` width.

## Theme and colour

- State colours live only in `js/theme.js` (one palette per theme), and CSS custom properties live in `style.css`. The live DOM uses `var(--x)` through `style="..."`, never an SVG presentation attribute. The SVG export resolves vars itself (`resolveStateVars`).
- The light `:root[data-theme='light']` block must restate every property `:root` declares (enforced by `test/theme.test.js`).
- Cytoscape can't read CSS variables, so its colours come from `cyStyleFor(scheme)` in `graph/style.js`.
- `theme-boot.js` is a classic `<head>` script that restates the storage key, and it is tested against `resolveScheme`.
- Chart colours are a validated categorical set. Re-validate them with the `dataviz` skill; don't eyeball.

## Flow graph

- A container's state class comes from `CONTAINER_STATE_CLASSES`. Every "any container" selector derives from it; never spell the states out.
- Tree-mode pill labels wrap through `wrapPillLabel` with `height: 'label'`, never a fixed height. Never wrap the `id`, and filter on the unwrapped `search` field.
- The `nodeHtmlLabel` templates escape `name`/`status`/`label`.

## Security and accessibility

- Logs reach the DOM through `v-html`, so no inline scripts or handlers: put scripts in files (CSP has no `'unsafe-inline'`).
- `test/a11y.test.js` enforces four rules. A clickable non-button needs role, tabindex and keydown. A symbol-only button needs `aria-label`. An `active` button needs `aria-pressed`/`aria-current`/`aria-expanded`. Every field needs a label. Hide `.btn-label` visually, never with `display:none`. Mouse-only exemptions go in `CLICK_EXEMPT` with their keyboard route.

## Generated and mirrored code

- `js/lib/logos.js` is generated by `npm run build:logos` from the slugs in `scripts/build-logos.js`. Don't hand-edit it. In `SERVICE_BADGES`, the first matching pattern wins, so specific entries sit above generic ones.
- Constants mirrored from the server (`ALERT_RULES`, `VIEWS`, `HISTORY_RANGE_BUCKET_MS`) are checked by `test/sharedConstants.test.js`.
