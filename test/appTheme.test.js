const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const publicDir = path.join(__dirname, '..', 'public');

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
}

// Just enough of a document for applyAppTheme: one attribute and a record of dispatched events.
function fakeDoc(initialTheme = null) {
  const attrs = new Map(initialTheme ? [['data-theme', initialTheme]] : []);
  const events = [];
  return {
    events,
    documentElement: {
      getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
      setAttribute: (n, v) => attrs.set(n, v),
    },
    dispatchEvent: (e) => events.push(e),
  };
}

let appTheme;
before(async () => {
  appTheme = await import(pathToFileURL(path.join(publicDir, 'js', 'lib', 'appTheme.js')));
});

test('normalizeAppTheme keeps the three choices and defaults everything else to dark', () => {
  for (const id of ['dark', 'light', 'system']) assert.equal(appTheme.normalizeAppTheme(id), id);
  for (const raw of [null, undefined, '', 'Light', 'blue', 1, {}, '__proto__']) {
    assert.equal(appTheme.normalizeAppTheme(raw), 'dark', JSON.stringify(raw));
  }
});

test('resolveScheme follows the system only when asked to', () => {
  assert.equal(appTheme.resolveScheme('dark', true), 'dark');
  assert.equal(appTheme.resolveScheme('light', false), 'light');
  assert.equal(appTheme.resolveScheme('system', true), 'light');
  assert.equal(appTheme.resolveScheme('system', false), 'dark');
  assert.equal(appTheme.resolveScheme('garbage', true), 'dark');
});

test('loadAppTheme / saveAppTheme', async (t) => {
  await t.test('round-trips a choice', () => {
    const storage = memoryStorage();
    assert.equal(appTheme.saveAppTheme('light', storage), 'light');
    assert.equal(appTheme.loadAppTheme(storage), 'light');
  });
  await t.test('a hand-edited value reads back as the default', () => {
    assert.equal(appTheme.loadAppTheme(memoryStorage({ 'odw:appTheme': 'neon' })), 'dark');
  });
  await t.test('storage that throws degrades rather than breaking the page', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('full');
      },
    };
    assert.equal(appTheme.loadAppTheme(broken), 'dark');
    assert.equal(appTheme.saveAppTheme('light', broken), 'light');
  });
});

test('applyAppTheme sets data-theme and announces only a real change', () => {
  const doc = fakeDoc('dark');
  assert.equal(appTheme.applyAppTheme('dark', doc), 'dark');
  assert.equal(doc.events.length, 0, 'no change, so the graph must not rebuild its stylesheet');
  assert.equal(appTheme.applyAppTheme('light', doc), 'light');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].type, appTheme.APP_THEME_CHANGE_EVENT);
  assert.equal(doc.events[0].detail.scheme, 'light');
  assert.equal(appTheme.currentScheme(doc), 'light');
});

// theme-boot.js is a classic script that cannot import appTheme.js, so it restates the storage key
// and the resolution rule. Run it in a sandbox for every stored value x system preference and hold
// it to resolveScheme: a disagreement is a flash of the wrong theme on every load.
test('theme-boot.js resolves exactly what resolveScheme does', () => {
  const source = fs.readFileSync(path.join(publicDir, 'js', 'theme-boot.js'), 'utf8');
  for (const stored of [null, 'dark', 'light', 'system', 'neon']) {
    for (const prefersLight of [true, false]) {
      const doc = fakeDoc();
      const storage = memoryStorage(stored === null ? {} : { [appTheme.APP_THEME_STORAGE_KEY]: stored });
      const matchMedia = (q) => ({ matches: q === '(prefers-color-scheme: light)' && prefersLight });
      vm.runInNewContext(source, { document: doc, localStorage: storage, window: { matchMedia } });
      assert.equal(
        doc.documentElement.getAttribute('data-theme'),
        appTheme.resolveScheme(stored, prefersLight),
        `stored=${stored} prefersLight=${prefersLight}`
      );
    }
  }
});
