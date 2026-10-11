const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let lj;
before(async () => {
  lj = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logJump.js')));
});

// Built from local fields so the assertions hold in whatever time zone the suite runs in.
const local = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('toLocalInputValue writes the form datetime-local accepts, in local time', () => {
  assert.equal(lj.toLocalInputValue(local(2026, 3, 7, 9, 5, 2)), '2026-03-07T09:05:02');
});

test('parseLocalInputValue', async (t) => {
  await t.test('reads local time, with or without seconds', () => {
    assert.equal(lj.parseLocalInputValue('2026-03-07T09:05:02'), local(2026, 3, 7, 9, 5, 2));
    assert.equal(lj.parseLocalInputValue('2026-03-07T09:05'), local(2026, 3, 7, 9, 5, 0));
  });

  await t.test('round-trips with toLocalInputValue', () => {
    const ms = local(2026, 10, 12, 23, 59, 30);
    assert.equal(lj.parseLocalInputValue(lj.toLocalInputValue(ms)), ms);
  });

  await t.test('refuses an empty, malformed or impossible value rather than rolling it over', () => {
    for (const bad of ['', null, 'yesterday', '2026-03-07', '2026-02-31T10:00', '2026-13-01T10:00']) {
      assert.equal(lj.parseLocalInputValue(bad), null, String(bad));
    }
  });
});

test('jumpError', () => {
  const now = local(2026, 10, 12, 12, 0, 0);
  assert.equal(lj.jumpError(null, now), 'Enter a date and time');
  assert.equal(lj.jumpError(now + 60_000, now), 'That time is in the future');
  assert.equal(lj.jumpError(now - 60_000, now), null);
  assert.equal(lj.jumpError(now, now), null);
});

test('utcOffsetLabel names the offset the picker is in', () => {
  const ms = local(2026, 6, 1, 12, 0, 0);
  const minutes = -new Date(ms).getTimezoneOffset();
  const label = lj.utcOffsetLabel(ms);
  assert.match(label, /^UTC[+-]\d{2}:\d{2}$/);
  const [, sign, h, m] = /^UTC([+-])(\d{2}):(\d{2})$/.exec(label);
  assert.equal((sign === '-' ? -1 : 1) * (Number(h) * 60 + Number(m)), minutes);
});

test('JUMP_PRESETS run from recent to long ago', () => {
  const ms = lj.JUMP_PRESETS.map((p) => p.ms);
  assert.deepEqual(
    ms,
    [...ms].sort((a, b) => a - b)
  );
  assert.ok(lj.JUMP_PRESETS.every((p) => p.label.endsWith(' ago')));
});
