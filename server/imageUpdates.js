// Image-update detection: does the image a container runs still match what its tag points at on the
// registry? Detection only - nothing is pulled or recreated. Periodic checks are opt-in (they reach
// out to registries); an admin's "Check now" works either way. See docs/architecture/server.md.
const db = require('./db');
const logger = require('./logger');
// Module objects, not destructured, so test/imageUpdates.test.js can stub them.
const docker = require('./docker');
const registry = require('./registry');
const metricsCollector = require('./metricsCollector');
const { loadHosts } = require('./hosts');
const { parseImageRef, refKey, digestsForRepo, isLoopbackRegistry } = require('./imageRef');
const { mapLimit } = require('./composeGroup');

const CHECK_HOURS_KEY = 'imageUpdateCheckHours';
const TICK_MS = 60_000;
// Registry lookups at once, across all of one host's images. Each is one HEAD (plus a token fetch).
const REGISTRY_CONCURRENCY = 4;
// A host whose check failed outright (daemon gone mid-inspect) tries again this soon, not a whole interval later.
const FAILED_RETRY_MS = 10 * 60_000;
// A remote answer younger than this many intervals is reused rather than asked again.
const REUSE_FRACTION = 0.9;

const results = new Map(); // hostId -> Map(containerId -> result)
const lastRun = new Map(); // hostId -> ts the last periodic check was due from
const inFlight = new Map(); // hostId -> { promise, force } for the check running now
const forceQueued = new Map(); // hostId -> host, a Check now that arrived while a cached check ran
let timer = null;

// .env default + Settings override, like every other setting here. 0 (the default) means no
// periodic checks: they contact Docker Hub and other registries, which an install may not expect.
function getCheckConfig() {
  const dbVal = db.getSetting(CHECK_HOURS_KEY);
  const overridden = dbVal !== null;
  const raw = overridden ? dbVal : process.env.IMAGE_UPDATE_CHECK_HOURS;
  const hours = Number(raw);
  return { hours: Number.isFinite(hours) && hours > 0 ? hours : 0, overridden };
}

function setCheckConfig({ hours }) {
  db.setSetting(CHECK_HOURS_KEY, String(hours || 0));
  return getCheckConfig();
}

function clearCheckConfig() {
  db.deleteSetting(CHECK_HOURS_KEY);
  return getCheckConfig();
}

const unknown = (reason, message, checkedAt) => ({ status: 'unknown', reason, message, checkedAt });

// Before asking a registry: whether this container's image can be checked at all, and which local
// digests a registry answer would be compared with. sshHost: localhost there is the remote's. Pure.
function checkableImage(configImage, repoDigests, { sshHost = false } = {}) {
  const parsed = parseImageRef(configImage);
  if (!parsed) return { skip: unknown('no_tag', 'runs an image by id, with no tag to check') };
  if (parsed.digest) return { skip: unknown('pinned', 'pinned to a digest, so it never changes') };
  if (sshHost && isLoopbackRegistry(parsed.registry)) {
    return { skip: unknown('local_registry', "a registry on the remote host's own localhost, which OpenDockWatch cannot reach") };
  }
  const local = digestsForRepo(repoDigests, parsed);
  if (!local.length) return { skip: unknown('no_local_digest', 'no registry digest is recorded for this image') };
  return { parsed, key: refKey(parsed), local };
}

// The verdict once the registry has answered (remote is { digest } or { errorKind, error }). Pure.
function compareDigests(check, remote, checkedAt) {
  if (!remote.digest) return unknown(remote.errorKind || 'error', remote.error || 'registry check failed', checkedAt);
  return {
    status: check.local.includes(remote.digest) ? 'current' : 'outdated',
    checkedAt,
    localDigest: check.local[0],
    remoteDigest: remote.digest,
  };
}

// What the registry says now, from the db cache if it was asked recently enough. Never throws.
async function remoteDigestFor(check, { force, maxAgeMs }) {
  const cached = db.getRemoteDigest(check.key);
  if (!force && cached && Date.now() - cached.checkedAt < maxAgeMs) return cached;
  const checkedAt = Date.now();
  let entry;
  try {
    entry = { digest: await registry.getRemoteDigest(check.parsed), errorKind: null, error: null, checkedAt };
  } catch (err) {
    entry = { digest: null, errorKind: err.kind || 'error', error: err.message, checkedAt };
  }
  db.setRemoteDigest({ refKey: check.key, ...entry });
  return entry;
}

async function runCheck(host, { force }) {
  const startedAt = Date.now();
  const snapshot = metricsCollector.getSnapshot(host.id);
  if (!snapshot || !snapshot.reachable) return null;
  const containerIds = (snapshot.containers || []).map((c) => c.id);
  const images = await docker.getContainerImages(host, containerIds);
  const imageIds = [...new Set([...images.values()].map((i) => i.imageId))];
  const repoDigests = await docker.getImageRepoDigests(host, imageIds);

  const checks = new Map();
  const sshHost = docker.isSshHost(host);
  for (const [containerId, { imageId, configImage }] of images) {
    checks.set(containerId, checkableImage(configImage, repoDigests.get(imageId), { sshHost }));
  }
  // One registry question per distinct tag, however many containers run it.
  const byKey = new Map();
  for (const check of checks.values()) if (check.key && !byKey.has(check.key)) byKey.set(check.key, check);
  const { hours } = getCheckConfig();
  const maxAgeMs = (hours || 6) * 3_600_000 * REUSE_FRACTION;
  const remote = new Map();
  await mapLimit([...byKey.values()], REGISTRY_CONCURRENCY, async (check) => {
    remote.set(check.key, await remoteDigestFor(check, { force, maxAgeMs }));
  });

  const hostResults = new Map();
  for (const [containerId, check] of checks) {
    if (check.skip) hostResults.set(containerId, { ...check.skip, checkedAt: startedAt });
    else {
      const answer = remote.get(check.key);
      hostResults.set(containerId, compareDigests(check, answer, answer.checkedAt));
    }
  }
  results.set(host.id, hostResults);
  const counts = { checked: hostResults.size, outdated: 0, unknown: 0 };
  for (const r of hostResults.values()) if (r.status !== 'current') counts[r.status] += 1;
  logger.info('image_updates.checked', { host: host.id, ...counts, registryLookups: byKey.size, force, tookMs: Date.now() - startedAt });
  return counts;
}

// One check per host at a time; a second caller shares the first's promise. Never rejects. A forced
// check arriving during an unforced one would get the cached answers it exists to bypass, so it is
// queued to run straight after instead.
function checkHost(host, { force = false } = {}) {
  const running = inFlight.get(host.id);
  if (running) {
    if (force && !running.force) forceQueued.set(host.id, host);
    return running.promise;
  }
  const promise = runCheck(host, { force })
    .catch((err) => {
      logger.warn('image_updates.check_failed', { host: host.id, error: err.stderr || err.message });
      return null;
    })
    .finally(() => {
      inFlight.delete(host.id);
      const queued = forceQueued.get(host.id);
      forceQueued.delete(host.id);
      if (queued) checkHost(queued, { force: true });
    });
  inFlight.set(host.id, { promise, force });
  return promise;
}

function isChecking(hostId) {
  return inFlight.has(hostId) || forceQueued.has(hostId);
}

// Runs every TICK_MS and starts whichever hosts are due. Sequential: an image check is never urgent,
// and one host at a time keeps it to a small share of docker.js's concurrency slots.
async function tick() {
  const { hours } = getCheckConfig();
  if (!hours) return;
  const intervalMs = hours * 3_600_000;
  for (const host of loadHosts()) {
    const due = (lastRun.get(host.id) || 0) + intervalMs;
    if (Date.now() < due) continue;
    const counts = await checkHost(host);
    lastRun.set(host.id, counts ? Date.now() : Date.now() - intervalMs + FAILED_RETRY_MS);
  }
}

function start() {
  timer = setInterval(() => {
    tick().catch((err) => logger.error('image_updates.tick_failed', { error: err.message }));
  }, TICK_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// For containersFor: the last verdict for this container, or null if it hasn't been checked.
function statusFor(hostId, containerId) {
  const hostResults = results.get(hostId);
  return (hostResults && hostResults.get(String(containerId).slice(0, 12))) || null;
}

function countOutdated(hostId) {
  let n = 0;
  for (const r of (results.get(hostId) || new Map()).values()) if (r.status === 'outdated') n += 1;
  return n;
}

function forgetHost(hostId) {
  results.delete(hostId);
  lastRun.delete(hostId);
  forceQueued.delete(hostId);
}

module.exports = {
  getCheckConfig,
  setCheckConfig,
  clearCheckConfig,
  checkableImage,
  compareDigests,
  checkHost,
  isChecking,
  tick,
  start,
  stop,
  statusFor,
  countOutdated,
  forgetHost,
};
