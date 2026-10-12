// Asks a registry what digest a tag points at now, with one HEAD request (plus an anonymous token
// fetch where the registry wants one). HEAD, not GET: Docker Hub counts manifest GETs against its
// pull rate limit and HEADs not. No credentials are read or sent. See server/CLAUDE.md.
const { registryApiHost, isLoopbackRegistry } = require('./imageRef');

const REGISTRY_TIMEOUT_MS = 15_000;

// Index types first: a multi-arch tag must answer with its index digest, which is what docker
// records in RepoDigests on pull. Asking for a single manifest would get one platform's digest.
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// kind is what the UI says about it: not_found reads "not on its registry, or private" (which is
// also how a locally built image looks), the rest are failures worth retrying later.
class RegistryError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:x:pull"`
function parseBearerChallenge(header) {
  const m = /^\s*Bearer\s+(.*)$/i.exec(header || '');
  if (!m) return null;
  const params = {};
  for (const [, key, value] of m[1].matchAll(/(\w+)="([^"]*)"/g)) params[key.toLowerCase()] = value;
  return params.realm ? params : null;
}

// A local registry is almost always plain http, as docker itself assumes for localhost.
function schemeFor(host) {
  return isLoopbackRegistry(host) ? 'http' : 'https';
}

async function fetchToken(challenge, repository, fetchImpl) {
  let realm;
  try {
    realm = new URL(challenge.realm);
  } catch {
    throw new RegistryError('error', 'registry sent an unusable auth realm');
  }
  if (realm.protocol !== 'https:' && realm.protocol !== 'http:') throw new RegistryError('error', 'registry sent an unusable auth realm');
  if (challenge.service) realm.searchParams.set('service', challenge.service);
  realm.searchParams.set('scope', challenge.scope || `repository:${repository}:pull`);
  const res = await fetchImpl(realm, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  // GHCR refuses an anonymous token outright for a repository that is missing or private.
  if (res.status === 401 || res.status === 403) throw new RegistryError('not_found', 'not on its registry, or private');
  if (!res.ok) throw new RegistryError('error', `registry token request answered HTTP ${res.status}`);
  const body = await res.json();
  return body.token || body.access_token || null;
}

// The digest the registry currently has for parsed.registry/repository:tag. Throws RegistryError.
async function getRemoteDigest(parsed, { fetchImpl = fetch } = {}) {
  const host = registryApiHost(parsed.registry);
  const url = `${schemeFor(host)}://${host}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
  const head = (token) =>
    fetchImpl(url, {
      method: 'HEAD',
      headers: { Accept: MANIFEST_ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  try {
    let res = await head();
    if (res.status === 401) {
      const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
      if (!challenge) throw new RegistryError('not_found', 'not on its registry, or private');
      res = await head(await fetchToken(challenge, parsed.repository, fetchImpl));
    }
    // An anonymous token for a repository that doesn't exist (or is private) still comes back, and
    // the manifest request then answers 401/403 rather than 404 - all three mean the same here.
    if (res.status === 401 || res.status === 403 || res.status === 404)
      throw new RegistryError('not_found', 'not on its registry, or private');
    if (res.status === 429) throw new RegistryError('rate_limited', 'registry rate limit reached');
    if (!res.ok) throw new RegistryError('error', `registry answered HTTP ${res.status}`);
    const digest = res.headers.get('docker-content-digest');
    if (!digest) throw new RegistryError('error', 'registry sent no digest');
    return digest;
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    if (err.name === 'TimeoutError') throw new RegistryError('error', `registry did not answer within ${REGISTRY_TIMEOUT_MS / 1000}s`);
    // Inside a container, localhost is OpenDockWatch's own, not the Docker host's.
    if (isLoopbackRegistry(host)) throw new RegistryError('local_registry', 'a registry on localhost, which OpenDockWatch cannot reach');
    throw new RegistryError('error', `registry unreachable: ${err.cause ? err.cause.code || err.cause.message : err.message}`);
  }
}

module.exports = { getRemoteDigest, parseBearerChallenge, RegistryError, MANIFEST_ACCEPT, REGISTRY_TIMEOUT_MS };
