const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as the other lib tests.
let m;
test.before(async () => {
  m = await import('../public/js/lib/containerSort.js');
});

const c = (id, name, extra = {}) => ({ id, name, state: 'running', ...extra });
const names = (list) => list.map((x) => x.name);

const ITEMS = [
  c('1', 'bravo', { restartCount1h: 2 }),
  c('2', 'Alpha'),
  c('3', 'charlie', { restartCount1h: 5 }),
  c('4', 'delta', { state: 'exited' }),
];
const STATS = {
  1: { cpuPerc: '12.50%', memUsage: '512MiB / 2GiB' },
  2: { cpuPerc: '0.10%', memUsage: '2GiB / 4GiB' },
  3: { cpuPerc: '80.00%', memUsage: '64MiB / 1GiB' },
};

test('sortContainers', async (t) => {
  await t.test('returns the list untouched when no sort is chosen', () => {
    assert.equal(m.sortContainers(ITEMS, null, STATS), ITEMS);
  });

  await t.test('never mutates the input', () => {
    const copy = [...ITEMS];
    m.sortContainers(ITEMS, { key: 'name', dir: 'desc' }, STATS);
    assert.deepEqual(ITEMS, copy);
  });

  await t.test('sorts names case-insensitively in either direction', () => {
    assert.deepEqual(names(m.sortContainers(ITEMS, { key: 'name', dir: 'asc' }, STATS)), ['Alpha', 'bravo', 'charlie', 'delta']);
    assert.deepEqual(names(m.sortContainers(ITEMS, { key: 'name', dir: 'desc' }, STATS)), ['delta', 'charlie', 'bravo', 'Alpha']);
  });

  await t.test('sorts CPU numerically, not as text ("80.00%" beats "12.50%")', () => {
    assert.deepEqual(names(m.sortContainers(ITEMS, { key: 'cpu', dir: 'desc' }, STATS)).slice(0, 3), ['charlie', 'bravo', 'Alpha']);
  });

  await t.test('sorts memory by bytes used, so GiB outranks MiB', () => {
    assert.deepEqual(names(m.sortContainers(ITEMS, { key: 'mem', dir: 'desc' }, STATS)).slice(0, 3), ['Alpha', 'bravo', 'charlie']);
  });

  await t.test('sorts by restarts in the last hour, with none counting as zero', () => {
    assert.deepEqual(names(m.sortContainers(ITEMS, { key: 'restarts', dir: 'desc' }, STATS)).slice(0, 2), ['charlie', 'bravo']);
  });

  await t.test('puts a container with no stats last in BOTH directions', () => {
    for (const dir of ['asc', 'desc']) {
      const out = m.sortContainers(ITEMS, { key: 'cpu', dir }, STATS);
      assert.equal(out[out.length - 1].name, 'delta', `${dir} floated the stopped container up`);
    }
  });

  await t.test('breaks ties by name so the order does not shuffle between polls', () => {
    const tied = [c('a', 'zed'), c('b', 'ant'), c('d', 'mid')];
    const stats = {
      a: { cpuPerc: '5%', memUsage: '1MiB' },
      b: { cpuPerc: '5%', memUsage: '1MiB' },
      d: { cpuPerc: '5%', memUsage: '1MiB' },
    };
    assert.deepEqual(names(m.sortContainers(tied, { key: 'cpu', dir: 'desc' }, stats)), ['ant', 'mid', 'zed']);
  });

  await t.test('treats an unreadable figure as missing, not as zero', () => {
    const list = [c('a', 'garbled'), c('b', 'real')];
    const out = m.sortContainers(list, { key: 'cpu', dir: 'asc' }, { a: { cpuPerc: '--' }, b: { cpuPerc: '3%' } });
    assert.deepEqual(names(out), ['real', 'garbled']);
  });

  await t.test('ignores an unknown key rather than scrambling the list', () => {
    assert.equal(m.sortContainers(ITEMS, { key: 'bogus', dir: 'asc' }, STATS), ITEMS);
  });
});

test('normalizeSort', async (t) => {
  await t.test('accepts a known key and direction', () => {
    assert.deepEqual(m.normalizeSort({ key: 'cpu', dir: 'asc' }), { key: 'cpu', dir: 'asc' });
  });
  await t.test('fills in the key default for a missing or bad direction', () => {
    assert.deepEqual(m.normalizeSort({ key: 'name', dir: 'sideways' }), { key: 'name', dir: 'asc' });
    assert.deepEqual(m.normalizeSort({ key: 'cpu' }), { key: 'cpu', dir: 'desc' });
  });
  await t.test('drops anything that is not a known key', () => {
    for (const bad of [null, undefined, 'cpu', 5, {}, { key: 'bogus', dir: 'asc' }]) assert.equal(m.normalizeSort(bad), null);
  });
});

test('loadSort / saveSort', async (t) => {
  const fakeStorage = () => {
    const data = new Map();
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  };

  await t.test('round-trips a sort', () => {
    const s = fakeStorage();
    m.saveSort({ key: 'mem', dir: 'desc' }, s);
    assert.deepEqual(m.loadSort(s), { key: 'mem', dir: 'desc' });
  });
  await t.test('saving null forgets it', () => {
    const s = fakeStorage();
    m.saveSort({ key: 'mem', dir: 'desc' }, s);
    m.saveSort(null, s);
    assert.equal(m.loadSort(s), null);
  });
  await t.test('survives corrupt storage and storage that throws', () => {
    const corrupt = fakeStorage();
    corrupt.setItem('odw:list:sort', '{not json');
    assert.equal(m.loadSort(corrupt), null);
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    assert.equal(m.loadSort(throwing), null);
    assert.doesNotThrow(() => m.saveSort({ key: 'cpu', dir: 'asc' }, throwing));
  });
});
