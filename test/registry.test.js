const test = require('node:test');
const assert = require('node:assert/strict');
const { getRemoteDigest, parseBearerChallenge } = require('../server/registry');
const { parseImageRef } = require('../server/imageRef');

const DIGEST = 'sha256:' + 'd'.repeat(64);

function response(status, headers = {}, body = null) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => lower[k.toLowerCase()] ?? null }, json: async () => body };
}

// A fake registry: answers each request from `script` in order and records what was asked.
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

const HUB_CHALLENGE = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"';

test('parseBearerChallenge', () => {
  assert.deepEqual(parseBearerChallenge(HUB_CHALLENGE), {
    realm: 'https://auth.docker.io/token',
    service: 'registry.docker.io',
    scope: 'repository:library/nginx:pull',
  });
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
  assert.equal(parseBearerChallenge(null), null);
});

test('getRemoteDigest', async (t) => {
  await t.test('Docker Hub: HEAD, anonymous token, HEAD again, digest from the header', async () => {
    const f = fakeFetch([
      response(401, { 'WWW-Authenticate': HUB_CHALLENGE }),
      response(200, {}, { token: 'anon' }),
      response(200, { 'Docker-Content-Digest': DIGEST }),
    ]);
    assert.equal(await getRemoteDigest(parseImageRef('nginx:alpine'), { fetchImpl: f.impl }), DIGEST);
    assert.equal(f.calls[0].url, 'https://registry-1.docker.io/v2/library/nginx/manifests/alpine');
    assert.equal(f.calls[0].method, 'HEAD', 'a GET counts against the Docker Hub pull limit');
    assert.match(
      f.calls[0].headers.Accept,
      /^application\/vnd\.oci\.image\.index\.v1\+json/,
      'a multi-arch tag must answer with its index digest'
    );
    assert.equal(f.calls[1].url, 'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull');
    assert.equal(f.calls[2].headers.Authorization, 'Bearer anon');
    assert.equal(f.calls[2].method, 'HEAD');
  });

  await t.test('a registry that needs no token is asked once', async () => {
    const f = fakeFetch([response(200, { 'Docker-Content-Digest': DIGEST })]);
    assert.equal(await getRemoteDigest(parseImageRef('localhost:5000/shop:v1'), { fetchImpl: f.impl }), DIGEST);
    assert.equal(f.calls[0].url, 'http://localhost:5000/v2/shop/manifests/v1', 'a local registry is plain http, as docker assumes');
  });

  const kindOf = async (script) => {
    const f = fakeFetch(script);
    try {
      await getRemoteDigest(parseImageRef('ghcr.io/acme-corp/web:main'), { fetchImpl: f.impl });
      return 'no error';
    } catch (err) {
      return err.kind;
    }
  };

  await t.test('missing or private reads as not_found, however the registry says it', async () => {
    const challenge = { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' };
    assert.equal(await kindOf([response(404)]), 'not_found');
    assert.equal(await kindOf([response(401, challenge), response(200, {}, { token: 't' }), response(401)]), 'not_found');
    assert.equal(await kindOf([response(401, challenge), response(403)]), 'not_found', 'GHCR refuses the token itself');
    assert.equal(await kindOf([response(401, { 'WWW-Authenticate': 'Basic realm="x"' })]), 'not_found');
  });

  await t.test('rate limits, server errors, a missing digest and a dead network are each reported', async () => {
    assert.equal(await kindOf([response(429)]), 'rate_limited');
    assert.equal(await kindOf([response(500)]), 'error');
    assert.equal(await kindOf([response(200)]), 'error');
    assert.equal(await kindOf([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })]), 'error');
  });

  await t.test('a realm that is not http(s) is refused rather than fetched', async () => {
    assert.equal(await kindOf([response(401, { 'WWW-Authenticate': 'Bearer realm="file:///etc/passwd"' })]), 'error');
  });
});
