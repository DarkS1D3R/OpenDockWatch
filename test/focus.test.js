const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let focus;
before(async () => {
  focus = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'focus.js')));
});

test('nextTrapTarget', async (t) => {
  const [a, b, c] = ['first', 'middle', 'last'];
  const items = [a, b, c];

  await t.test('Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last', () => {
    assert.equal(focus.nextTrapTarget(items, c, false), a);
    assert.equal(focus.nextTrapTarget(items, a, true), c);
  });

  await t.test('anywhere in between, the browser moves focus as normal', () => {
    assert.equal(focus.nextTrapTarget(items, b, false), null);
    assert.equal(focus.nextTrapTarget(items, b, true), null);
    assert.equal(focus.nextTrapTarget(items, a, false), null);
  });

  await t.test('focus that has escaped the dialog is pulled back in at the matching end', () => {
    assert.equal(focus.nextTrapTarget(items, 'page-behind', false), a);
    assert.equal(focus.nextTrapTarget(items, 'page-behind', true), c);
  });

  await t.test('a dialog with nothing focusable leaves Tab alone', () => {
    assert.equal(focus.nextTrapTarget([], a, false), null);
  });

  await t.test('a single control keeps focus on itself both ways', () => {
    assert.equal(focus.nextTrapTarget([a], a, false), a);
    assert.equal(focus.nextTrapTarget([a], a, true), a);
  });
});
