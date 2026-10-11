const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// imageUpdates requires server/db, which opens a database the moment it's required - set before the
// require below, or this runs against the real data/opendockwatch.db (see test/metricsCollector.test.js).
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-image-updates-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const db = require('../server/db');
const docker = require('../server/docker');
const registry = require('../server/registry');
const metricsCollector = require('../server/metricsCollector');
const hosts = require('../server/hosts');
const imageUpdates = require('../server/imageUpdates');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });
});

const OLD = 'sha256:' + '1'.repeat(64);
const NEW = 'sha256:' + '2'.repeat(64);

test('checkableImage decides what can be checked before any registry is asked', async (t) => {
  await t.test('a tagged image with a digest for its repository is checkable', () => {
    const check = imageUpdates.checkableImage('nginx:alpine', [`nginx@${OLD}`]);
    assert.equal(check.key, 'docker.io/library/nginx:alpine');
    assert.deepEqual(check.local, [OLD]);
  });
  await t.test('an image run by id, one pinned to a digest, and one with no recorded digest are not', () => {
    assert.equal(imageUpdates.checkableImage('c6497fd514ab', []).skip.reason, 'no_tag');
    assert.equal(imageUpdates.checkableImage(`nginx@${OLD}`, [`nginx@${OLD}`]).skip.reason, 'pinned');
    assert.equal(imageUpdates.checkableImage('myorg/app:dev', []).skip.reason, 'no_local_digest');
    assert.equal(imageUpdates.checkableImage('myorg/app:dev', [`other/app@${OLD}`]).skip.reason, 'no_local_digest');
  });
});

test('compareDigests', () => {
  const check = { local: [OLD] };
  assert.equal(imageUpdates.compareDigests(check, { digest: OLD }, 1).status, 'current');
  const outdated = imageUpdates.compareDigests(check, { digest: NEW }, 1);
  assert.deepEqual(outdated, { status: 'outdated', checkedAt: 1, localDigest: OLD, remoteDigest: NEW });
  const failed = imageUpdates.compareDigests(check, { errorKind: 'not_found', error: 'not on its registry, or private' }, 1);
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.reason, 'not_found');
});

test('checkHost', async (t) => {
  const HOST = { id: 'iu-host', name: 'iu' };
  const containers = [
    { id: 'aaaaaaaaaaaa', name: 'web', state: 'running' },
    { id: 'bbbbbbbbbbbb', name: 'web2', state: 'running' },
    { id: 'cccccccccccc', name: 'api', state: 'exited' },
    { id: 'dddddddddddd', name: 'built', state: 'running' },
  ];

  function stub(t2, { remote = { 'library/nginx': NEW }, cache = new Map(), hours = '0' } = {}) {
    const asked = [];
    t2.mock.method(metricsCollector, 'getSnapshot', () => ({ reachable: true, containers }));
    t2.mock.method(
      docker,
      'getContainerImages',
      async () =>
        new Map([
          ['aaaaaaaaaaaa', { imageId: 'img-nginx', configImage: 'nginx:alpine' }],
          ['bbbbbbbbbbbb', { imageId: 'img-nginx', configImage: 'docker.io/library/nginx:alpine' }],
          ['cccccccccccc', { imageId: 'img-api', configImage: 'myorg/billing-api:2' }],
          ['dddddddddddd', { imageId: 'img-built', configImage: 'shop-web:local' }],
        ])
    );
    t2.mock.method(
      docker,
      'getImageRepoDigests',
      async () =>
        new Map([
          ['img-nginx', [`nginx@${OLD}`]],
          ['img-api', [`myorg/billing-api@${OLD}`]],
          ['img-built', [`shop-web@${OLD}`]],
        ])
    );
    t2.mock.method(registry, 'getRemoteDigest', async (parsed) => {
      asked.push(parsed.repository);
      if (remote[parsed.repository]) return remote[parsed.repository];
      throw new registry.RegistryError('not_found', 'not on its registry, or private');
    });
    t2.mock.method(db, 'getRemoteDigest', (key) => cache.get(key) || null);
    t2.mock.method(db, 'setRemoteDigest', (row) => cache.set(row.refKey, row));
    t2.mock.method(db, 'getSetting', (key) => (key === 'imageUpdateCheckHours' ? hours : null));
    t2.after(() => imageUpdates.forgetHost(HOST.id));
    return { asked, cache };
  }

  await t.test('one registry question per tag, and a verdict for every container', async (t2) => {
    const s = stub(t2, { remote: { 'library/nginx': NEW, 'myorg/billing-api': OLD } });
    const counts = await imageUpdates.checkHost(HOST);
    assert.deepEqual(
      s.asked.sort(),
      ['library/nginx', 'library/shop-web', 'myorg/billing-api'],
      'two spellings of nginx:alpine share one lookup'
    );
    assert.deepEqual(counts, { checked: 4, outdated: 2, unknown: 1 });
    assert.equal(imageUpdates.statusFor(HOST.id, 'aaaaaaaaaaaa').status, 'outdated');
    assert.equal(imageUpdates.statusFor(HOST.id, 'bbbbbbbbbbbb').status, 'outdated');
    assert.equal(imageUpdates.statusFor(HOST.id, 'cccccccccccc').status, 'current', 'a stopped container is checked too');
    assert.equal(imageUpdates.statusFor(HOST.id, 'dddddddddddd').reason, 'not_found', 'a local build reads as not on its registry');
    assert.equal(imageUpdates.countOutdated(HOST.id), 2);
    assert.equal(imageUpdates.statusFor(HOST.id, 'aaaaaaaaaaaa1234').status, 'outdated', 'a full-length id finds the same result');
  });

  await t.test('a recent registry answer is reused, and Check now asks again anyway', async (t2) => {
    const cache = new Map([
      ['docker.io/library/nginx:alpine', { digest: OLD, errorKind: null, error: null, checkedAt: Date.now() - 60_000 }],
    ]);
    const s = stub(t2, { cache });
    await imageUpdates.checkHost(HOST);
    assert.ok(!s.asked.includes('library/nginx'), 'a restart must not re-ask every registry');
    assert.equal(imageUpdates.statusFor(HOST.id, 'aaaaaaaaaaaa').status, 'current');
    await imageUpdates.checkHost(HOST, { force: true });
    assert.ok(s.asked.includes('library/nginx'));
    assert.equal(imageUpdates.statusFor(HOST.id, 'aaaaaaaaaaaa').status, 'outdated');
  });

  await t.test('a stale cached answer is asked again', async (t2) => {
    const cache = new Map([['docker.io/library/nginx:alpine', { digest: OLD, checkedAt: Date.now() - 7 * 3_600_000 }]]);
    const s = stub(t2, { cache });
    await imageUpdates.checkHost(HOST);
    assert.ok(s.asked.includes('library/nginx'));
  });

  await t.test('two callers share one check rather than running two', async (t2) => {
    const s = stub(t2);
    const [a, b] = await Promise.all([imageUpdates.checkHost(HOST), imageUpdates.checkHost(HOST)]);
    assert.equal(a, b);
    assert.equal(s.asked.filter((r) => r === 'library/nginx').length, 1);
  });

  await t.test('an unreachable host is skipped, and a failing inspect never rejects', async (t2) => {
    stub(t2);
    metricsCollector.getSnapshot.mock.mockImplementation(() => ({ reachable: false, containers: [] }));
    assert.equal(await imageUpdates.checkHost(HOST), null);
    metricsCollector.getSnapshot.mock.mockImplementation(() => ({ reachable: true, containers }));
    docker.getContainerImages.mock.mockImplementation(async () => {
      throw new Error('No such object: aaaaaaaaaaaa');
    });
    assert.equal(await imageUpdates.checkHost(HOST), null);
    assert.equal(imageUpdates.statusFor(HOST.id, 'aaaaaaaaaaaa'), null);
  });
});

test('periodic checks', async (t) => {
  await t.test('off by default - nothing reaches out until an interval is set', async (t2) => {
    t2.mock.method(db, 'getSetting', () => null);
    const loads = t2.mock.method(hosts, 'loadHosts', () => [{ id: 'h' }]);
    const original = process.env.IMAGE_UPDATE_CHECK_HOURS;
    delete process.env.IMAGE_UPDATE_CHECK_HOURS;
    t2.after(() => original !== undefined && (process.env.IMAGE_UPDATE_CHECK_HOURS = original));
    assert.deepEqual(imageUpdates.getCheckConfig(), { hours: 0, overridden: false });
    await imageUpdates.tick();
    assert.equal(loads.mock.callCount(), 0);
  });

  await t.test('.env sets it, a saved value beats it, and junk reads as off', (t2) => {
    const store = new Map();
    t2.mock.method(db, 'getSetting', (k) => (store.has(k) ? store.get(k) : null));
    process.env.IMAGE_UPDATE_CHECK_HOURS = '12';
    t2.after(() => delete process.env.IMAGE_UPDATE_CHECK_HOURS);
    assert.equal(imageUpdates.getCheckConfig().hours, 12);
    store.set('imageUpdateCheckHours', '0');
    assert.deepEqual(imageUpdates.getCheckConfig(), { hours: 0, overridden: true });
    store.set('imageUpdateCheckHours', 'often');
    assert.equal(imageUpdates.getCheckConfig().hours, 0);
  });
});

test('parseContainerImages and parseImageRepoDigests', () => {
  const images = docker.parseContainerImages(`${'a'.repeat(64)}\tsha256:${'1'.repeat(64)}\tnginx:alpine\n\nshort\n`);
  assert.deepEqual([...images], [['aaaaaaaaaaaa', { imageId: `sha256:${'1'.repeat(64)}`, configImage: 'nginx:alpine' }]]);
  const digests = docker.parseImageRepoDigests(`sha256:1\t["nginx@${OLD}"]\nsha256:2\tnull\nsha256:3\t{broken\n`);
  assert.deepEqual(
    [...digests],
    [
      ['sha256:1', [`nginx@${OLD}`]],
      ['sha256:2', []],
    ]
  );
});
