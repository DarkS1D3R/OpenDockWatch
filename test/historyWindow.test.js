const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let hw;
test.before(async () => {
  hw = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'historyWindow.js')));
});

const HOUR = 3_600_000;
const B = 15_000;

test('panUntil', async (t) => {
  // 10:00:07 - deliberately not on a bucket boundary, the way a real clock almost never is.
  const now = Date.UTC(2026, 10, 1, 10, 0, 7);

  await t.test('the first step back ends one window before the current bucket ends', () => {
    const until = hw.panUntil(null, -1, HOUR, B, now);
    assert.equal(until, Math.ceil(now / B) * B - HOUR);
    assert.equal(until % B, 0, 'pages must land on bucket boundaries so they tile exactly');
  });

  await t.test('steps are one whole window, back and forward', () => {
    const one = hw.panUntil(null, -1, HOUR, B, now);
    const two = hw.panUntil(one, -1, HOUR, B, now);
    assert.equal(one - two, HOUR);
    assert.equal(hw.panUntil(two, 1, HOUR, B, now), one);
  });

  await t.test('stepping forward into the present returns to live', () => {
    const one = hw.panUntil(null, -1, HOUR, B, now);
    assert.equal(hw.panUntil(one, 1, HOUR, B, now), null);
    assert.equal(hw.panUntil(null, 1, HOUR, B, now), null, 'forward from live stays live');
  });

  await t.test('returns live without a window to step by', () => {
    assert.equal(hw.panUntil(null, -1, 0, B, now), null);
    assert.equal(hw.panUntil(null, -1, HOUR, 0, now), null);
  });
});

test('windowAnchorTs', async (t) => {
  await t.test('is the last bucket before an exclusive end', () => {
    assert.equal(hw.windowAnchorTs(60_000, B), 45_000);
  });

  await t.test('is null for a live window, which anchors on its data instead', () => {
    assert.equal(hw.windowAnchorTs(null, B), null);
  });
});

test('windowLabel', async (t) => {
  await t.test('reads "Last <range>" for a live window', () => {
    assert.equal(hw.windowLabel(null, HOUR, '1h'), 'Last 1h');
  });

  await t.test('names the day once when the window sits inside one day', () => {
    const until = new Date(2026, 10, 1, 10, 0).getTime();
    const label = hw.windowLabel(until, HOUR, '1h', 'en-GB');
    assert.equal(label, '09:00 – 10:00, 1 Nov');
  });

  await t.test('names both days when the window crosses midnight', () => {
    const until = new Date(2026, 10, 2, 1, 0).getTime();
    const label = hw.windowLabel(until, 2 * HOUR, '24h', 'en-GB');
    assert.match(label, /1 Nov.*– .*2 Nov/);
  });
});
