const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let hc;
before(async () => {
  hc = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'healthcheck.js')));
});

const base = { status: 'healthy', failingStreak: 0, intervalMs: 30_000, timeoutMs: 5000, startPeriodMs: 0, retries: 3, log: [] };

test('shortDuration', async (t) => {
  await t.test('milliseconds, seconds, minutes and hours', () => {
    assert.equal(hc.shortDuration(52), '52ms');
    assert.equal(hc.shortDuration(5000), '5s');
    assert.equal(hc.shortDuration(90_000), '1m 30s');
    assert.equal(hc.shortDuration(120_000), '2m');
    assert.equal(hc.shortDuration(3_900_000), '1h 5m');
  });

  await t.test('a missing or negative value is a dash', () => {
    assert.equal(hc.shortDuration(null), '—');
    assert.equal(hc.shortDuration(-1), '—');
    assert.equal(hc.shortDuration(NaN), '—');
  });
});

test('healthcheckSummary', async (t) => {
  await t.test('null when there is no healthcheck', () => {
    assert.equal(hc.healthcheckSummary(null), null);
  });

  await t.test('passing, failing and starting', () => {
    assert.deepEqual(hc.healthcheckSummary(base), { text: 'Passing', tone: 'ok' });
    assert.deepEqual(hc.healthcheckSummary({ ...base, status: 'unhealthy', failingStreak: 4 }), {
      text: 'Failing - 4 checks failed in a row',
      tone: 'bad',
    });
    assert.deepEqual(hc.healthcheckSummary({ ...base, status: 'starting' }), { text: 'Starting', tone: 'warn' });
  });

  // Still healthy until the streak reaches retries - worth flagging before it flips.
  await t.test('healthy with a failing streak is a warning, worded for one failure', () => {
    assert.deepEqual(hc.healthcheckSummary({ ...base, failingStreak: 1 }), { text: 'Passing, but last check failed', tone: 'warn' });
  });

  await t.test('no status yet', () => {
    assert.equal(hc.healthcheckSummary({ ...base, status: null }).tone, 'muted');
  });
});

test('healthcheckSchedule', async (t) => {
  await t.test('interval, timeout and retries', () => {
    assert.equal(hc.healthcheckSchedule(base), 'Every 30s, 5s timeout, unhealthy after 3 failures');
  });

  await t.test('a start period is mentioned only when set, and one retry is singular', () => {
    assert.equal(
      hc.healthcheckSchedule({ ...base, retries: 1, startPeriodMs: 10_000 }),
      'Every 30s, 5s timeout, unhealthy after 1 failure, 10s grace at start'
    );
  });
});

test('checkResult', async (t) => {
  await t.test('exit 0 passed, anything else failed with its code', () => {
    assert.deepEqual(hc.checkResult({ exitCode: 0, output: '' }), { text: 'Passed', tone: 'ok' });
    assert.deepEqual(hc.checkResult({ exitCode: 1, output: 'curl: (7) Failed to connect' }), { text: 'Failed (exit 1)', tone: 'bad' });
  });

  await t.test("docker's timeout is called a timeout", () => {
    assert.equal(hc.checkResult({ exitCode: -1, output: 'Health check exceeded timeout (5s)' }).text, 'Timed out');
  });
});

test('checkRunTime and checkAgo', async (t) => {
  const entry = { start: '2026-10-12T00:05:20.862747223+02:00', end: '2026-10-12T00:05:20.915959721+02:00' };

  await t.test("reads docker's nanosecond timestamps", () => {
    assert.equal(hc.checkRunTime(entry), '53ms');
  });

  await t.test('time since the check started', () => {
    const start = Date.parse(entry.start);
    assert.equal(hc.checkAgo(entry, start + 12_000), '12s ago');
    assert.equal(hc.checkAgo(entry, start + 200), 'just now');
  });

  await t.test('an unreadable timestamp is a dash or empty, never NaN', () => {
    assert.equal(hc.checkRunTime({ start: 'x', end: 'y' }), '—');
    assert.equal(hc.checkAgo({ start: 'x' }), '');
  });
});
