const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let duration;
before(async () => {
  duration = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'duration.js')));
});

test('formatDuration', async (t) => {
  await t.test('null/undefined/NaN/negative all render the same "no data" dash', () => {
    for (const v of [null, undefined, NaN, -1]) assert.equal(duration.formatDuration(v), '—');
  });

  await t.test('under a minute renders as "<1m" rather than "0m"', () => {
    assert.equal(duration.formatDuration(20_000), '<1m');
  });

  await t.test('zero renders as "0m", distinct from "no data"', () => {
    assert.equal(duration.formatDuration(0), '0m');
  });

  await t.test('minutes and hours combine, without days', () => {
    assert.equal(duration.formatDuration(90 * 60_000), '1h 30m');
  });

  await t.test('days drop the minutes component', () => {
    assert.equal(duration.formatDuration(2 * 86_400_000 + 90 * 60_000), '2d 1h');
  });

  await t.test('a day with no leftover hours omits them', () => {
    assert.equal(duration.formatDuration(86_400_000), '1d');
  });
});

test('formatPercent', async (t) => {
  await t.test('null/undefined/NaN render as a dash, not "NaN%"', () => {
    for (const v of [null, undefined, NaN]) assert.equal(duration.formatPercent(v), '—');
  });

  await t.test('rounds to one decimal by default', () => {
    assert.equal(duration.formatPercent(99.96527777), '100.0%');
  });

  await t.test('digits is respected', () => {
    assert.equal(duration.formatPercent(50, 0), '50%');
  });
});
