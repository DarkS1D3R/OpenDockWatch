const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// A fake sessionStorage installed before the module is imported - it reads the global at call
// time, but a test that imported first would still be relying on load order, and this is cheaper
// than finding out. Throwing variants below replace it per test. `length`/`key(i)` are here
// because clearAllOpenPanes walks the store by index, which is the part with an ordering trap.
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

let persistence;
before(async () => {
  persistence = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logsPersistence.js')));
});

// This is hand-editable storage that decides which log streams get opened, so every case here is
// about what a malformed entry must NOT be able to do to the tab. See CLAUDE.md.
test('normalizeOpenPanes', async (t) => {
  const full = { viewMode: 'multi', openIds: ['a', 'b'], disabledSyncIds: ['b'], mainId: 'a' };

  await t.test('passes a well-formed entry through unchanged', () => {
    assert.deepEqual(persistence.normalizeOpenPanes(full), full);
  });

  await t.test('returns null for anything that is not an object', () => {
    for (const raw of [null, undefined, 'nope', 42, true]) {
      assert.equal(persistence.normalizeOpenPanes(raw), null, `${JSON.stringify(raw)} should not normalize`);
    }
  });

  await t.test('an unknown view mode falls back to multi rather than reaching the component', () => {
    assert.equal(persistence.normalizeOpenPanes({ viewMode: 'grid' }).viewMode, 'multi');
    assert.equal(persistence.normalizeOpenPanes({}).viewMode, 'multi');
  });

  await t.test('non-string and empty ids are dropped', () => {
    assert.deepEqual(persistence.normalizeOpenPanes({ openIds: ['a', 42, null, '', { id: 'b' }, 'c'] }).openIds, ['a', 'c']);
  });

  await t.test('openIds that is not an array becomes empty rather than throwing', () => {
    assert.deepEqual(persistence.normalizeOpenPanes({ openIds: 'a,b' }).openIds, []);
  });

  await t.test('duplicates collapse, so one container cannot open two panes for itself', () => {
    assert.deepEqual(persistence.normalizeOpenPanes({ openIds: ['a', 'a', 'b', 'a'] }).openIds, ['a', 'b']);
  });

  // The one invariant here whose cost is more than a confusing screen: each pane is a long-lived
  // EventSource, and a browser allows about six per origin.
  await t.test('multi mode caps at MAX_OPEN_LOG_PANES, however many were stored', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.deepEqual(persistence.normalizeOpenPanes({ viewMode: 'multi', openIds: ids }).openIds, ['a', 'b', 'c', 'd']);
  });

  await t.test('single mode keeps exactly one pane', () => {
    assert.deepEqual(persistence.normalizeOpenPanes({ viewMode: 'single', openIds: ['a', 'b', 'c'] }).openIds, ['a']);
  });

  // A main id naming a pane that is not open puts the group in leader-follower mode with no leader
  // on screen: every pane's scroll is ignored and nothing drives the group at all.
  await t.test('a main id that names no open pane is dropped', () => {
    assert.equal(persistence.normalizeOpenPanes({ openIds: ['a'], mainId: 'zzz' }).mainId, null);
    assert.equal(persistence.normalizeOpenPanes({ openIds: ['a'], mainId: 'a' }).mainId, 'a');
  });

  await t.test('a main id trimmed away by the cap goes with it', () => {
    const out = persistence.normalizeOpenPanes({ viewMode: 'single', openIds: ['a', 'b'], mainId: 'b' });
    assert.deepEqual(out.openIds, ['a']);
    assert.equal(out.mainId, null, 'the kept pane list no longer contains b, so it cannot be main');
  });

  await t.test('sync-disabled ids are narrowed to panes that are actually open', () => {
    const out = persistence.normalizeOpenPanes({ openIds: ['a', 'b'], disabledSyncIds: ['b', 'gone'] });
    assert.deepEqual(out.disabledSyncIds, ['b']);
  });

  await t.test('disabledSyncIds that is not an array becomes empty', () => {
    assert.deepEqual(persistence.normalizeOpenPanes({ openIds: ['a'], disabledSyncIds: 'a' }).disabledSyncIds, []);
  });

  await t.test('every field is present even for an empty entry, so the caller never reads undefined', () => {
    assert.deepEqual(persistence.normalizeOpenPanes({}), { viewMode: 'multi', openIds: [], disabledSyncIds: [], mainId: null });
  });
});

test('loadOpenPanes / saveOpenPanes', async (t) => {
  const state = { viewMode: 'multi', openIds: ['a', 'b'], disabledSyncIds: ['b'], mainId: 'a' };

  await t.test('a saved selection round-trips', () => {
    store.clear();
    persistence.saveOpenPanes('h1', state);
    assert.deepEqual(persistence.loadOpenPanes('h1'), state);
  });

  // Keyed per host because a container id means nothing on a different daemon.
  await t.test('hosts do not read each other’s panes', () => {
    store.clear();
    persistence.saveOpenPanes('h1', state);
    assert.equal(persistence.loadOpenPanes('h2'), null);
  });

  await t.test('a host with nothing saved loads as null, not as an empty selection', () => {
    store.clear();
    assert.equal(persistence.loadOpenPanes('never-saved'), null);
  });

  await t.test('no host id is a no-op in both directions', () => {
    store.clear();
    assert.equal(persistence.loadOpenPanes(null), null);
    assert.doesNotThrow(() => persistence.saveOpenPanes(null, state));
    assert.equal(store.size, 0, 'saving without a host wrote a key anyway');
  });

  await t.test('corrupt JSON loads as null rather than throwing into the component', () => {
    store.clear();
    store.set('odw:logs:panes:h1', '{not json');
    assert.equal(persistence.loadOpenPanes('h1'), null);
  });

  // Stored values go through the same validation as anything else, so hand-editing the key cannot
  // hand the tab more panes than it is allowed to open.
  await t.test('a hand-edited entry is normalized on read, not trusted', () => {
    store.clear();
    store.set('odw:logs:panes:h1', JSON.stringify({ viewMode: 'grid', openIds: ['a', 'b', 'c', 'd', 'e'], mainId: 'e' }));
    const out = persistence.loadOpenPanes('h1');
    assert.equal(out.viewMode, 'multi');
    assert.equal(out.openIds.length, 4);
    assert.equal(out.mainId, null);
  });

  // Private browsing and a full quota both throw from sessionStorage. The tab has to keep working -
  // losing the memory is an acceptable outcome, losing the Logs tab is not.
  await t.test('a throwing sessionStorage degrades to no memory rather than an error', () => {
    const real = globalThis.sessionStorage;
    globalThis.sessionStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      key: () => {
        throw new Error('SecurityError');
      },
      get length() {
        throw new Error('SecurityError');
      },
    };
    try {
      assert.doesNotThrow(() => persistence.saveOpenPanes('h1', state));
      assert.doesNotThrow(() => persistence.clearAllOpenPanes());
      assert.equal(persistence.loadOpenPanes('h1'), null);
    } finally {
      globalThis.sessionStorage = real;
    }
  });
});

// sessionStorage is scoped to the browser tab, not to the account signed into it, so signing out
// has to drop this or the next person to sign in on the same machine inherits the last one's
// selection. app.js's logout() calls it before navigating away.
test('clearAllOpenPanes', async (t) => {
  const state = { viewMode: 'multi', openIds: ['a'], disabledSyncIds: [], mainId: null };

  await t.test('drops every host, not just the one last used', () => {
    store.clear();
    for (const host of ['h1', 'h2', 'h3']) persistence.saveOpenPanes(host, state);
    persistence.clearAllOpenPanes();
    for (const host of ['h1', 'h2', 'h3']) assert.equal(persistence.loadOpenPanes(host), null, `${host} survived the clear`);
  });

  // The removal loop walks by index, and removing mid-walk shifts every later entry down - so a
  // naive version silently skips every other key. Three hosts is the smallest case that shows it.
  await t.test('removes all of them despite the index shifting under the walk', () => {
    store.clear();
    for (const host of ['h1', 'h2', 'h3']) persistence.saveOpenPanes(host, state);
    persistence.clearAllOpenPanes();
    assert.equal(store.size, 0, `${store.size} key(s) were skipped by the removal walk`);
  });

  await t.test('leaves keys belonging to anything else alone', () => {
    store.clear();
    store.set('odw:flow:positions:graph:h1', '{}');
    store.set('unrelated', 'x');
    persistence.saveOpenPanes('h1', state);
    persistence.clearAllOpenPanes();
    assert.deepEqual([...store.keys()].sort(), ['odw:flow:positions:graph:h1', 'unrelated']);
  });

  await t.test('is a no-op when nothing was ever saved', () => {
    store.clear();
    assert.doesNotThrow(() => persistence.clearAllOpenPanes());
  });
});
