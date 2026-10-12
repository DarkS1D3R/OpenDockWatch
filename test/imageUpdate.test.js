const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let iu;
before(async () => {
  iu = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'imageUpdate.js')));
});

test('imageUpdateText', async (t) => {
  await t.test('never checked is null, not "up to date"', () => {
    assert.equal(iu.imageUpdateText(null), null);
  });
  await t.test('outdated and current', () => {
    assert.deepEqual(iu.imageUpdateText({ status: 'outdated' }), { text: 'Newer image available', tone: 'update' });
    assert.deepEqual(iu.imageUpdateText({ status: 'current' }), { text: 'Up to date', tone: 'ok' });
  });
  await t.test('every reason the server can give has its own wording', () => {
    for (const reason of ['not_found', 'pinned', 'no_tag', 'no_local_digest', 'rate_limited', 'local_registry']) {
      const { text, tone } = iu.imageUpdateText({ status: 'unknown', reason });
      assert.equal(tone, 'muted');
      assert.ok(!text.startsWith('Could not check'), `${reason} fell through to the generic message`);
    }
  });
  await t.test('anything else shows the server message', () => {
    assert.equal(
      iu.imageUpdateText({ status: 'unknown', reason: 'error', message: 'registry unreachable: ENOTFOUND' }).text,
      'Could not check: registry unreachable: ENOTFOUND'
    );
  });
});

test('checkedAgo and shortDigest', () => {
  const now = 10 * 3_600_000;
  assert.equal(iu.checkedAgo({ checkedAt: now - 5_000 }, now), 'checked just now');
  assert.equal(iu.checkedAgo({ checkedAt: now - 2 * 3_600_000 }, now), 'checked 2h ago');
  assert.equal(iu.checkedAgo(null, now), null);
  assert.equal(iu.shortDigest('sha256:' + 'a'.repeat(64)), 'sha256:aaaaaaaaaaaa');
  assert.equal(iu.shortDigest(null), '');
});
