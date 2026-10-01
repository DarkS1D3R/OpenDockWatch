const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// A fake localStorage installed before the module is imported - see test/logsPersistence.test.js
// for why load order matters here.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// applyLogTheme writes to document.documentElement - a minimal stub is enough to assert what it wrote.
const setProperties = new Map();
globalThis.document = {
  documentElement: {
    style: {
      setProperty: (name, value) => setProperties.set(name, value),
    },
    setAttribute: (name, value) => setProperties.set(name, value),
  },
};

let logTheme;
before(async () => {
  logTheme = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logTheme.js')));
});

test('isValidLogColor', () => {
  for (const value of ['#fff', '#ffff', '#0d0e11', '#0d0e11ff']) {
    assert.equal(logTheme.isValidLogColor(value), true, `${value} should be valid`);
  }
  for (const value of [null, undefined, 42, '', 'red', 'rgb(0,0,0)', '#ggg', '#0d0e1', '#0d0e111']) {
    assert.equal(logTheme.isValidLogColor(value), false, `${JSON.stringify(value)} should be invalid`);
  }
});

// Hand-editable storage feeding a CSS custom property - same discipline as logsPersistence.js's
// normalizeOpenPanes: every case here is about what a malformed field must NOT reach applyLogTheme as.
test('normalizeLogTheme', async (t) => {
  await t.test('passes a well-formed entry through unchanged', () => {
    assert.deepEqual(logTheme.normalizeLogTheme({ bg: '#111111', text: '#eeeeee' }), { bg: '#111111', text: '#eeeeee' });
  });

  // <input type="color"> shows anything but lowercase #rrggbb as black, so the picker would disagree
  // with the colour actually applied.
  await t.test('short, alpha and upper-case hex are canonicalised to lowercase #rrggbb', () => {
    assert.deepEqual(logTheme.normalizeLogTheme({ bg: '#FFF', text: '#0d0e11CC' }), { bg: '#ffffff', text: '#0d0e11' });
    assert.deepEqual(logTheme.normalizeLogTheme({ bg: ' #1a2B ', text: '#ABCDEF' }), { bg: '#11aa22', text: '#abcdef' });
  });

  await t.test('anything that is not an object falls back to the default entirely', () => {
    for (const raw of [null, undefined, 'nope', 42, true]) {
      assert.deepEqual(logTheme.normalizeLogTheme(raw), logTheme.DEFAULT_LOG_THEME, `${JSON.stringify(raw)} should fall back`);
    }
  });

  await t.test('each field falls back independently rather than the whole entry being discarded', () => {
    const out = logTheme.normalizeLogTheme({ bg: '#123456', text: 'not-a-color' });
    assert.equal(out.bg, '#123456');
    assert.equal(out.text, logTheme.DEFAULT_LOG_THEME.text);
  });

  await t.test('a missing field falls back to the default for that field', () => {
    assert.deepEqual(logTheme.normalizeLogTheme({}), logTheme.DEFAULT_LOG_THEME);
  });
});

test('loadLogTheme / saveLogTheme', async (t) => {
  await t.test('a saved theme round-trips', () => {
    store.clear();
    logTheme.saveLogTheme({ bg: '#222222', text: '#dddddd' });
    assert.deepEqual(logTheme.loadLogTheme(), { bg: '#222222', text: '#dddddd' });
  });

  await t.test('nothing saved loads as the default', () => {
    store.clear();
    assert.deepEqual(logTheme.loadLogTheme(), logTheme.DEFAULT_LOG_THEME);
  });

  await t.test('corrupt JSON loads as the default rather than throwing into the component', () => {
    store.clear();
    store.set('odw:logTheme', '{not json');
    assert.deepEqual(logTheme.loadLogTheme(), logTheme.DEFAULT_LOG_THEME);
  });

  await t.test('a hand-edited entry is normalized on read, not trusted', () => {
    store.clear();
    store.set('odw:logTheme', JSON.stringify({ bg: 'javascript:alert(1)', text: '#ffffff' }));
    const out = logTheme.loadLogTheme();
    assert.equal(out.bg, logTheme.DEFAULT_LOG_THEME.bg);
    assert.equal(out.text, '#ffffff');
  });

  await t.test('saveLogTheme returns the normalized value it actually persisted', () => {
    store.clear();
    const out = logTheme.saveLogTheme({ bg: '#123', text: 'nope' });
    assert.deepEqual(out, { bg: '#112233', text: logTheme.DEFAULT_LOG_THEME.text });
    assert.deepEqual(logTheme.loadLogTheme(), out);
  });

  // Private browsing and a full quota both throw from localStorage - the pane still has to render.
  await t.test('a throwing localStorage degrades to the default rather than an error', () => {
    const real = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    try {
      assert.doesNotThrow(() => logTheme.saveLogTheme({ bg: '#111111', text: '#eeeeee' }));
      assert.deepEqual(logTheme.loadLogTheme(), logTheme.DEFAULT_LOG_THEME);
    } finally {
      globalThis.localStorage = real;
    }
  });
});

test('logSchemeFor', () => {
  for (const p of logTheme.LOG_THEME_PRESETS) {
    assert.equal(logTheme.logSchemeFor(p.bg), p.id === 'paper' ? 'light' : 'dark', p.id);
  }
  // The short and alpha hex forms isValidLogColor lets through must classify too.
  assert.equal(logTheme.logSchemeFor('#fff'), 'light');
  assert.equal(logTheme.logSchemeFor('#000f'), 'dark');
  assert.equal(logTheme.logSchemeFor('#f5f5f0ff'), 'light');
});

test('applyLogTheme marks a light background so ANSI colours can be darkened', () => {
  setProperties.clear();
  logTheme.applyLogTheme({ bg: '#f5f5f0', text: '#1b1b1b' });
  assert.equal(setProperties.get('data-log-scheme'), 'light');
});

test('applyLogTheme', () => {
  setProperties.clear();
  const out = logTheme.applyLogTheme({ bg: '#101010', text: '#f0f0f0' });
  assert.equal(setProperties.get('--log-bg'), '#101010');
  assert.equal(setProperties.get('--log-text'), '#f0f0f0');
  assert.equal(setProperties.get('data-log-scheme'), 'dark');
  assert.deepEqual(out, { bg: '#101010', text: '#f0f0f0' });
});
