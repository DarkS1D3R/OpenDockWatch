// Pure parsing of docker image references and RepoDigests, for imageUpdates.js. Follows the docker
// CLI's own normalisation: no registry means Docker Hub, a one-part Hub name lives under library/,
// and no tag means latest. See server/CLAUDE.md.

const DOCKER_HUB = 'docker.io';

// What `docker ps` shows when the container's tag has since moved to another image: a bare id.
const IMAGE_ID_RE = /^(sha256:)?[a-f0-9]{12,64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// The first path component is a registry only if it looks like a host: it has a dot or a port, or
// it is localhost. Otherwise `myorg/app` is a Docker Hub repository, exactly as the CLI reads it.
function splitRegistry(name) {
  const slash = name.indexOf('/');
  if (slash === -1) return { registry: DOCKER_HUB, path: name };
  const first = name.slice(0, slash);
  if (first.includes('.') || first.includes(':') || first === 'localhost') return { registry: first, path: name.slice(slash + 1) };
  return { registry: DOCKER_HUB, path: name };
}

// { registry, repository, tag, digest } or null for something that isn't a reference at all (an
// image id). `docker.io` and `index.docker.io` collapse to one registry so their digests compare.
function parseImageRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw || IMAGE_ID_RE.test(raw)) return null;
  let rest = raw;
  let digest = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest)) return null;
  }
  let tag = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest) return null;
  let { registry, path } = splitRegistry(rest);
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = DOCKER_HUB;
  path = path.toLowerCase();
  if (registry === DOCKER_HUB && !path.includes('/')) path = `library/${path}`;
  return { registry, repository: path, tag: tag || (digest ? null : 'latest'), digest };
}

// The registry host to actually talk to - Docker Hub's API does not live at docker.io.
function registryApiHost(registry) {
  return registry === DOCKER_HUB ? 'registry-1.docker.io' : registry;
}

// One cache key per thing a registry is asked about, whatever spelling the container used.
function refKey(parsed) {
  return `${parsed.registry}/${parsed.repository}:${parsed.tag}`;
}

// The digests among an image's RepoDigests that belong to this repository - the ones a registry's
// answer for the same repository can be compared with. Others (a retag elsewhere) say nothing.
function digestsForRepo(repoDigests, parsed) {
  const out = [];
  for (const entry of repoDigests || []) {
    const ref = parseImageRef(entry);
    if (ref && ref.digest && ref.registry === parsed.registry && ref.repository === parsed.repository) out.push(ref.digest);
  }
  return out;
}

module.exports = { parseImageRef, registryApiHost, refKey, digestsForRepo, DOCKER_HUB };
