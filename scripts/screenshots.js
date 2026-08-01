// Retakes the README/DOCKERHUB screenshot set (scripts/demo-stack.sh up --isolated, then
// SCREENSHOT_PASS=... npm run screenshots). Point it at an instance watching the demo stack, not
// real infrastructure - it refuses to shoot a host whose containers aren't the demo ones.
const path = require('path');
const { chromium } = require('playwright');

const URL = process.env.SCREENSHOT_URL || 'http://localhost:3100';
const USER = process.env.SCREENSHOT_USER || 'demo';
const PASS = process.env.SCREENSHOT_PASS;
const OUT = process.env.SCREENSHOT_OUT || path.join(__dirname, '..', 'screenshots');
const WARM_MS = Number(process.env.SCREENSHOT_WARM_MS || 135_000);
const SCALE = Number(process.env.SCREENSHOT_SCALE || 1);

// 1920x1300. Wide because the details panel is a fixed 520px and at 1600 it squeezed the table
// behind it until every container name rendered as "demo-sho…"; tall because the flow canvas is a
// fixed 560px under a ~470px host card, and the metrics modal stacks four ~270px charts.
const VIEWPORT = { width: 1920, height: 1300 };

async function main() {
  if (!PASS) {
    console.error('SCREENSHOT_PASS is required (the plaintext password behind AUTH_PASS_HASH)');
    process.exit(2);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Views differ a lot in height (list grows with container count, flow canvas is fixed), so one
  // viewport either crops or leaves empty space. Overlay shots (modal, log panel, fullscreen) are
  // sized off the viewport itself, so they opt out and keep the tall default.
  const fitViewport = async () => {
    const h = await page.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(Math.max(h, 700), 2200) });
    await page.waitForTimeout(700);
  };

  const shot = async (name, { fitHeight = true } = {}) => {
    if (fitHeight) await fitViewport();
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const size = page.viewportSize();
    console.log(`  ${name}.png (${size.width}x${size.height} @${SCALE}x)`);
    if (fitHeight) await page.setViewportSize(VIEWPORT);
  };

  const btn = (text) => page.locator('button', { hasText: text }).first();
  const fit = async () => {
    await btn('Fit').click();
    await page.waitForTimeout(1200);
  };
  const toggleFullscreen = async () => {
    await page.locator('button', { hasText: 'Fullscreen' }).last().click();
    await page.waitForTimeout(1500);
  };
  // Selection is a toggle, and the Flow view selects too - so anything wanting a clean slate has
  // to close the panel rather than assume nothing is selected.
  const clearSelection = async () => {
    const close = page.locator('.detail-panel .detail-header button');
    if (await close.count()) {
      await close.first().click();
      await page.waitForTimeout(800);
    }
  };

  console.log(`logging in to ${URL}`);
  await page.goto(`${URL}/login`);
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button');
  await page.waitForURL(`${URL}/`, { timeout: 15_000 });
  await page.waitForSelector('table.containers tbody tr');

  const names = await page.locator('table.containers tbody td:nth-child(1)').allTextContents();
  if (!names.some((n) => n.trim().startsWith('demo-'))) {
    console.error('This instance is not watching the demo stack - refusing to shoot real containers.');
    console.error(`Saw: ${names.map((n) => n.trim()).join(', ')}`);
    console.error('Run scripts/demo-stack.sh up --isolated and point OpenDockWatch at that daemon.');
    await browser.close();
    process.exit(1);
  }

  // The row sparklines come from a client-side buffer that starts empty on load and fills over
  // ~2 minutes. The host card's 30-minute chart is server-persisted, so it survives the reload.
  console.log(`warming the row sparkline buffer (${Math.round(WARM_MS / 1000)}s)`);
  await page.waitForTimeout(WARM_MS);

  console.log('list view');
  await page.waitForSelector('.mini-spark-svg');
  await shot('list-view');

  console.log('container metrics modal');
  const apiRow = page.locator('table.containers tbody tr', { hasText: 'demo-shop-api' }).first();
  await apiRow.locator('.mini-spark-btn').first().click();
  await page.waitForSelector('.metrics-modal');
  await page.waitForTimeout(4000);
  const box = await page.locator('.metrics-modal .sparkline').first().boundingBox();
  // Park the crosshair mid-chart, so the shot shows the shared hover rather than a static chart.
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.5);
  await page.waitForTimeout(700);
  await shot('container-metrics', { fitHeight: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  console.log('flow view');
  await page.locator('.view-toggle button', { hasText: 'Flow' }).first().click();
  await page.waitForTimeout(4500);
  // Below COMPACT_ZOOM_THRESHOLD the nodes deliberately drop to a state/icon/name rendering, which
  // would hide the CPU/RAM bars this shot is meant to show. Fullscreen gives the canvas the
  // viewport height so Fit lands above that threshold.
  await toggleFullscreen();
  await fit();
  let compact = await page.locator('.cy-node-box-compact').count();
  for (let i = 0; i < 4 && compact > 0; i++) {
    await btn('Zoom in').click();
    await page.waitForTimeout(800);
    compact = await page.locator('.cy-node-box-compact').count();
  }
  if (compact > 0) console.log(`  warning: ${compact} nodes still compact - their metrics bars won't show`);
  await shot('flow-view', { fitHeight: false });
  await toggleFullscreen();

  console.log('blast radius');
  const apiName = page.locator('.cy-node-name', { hasText: 'demo-shop-api' }).first();
  await apiName.waitFor({ timeout: 10_000 });
  const nb = await apiName.boundingBox();
  // The node's content is a node-html-label DOM overlay, but cytoscape listens on the canvas
  // underneath - so locate the overlay for coordinates and let the click fall through to it.
  await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await page.waitForTimeout(1500);
  // Selecting opens the details panel, taking 520px off the canvas - refit, or the graph stays
  // framed for a width it no longer has.
  await fit();
  await shot('flow-blast-radius');

  console.log('collapsed groups');
  await clearSelection();
  await btn('Collapse all').click();
  await page.waitForTimeout(2000);
  await fit();
  await shot('flow-collapsed');
  await btn('Expand all').click();
  await page.waitForTimeout(1500);

  console.log('tree mode');
  await btn('Tree').click();
  await page.waitForTimeout(3000);
  // Tree mode stacks every container vertically, so in the inline canvas Fit zooms out until the
  // labels are unreadable.
  await toggleFullscreen();
  await fit();
  await shot('flow-tree-view', { fitHeight: false });
  await toggleFullscreen();
  await btn('Graph').click();
  await page.waitForTimeout(1200);

  console.log('logs tab');
  await page.locator('.view-toggle button', { hasText: 'Logs' }).first().click();
  await page.waitForTimeout(1200);
  await page.locator('.logs-tab-row', { hasText: 'demo-shop-api' }).first().click();
  await page.waitForTimeout(3000);
  await shot('logs-tab', { fitHeight: false });

  console.log('details panel');
  await clearSelection();
  await page.locator('.view-toggle button', { hasText: 'List' }).first().click();
  await page.waitForTimeout(1500);
  // The name cell, not the row centre - the centre is the sparkline button, which stops
  // propagation and opens the metrics modal instead of selecting.
  await page.locator('table.containers tbody tr', { hasText: 'demo-shop-api' }).first().locator('td').first().click();
  await page.waitForSelector('.detail-panel');
  await page.waitForTimeout(4000);
  // The caption promises expanded environment/labels sections, so expand them.
  for (const label of ['Environment', 'Labels']) {
    const d = page.locator('.detail-panel details', { hasText: label }).first();
    if (await d.count()) await d.locator('summary').click();
    await page.waitForTimeout(500);
  }
  // The panel is fixed to the viewport height, so it would be cropped by a fit-to-content resize.
  await shot('details-panel', { fitHeight: false });

  console.log('log viewer');
  await page.locator('.detail-panel button', { hasText: 'Log Viewer' }).first().click();
  await page.waitForSelector('.log-panel');
  await page.waitForTimeout(7000);
  await page.locator('.log-panel .log-filter-input-wrap input').fill('ERROR|WARN');
  await page.locator('.regex-toggle-btn').click();
  await page.waitForTimeout(2500);
  await shot('log-viewer', { fitHeight: false });
  await page.locator('.log-panel button', { hasText: 'Close' }).first().click();
  await page.waitForTimeout(600);

  console.log('activity view');
  // Otherwise the panel is still open from the details shot, squeezing the two columns this view
  // exists to show side by side.
  await clearSelection();
  await page.locator('.view-toggle button', { hasText: 'Activity' }).first().click();
  await page.waitForTimeout(3000);
  // The caption promises an acknowledged alert and a filtered event log, so produce both.
  const ack = page.locator('.alert-row button', { hasText: 'Acknowledge' }).first();
  if (await ack.count()) {
    await ack.click();
    await page.waitForTimeout(1200);
  }
  await page.locator('input[placeholder="Search events…"]').fill('demo-shop-cache');
  await page.waitForTimeout(1200);
  await shot('activity-view');

  await browser.close();

  if (errors.length) {
    console.error(`\npage errors:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\ndone - review every shot before committing; they are the project shop window.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
