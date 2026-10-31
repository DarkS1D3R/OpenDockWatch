const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const docker = require('../server/docker');
const inventory = require('../server/inventory');

const { parseInventoryDf, parseNetworkLs } = docker;

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let lib;
before(async () => {
  lib = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'inventory.js')));
});

// Shaped like real `docker system df -v --format '{{json .}}'` output (string counts and sizes).
const DF = {
  Images: [
    {
      ID: 'sha256:aaaaaaaaaaaa1111',
      Repository: 'myorg/billing-api',
      Tag: 'latest',
      Size: '375MB',
      SharedSize: '179.8MB',
      UniqueSize: '195.6MB',
      Containers: '1',
      CreatedSince: '6 minutes ago',
    },
    {
      ID: 'sha256:bbbbbbbbbbbb2222',
      Repository: '<none>',
      Tag: '<none>',
      Size: '1.2GB',
      SharedSize: '0B',
      UniqueSize: '1.2GB',
      Containers: '0',
      CreatedSince: '3 weeks ago',
    },
    {
      ID: 'sha256:cccccccccccc3333',
      Repository: 'postgres',
      Tag: '17-alpine',
      Size: '280MB',
      SharedSize: '0B',
      UniqueSize: '280MB',
      Containers: '0',
      CreatedSince: '2 months ago',
    },
  ],
  Volumes: [
    {
      Name: 'shop_pgdata',
      Driver: 'local',
      Labels: 'com.docker.compose.project=shop,com.docker.compose.volume=pgdata',
      Links: '1',
      Size: '65.92MB',
    },
    {
      Name: 'f56c8a3cf5024949f79b5f20eae06bce859a20615d983fca42dd20b8a13b0cbe',
      Driver: 'local',
      Labels: 'com.docker.volume.anonymous=',
      Links: '0',
      Size: '449.9MB',
    },
    { Name: 'remote-vol', Driver: 'nfs', Labels: '', Links: '0', Size: 'N/A' },
  ],
  BuildCache: [
    { ID: 'x', Size: '157MB', InUse: 'false' },
    { ID: 'y', Size: '43MB', InUse: 'true' },
  ],
};

test('parseInventoryDf', async (t) => {
  const inv = parseInventoryDf(DF);

  await t.test('images: unused means no container at all, and an untagged image is dangling', () => {
    assert.deepEqual(
      inv.images.map((i) => [i.id, i.unused, i.dangling]),
      [
        ['bbbbbbbbbbbb', true, true],
        ['aaaaaaaaaaaa', false, false],
        ['cccccccccccc', true, false],
      ]
    );
    assert.equal(inv.images[0].sizeBytes, 1.2e9);
    assert.equal(inv.images[1].uniqueBytes, 195.6e6);
  });

  await t.test('volumes: Links is the container count, labels give anonymous and project, N/A size is null', () => {
    const byName = Object.fromEntries(inv.volumes.map((v) => [v.name, v]));
    assert.deepEqual(byName.shop_pgdata, {
      name: 'shop_pgdata',
      driver: 'local',
      size: '65.92MB',
      sizeBytes: 65.92e6,
      containers: 1,
      anonymous: false,
      composeProject: 'shop',
      unused: false,
    });
    const anon = inv.volumes[0];
    assert.equal(anon.anonymous, true);
    assert.equal(anon.unused, true);
    assert.equal(byName['remote-vol'].size, null);
    assert.equal(byName['remote-vol'].sizeBytes, null);
    assert.equal(inv.volumes.at(-1).name, 'remote-vol', 'an unknown size sorts last');
  });

  await t.test('build cache is summed, and only entries not in use count as reclaimable', () => {
    assert.deepEqual(inv.buildCache, { count: 2, sizeBytes: 200e6, reclaimableBytes: 157e6 });
  });

  await t.test('a document with sections missing yields empty lists rather than throwing', () => {
    assert.deepEqual(parseInventoryDf({}), { images: [], volumes: [], buildCache: { count: 0, sizeBytes: 0, reclaimableBytes: 0 } });
  });
});

test('parseNetworkLs', async (t) => {
  const stdout = [
    '{"Driver":"bridge","ID":"9de77cb21096abcd","Internal":"false","Labels":"","Name":"bridge","Scope":"local"}',
    'not json',
    '{"Driver":"bridge","ID":"1111aaaa2222","Internal":"true","Labels":"com.docker.compose.project=shop,com.docker.compose.network=backend","Name":"shop_backend","Scope":"local"}',
    '{"Driver":"null","ID":"11dcf715dfea","Internal":"false","Labels":"","Name":"none","Scope":"local"}',
    '',
  ].join('\n');

  await t.test('parses each line, skips a malformed one and sorts by name', () => {
    const nets = parseNetworkLs(stdout);
    assert.deepEqual(
      nets.map((n) => n.name),
      ['bridge', 'none', 'shop_backend']
    );
    const shop = nets[2];
    assert.equal(shop.internal, true);
    assert.equal(shop.composeProject, 'shop');
    assert.equal(shop.builtin, false);
    assert.equal(nets[0].id, '9de77cb21096', 'ids are cut to 12 like everywhere else');
  });

  await t.test("docker's own networks are flagged builtin", () => {
    assert.ok(
      parseNetworkLs(stdout)
        .filter((n) => n.name !== 'shop_backend')
        .every((n) => n.builtin)
    );
  });
});

test('withNetworkUsage', async (t) => {
  const nets = [
    { name: 'bridge', builtin: true },
    { name: 'shop_backend', builtin: false },
    { name: 'old_default', builtin: false },
  ];
  const containers = [
    { name: 'shop-db-1', networks: ['shop_backend'] },
    { name: 'shop-web-1', networks: ['shop_backend'] },
    { name: 'stopped-one', state: 'exited', networks: [] },
  ];

  await t.test('lists the containers on each network and flags user networks nobody is on', () => {
    const out = inventory.withNetworkUsage(nets, containers);
    assert.deepEqual(out[1].containers, ['shop-db-1', 'shop-web-1']);
    assert.equal(out[1].unused, false);
    assert.equal(out[2].unused, true);
    assert.equal(out[0].unused, false, 'a builtin network is never reported unused');
  });

  await t.test('with no container list, unused is unknown rather than true', () => {
    const out = inventory.withNetworkUsage(nets, null);
    assert.equal(out[2].unused, null);
    assert.equal(out[2].containers, null);
  });
});

test('getInventory', async (t) => {
  const host = { id: 'inv-test-host' };
  t.afterEach(() => inventory.forgetHost(host.id));

  // Resolvable by hand so a test can look at the state while a refresh is still in flight.
  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  await t.test('answers at once, then serves each half as it lands', async (t2) => {
    const df = deferred();
    const net = deferred();
    const dfMock = t2.mock.method(docker, 'getInventoryDf', () => df.promise);
    t2.mock.method(docker, 'getNetworks', () => net.promise);

    const first = inventory.getInventory(host);
    assert.equal(first.refreshing, true);
    assert.equal(first.images, null);
    assert.equal(first.networks, null);

    net.resolve([{ name: 'shop_backend', builtin: false }]);
    await new Promise((r) => setImmediate(r));
    const mid = inventory.getInventory(host, { containers: [] });
    assert.equal(mid.refreshing, true, 'still waiting on system df');
    assert.equal(mid.networks.length, 1);
    assert.equal(mid.networks[0].unused, true);
    assert.equal(dfMock.mock.callCount(), 1, 'a second look while in flight shares the refresh');

    df.resolve(parseInventoryDf(DF));
    await new Promise((r) => setImmediate(r));
    const done = inventory.getInventory(host);
    assert.equal(done.refreshing, false);
    assert.equal(done.images.length, 3);
    assert.equal(done.buildCache.count, 2);
    assert.equal(dfMock.mock.callCount(), 1, 'a fresh view is not re-read');
  });

  await t.test('a failure is reported, and the last good reading stays', async (t2) => {
    let fail = false;
    t2.mock.method(docker, 'getInventoryDf', async () => {
      if (fail) throw Object.assign(new Error('Command failed'), { stderr: 'timed out after 120000ms' });
      return parseInventoryDf(DF);
    });
    t2.mock.method(docker, 'getNetworks', async () => []);

    await inventory.refresh(host);
    fail = true;
    await inventory.refresh(host);
    const inv = inventory.getInventory(host);
    assert.equal(inv.errors.df, 'timed out after 120000ms');
    assert.equal(inv.images.length, 3);
    assert.equal(inv.errors.networks, null);
  });

  await t.test('a forced refresh is rate-limited, a stale view refreshes on its own', async (t2) => {
    const dfMock = t2.mock.method(docker, 'getInventoryDf', async () => parseInventoryDf(DF));
    t2.mock.method(docker, 'getNetworks', async () => []);

    const t0 = Date.now();
    inventory.getInventory(host, { now: t0 });
    await new Promise((r) => setImmediate(r));
    inventory.getInventory(host, { force: true, now: t0 + 1_000 });
    assert.equal(dfMock.mock.callCount(), 1, 'Refresh straight after a read does not re-run system df');

    inventory.getInventory(host, { force: true, now: t0 + inventory.MIN_FORCED_REFRESH_MS + 1_000 });
    await new Promise((r) => setImmediate(r));
    assert.equal(dfMock.mock.callCount(), 2);

    inventory.getInventory(host, { now: Date.now() + inventory.INVENTORY_TTL_MS + 1_000 });
    assert.equal(dfMock.mock.callCount(), 3);
  });

  await t.test('a refresh that lands after forgetHost does not bring the host back', async (t2) => {
    const df = deferred();
    t2.mock.method(docker, 'getInventoryDf', () => df.promise);
    t2.mock.method(docker, 'getNetworks', async () => []);

    inventory.getInventory(host);
    inventory.forgetHost(host.id);
    df.resolve(parseInventoryDf(DF));
    await new Promise((r) => setImmediate(r));

    t2.mock.method(docker, 'getInventoryDf', () => new Promise(() => {}));
    const inv = inventory.getInventory(host);
    assert.equal(inv.images, null, 'the old refresh wrote into a state nobody holds any more');
  });
});

test('public/js/lib/inventory.js', async (t) => {
  await t.test('imageLabel and volumeLabel', () => {
    assert.equal(lib.imageLabel({ repository: 'postgres', tag: '17-alpine', id: 'abc' }), 'postgres:17-alpine');
    assert.equal(lib.imageLabel({ repository: null, tag: null, id: 'bbbbbbbbbbbb' }), '<none> (bbbbbbbbbbbb)');
    assert.equal(lib.volumeLabel({ name: 'f'.repeat(64) }), 'f'.repeat(12));
    assert.equal(lib.volumeLabel({ name: 'shop_pgdata' }), 'shop_pgdata');
  });

  await t.test('summarize counts unused images by unique size, volumes by size', () => {
    const inv = parseInventoryDf(DF);
    assert.deepEqual(lib.summarize('images', inv.images), { count: 3, bytes: 1.855e9, unused: 2, unusedBytes: 1.48e9 });
    assert.deepEqual(lib.summarize('volumes', inv.volumes), { count: 3, bytes: 515.82e6, unused: 2, unusedBytes: 449.9e6 });
    assert.deepEqual(lib.summarize('networks', [{ unused: true }, { unused: null }]), {
      count: 2,
      bytes: null,
      unused: 1,
      unusedBytes: null,
    });
    assert.equal(lib.summarize('images', null).count, 0);
  });

  await t.test('filterRows narrows by text and by unused, together', () => {
    const inv = parseInventoryDf(DF);
    assert.deepEqual(
      lib.filterRows('images', inv.images, { unusedOnly: true }).map((i) => i.id),
      ['bbbbbbbbbbbb', 'cccccccccccc']
    );
    assert.deepEqual(
      lib.filterRows('images', inv.images, { query: 'POSTGRES', unusedOnly: true }).map((i) => i.id),
      ['cccccccccccc']
    );
    assert.deepEqual(
      lib.filterRows('volumes', inv.volumes, { query: 'shop' }).map((v) => v.name),
      ['shop_pgdata']
    );
    const nets = [
      { name: 'shop_backend', containers: ['billing-api-1'] },
      { name: 'other', containers: [] },
    ];
    assert.deepEqual(
      lib.filterRows('networks', nets, { query: 'billing' }).map((n) => n.name),
      ['shop_backend'],
      'a network is found by a container on it'
    );
  });
});
