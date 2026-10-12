const test = require('node:test');
const assert = require('node:assert/strict');
const { parseImageRef, registryApiHost, refKey, digestsForRepo } = require('../server/imageRef');

const D1 = 'sha256:' + 'a'.repeat(64);
const D2 = 'sha256:' + 'b'.repeat(64);

test('parseImageRef normalises the way the docker CLI does', async (t) => {
  const cases = [
    ['nginx', { registry: 'docker.io', repository: 'library/nginx', tag: 'latest', digest: null }],
    ['nginx:1.27-alpine', { registry: 'docker.io', repository: 'library/nginx', tag: '1.27-alpine', digest: null }],
    ['myorg/billing-api', { registry: 'docker.io', repository: 'myorg/billing-api', tag: 'latest', digest: null }],
    ['docker.io/library/redis:7', { registry: 'docker.io', repository: 'library/redis', tag: '7', digest: null }],
    ['index.docker.io/myorg/app:v2', { registry: 'docker.io', repository: 'myorg/app', tag: 'v2', digest: null }],
    ['ghcr.io/acme-corp/web:main', { registry: 'ghcr.io', repository: 'acme-corp/web', tag: 'main', digest: null }],
    ['localhost:5000/shop', { registry: 'localhost:5000', repository: 'shop', tag: 'latest', digest: null }],
    ['registry.example.com:8443/team/api:1.0', { registry: 'registry.example.com:8443', repository: 'team/api', tag: '1.0', digest: null }],
    [`nginx@${D1}`, { registry: 'docker.io', repository: 'library/nginx', tag: null, digest: D1 }],
    [`nginx:1.27@${D1}`, { registry: 'docker.io', repository: 'library/nginx', tag: '1.27', digest: D1 }],
  ];
  for (const [ref, expected] of cases) {
    await t.test(ref, () => assert.deepEqual(parseImageRef(ref), expected));
  }

  await t.test('a port on a registry is not mistaken for a tag', () => {
    assert.equal(parseImageRef('localhost:5000/shop').tag, 'latest');
  });
  await t.test('an image id, a bad digest or nothing at all is not a reference', () => {
    for (const ref of ['', null, 'c6497fd514ab', 'sha256:' + 'c'.repeat(64), 'nginx@sha256:short'])
      assert.equal(parseImageRef(ref), null, String(ref));
  });
});

test('registryApiHost and refKey', () => {
  assert.equal(registryApiHost('docker.io'), 'registry-1.docker.io');
  assert.equal(registryApiHost('ghcr.io'), 'ghcr.io');
  assert.equal(
    refKey(parseImageRef('nginx')),
    refKey(parseImageRef('docker.io/library/nginx:latest')),
    'two spellings of one tag must share one lookup'
  );
});

test('digestsForRepo keeps only the digests of the repository being checked', () => {
  const parsed = parseImageRef('nginx:alpine');
  const repoDigests = [`nginx@${D1}`, `myorg/nginx-fork@${D2}`, `docker.io/library/nginx@${D2}`, 'garbage'];
  assert.deepEqual(digestsForRepo(repoDigests, parsed), [D1, D2]);
  assert.deepEqual(digestsForRepo(null, parsed), []);
});
