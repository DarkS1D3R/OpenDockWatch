const { execFile, spawn } = require('child_process');
const logger = require('./logger');

const CMD_TIMEOUT_MS = 10_000;
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

// Opening an SSH connection (handshake, host key, auth) can eat well into CMD_TIMEOUT_MS on a
// slow link; the image keeps it alive 10min (ControlPersist) so it's only paid occasionally, but
// checkHost's every-5s reachability probe needs headroom or a slow-to-connect host "flaps".
const SSH_CHECK_TIMEOUT_MS = 20_000;

function hostArgs(host) {
  return host && host.dockerHost ? ['-H', host.dockerHost] : [];
}

function checkTimeoutMs(host) {
  return host && host.dockerHost ? SSH_CHECK_TIMEOUT_MS : CMD_TIMEOUT_MS;
}

// execFile's own `timeout` only sends SIGTERM, and a `docker` CLI wedged on a dead daemon/ssh
// socket can ignore it forever - the promise never settles, the child stays resident, and every
// poll leaks another one. This escalates: SIGTERM first, SIGKILL a few seconds later if still alive.
const KILL_GRACE_MS = 5000;

// Nothing else bounds concurrent `docker` processes - the collector's poll plus every browser
// tab's requests can overlap a slow daemon instead of queueing. Calls past the limit wait for a
// slot and give up rather than wait forever, so a failing-fast request frees its browser connection.
const MAX_CONCURRENT = Number(process.env.DOCKER_MAX_CONCURRENT) || 12;
const MAX_QUEUE_WAIT_MS = 15_000;

let active = 0;
const waiters = [];

// Saturation is a sustained condition, not a series of events. A line per queued call put hundreds
// in `docker logs` with nothing tying them together, and `active` was worthless on every one of
// them - reaching the queued path means all MAX_CONCURRENT slots are held, and release() hands a
// slot straight to a waiter rather than decrementing, so `active` is MAX_CONCURRENT by
// construction. One line when the queue forms, one when it drains, and the episode's shape in
// between - the same aggregate shape watchdog.js's lag summary uses.
let queueEpisode = null;

function noteQueued() {
  if (!queueEpisode) {
    queueEpisode = { startedAt: Date.now(), queued: 0, peakDepth: 0, timeouts: 0, waitedMs: 0 };
    logger.warn('docker.queue.saturated', { limit: MAX_CONCURRENT });
  }
  queueEpisode.queued += 1;
  queueEpisode.peakDepth = Math.max(queueEpisode.peakDepth, waiters.length + 1);
}

// Called for every waiter that leaves the queue, whichever way it left. The episode closes only
// once nothing is waiting, so a queue that keeps churning stays one episode rather than logging a
// drained/saturated pair per call.
function noteDequeued(waitedMs, timedOut) {
  if (!queueEpisode) return;
  queueEpisode.waitedMs += waitedMs;
  if (timedOut) queueEpisode.timeouts += 1;
  if (waiters.length > 0) return;
  const ep = queueEpisode;
  queueEpisode = null;
  logger.warn('docker.queue.drained', {
    forSec: Math.round((Date.now() - ep.startedAt) / 1000),
    queued: ep.queued,
    peakDepth: ep.peakDepth,
    timeouts: ep.timeouts,
    avgWaitMs: Math.round(ep.waitedMs / ep.queued),
  });
}

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  const queuedAt = Date.now();
  noteQueued();
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null, queuedAt };
    waiter.timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx !== -1) waiters.splice(idx, 1);
      noteDequeued(Date.now() - queuedAt, true);
      reject(new Error(`docker command queued behind ${MAX_CONCURRENT} others for ${MAX_QUEUE_WAIT_MS}ms - daemon is not keeping up`));
    }, MAX_QUEUE_WAIT_MS);
    waiters.push(waiter);
  });
}

function release() {
  const waiter = waiters.shift();
  if (!waiter) {
    active--;
    return;
  }
  // The slot passes straight to the waiter rather than being freed and re-taken, so `active`
  // stays accurate and a burst of waiters can't all wake into the same one.
  clearTimeout(waiter.timer);
  waiter.resolve();
  noteDequeued(Date.now() - waiter.queuedAt, false);
}

// The concurrency limiter's live depth, for the periodic vitals line in index.js. A hang that is
// really "every docker call is queued behind a wedged daemon" looks like nothing at all otherwise -
// the queue only logs at its edges, so a sustained backlog needs sampling to show up as sustained.
function poolStats() {
  return { active, queued: waiters.length, limit: MAX_CONCURRENT };
}

// execFile reports a timeout kill as a generic "Command failed: docker ..." with *empty* stderr -
// nothing was ever written to it - which reads like a daemon error and hides the one fact that
// matters. `docker system df` timed out every 60s for weeks on a WSL2 host and looked exactly like
// a broken daemon in the log. Pure and separate from spawnDocker so it's unit-testable without
// mocking child_process, same as the CLI-output parsers further down this file.
function dockerCommandError(err, args, timeoutMs, stderr) {
  if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
    const timedOut = new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`);
    timedOut.timedOut = true;
    timedOut.stderr = stderr;
    return timedOut;
  }
  err.stderr = stderr;
  return err;
}

function spawnDocker(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let killTimer = null;
    const child = execFile('docker', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(killTimer);
      if (err) return reject(dockerCommandError(err, args, timeoutMs, stderr));
      resolve(stdout);
    });
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, timeoutMs + KILL_GRACE_MS);
  });
}

async function run(args, timeoutMs = CMD_TIMEOUT_MS) {
  await acquire();
  try {
    return await spawnDocker(args, timeoutMs);
  } finally {
    release();
  }
}

async function getHostInfo(host) {
  const stdout = await run([...hostArgs(host), 'info', '--format', '{{json .}}']);
  const raw = JSON.parse(stdout);
  return {
    ncpu: raw.NCPU,
    memTotalBytes: raw.MemTotal,
    serverVersion: raw.ServerVersion,
    containers: raw.Containers,
    containersRunning: raw.ContainersRunning,
    hostname: raw.Name,
  };
}

// Why the last probe failed, kept per host so the reason survives the boolean this returns.
// "Became unreachable" without a cause is the least useful alert the app can send - timed out,
// host key verification failed, permission denied and daemon-not-running need completely
// different responses. testHostConnection exists purely because that boolean wasn't enough for a
// human pressing "Test connection"; the automatic probe deserves the same information, so it's
// recorded here and read on the reachable -> unreachable transition rather than every 5s.
const lastCheckErrors = new Map();

function lastCheckError(hostId) {
  return lastCheckErrors.get(hostId) || null;
}

async function checkHost(host) {
  try {
    await run([...hostArgs(host), 'version', '--format', '{{.Server.Version}}'], checkTimeoutMs(host));
    lastCheckErrors.delete(host.id);
    return true;
  } catch (err) {
    // stderr first: `docker` puts the useful line there ("Permission denied (publickey)"), while
    // err.message is the generic "Command failed". A timeout has neither and gets its own message
    // from dockerCommandError.
    lastCheckErrors.set(host.id, (err.stderr || '').trim() || err.message);
    return false;
  }
}

// Same probe as checkHost, but lets the real error (stderr) through instead of swallowing it -
// a human clicking "Test connection" in Settings needs "Host key verification failed" or
// "Permission denied (publickey)", not just "unreachable".
async function testHostConnection(host) {
  await run([...hostArgs(host), 'version', '--format', '{{.Server.Version}}'], checkTimeoutMs(host));
}

const IGNORED_NETWORKS = new Set(['bridge', 'host', 'none']);

function parseLabels(labelsStr) {
  const out = {};
  if (!labelsStr) return out;
  for (const pair of labelsStr.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

const HEALTH_RE = /\((healthy|unhealthy|health: starting)\)/i;

function parseHealth(status) {
  const m = HEALTH_RE.exec(status || '');
  if (!m) return null;
  return m[1].toLowerCase() === 'health: starting' ? 'starting' : m[1].toLowerCase();
}

async function listContainers(host) {
  const stdout = await run([...hostArgs(host), 'ps', '-a', '--format', '{{json .}}']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const raw = JSON.parse(line);
      const labels = parseLabels(raw.Labels);
      const networks = (raw.Networks || '')
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n && !IGNORED_NETWORKS.has(n));
      return {
        id: raw.ID,
        name: raw.Names,
        image: raw.Image,
        status: raw.Status,
        state: raw.State,
        health: parseHealth(raw.Status),
        ports: raw.Ports,
        networks,
        composeProject: labels['com.docker.compose.project'] || null,
        composeService: labels['com.docker.compose.service'] || null,
        alertsDisabled: labels['opendockwatch.alerts'] === 'off',
      };
    });
}

const BYTE_UNIT_MULT = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 };

function parseByteString(str) {
  if (!str) return 0;
  const m = str.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  const mult = BYTE_UNIT_MULT[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}

// docker stats reports these as "<in> / <out>", e.g. "1.2MB / 3.4MB"
function parseIOPair(str) {
  const [a, b] = (str || '').split('/').map((s) => s.trim());
  return { in: parseByteString(a), out: parseByteString(b) };
}

// MemUsage is reported as "<used> / <limit>", e.g. "512MiB / 2GiB"
function parseMemUsedBytes(memUsageStr) {
  return parseByteString((memUsageStr || '').split('/')[0]);
}

// docker stats reports NetIO/BlockIO as cumulative totals since start, which says nothing about
// "right now" - the real signal is the rate of change since the previous poll. A negative delta
// means the counter reset (container restarted) - treated as unknown, not a negative rate.
function computeRate(currentBytes, prevBytes, elapsedSec) {
  if (prevBytes == null || currentBytes == null || !elapsedSec || elapsedSec <= 0) return null;
  const delta = currentBytes - prevBytes;
  if (delta < 0) return null;
  return delta / elapsedSec;
}

function computeIoRates(current, prev, elapsedSec) {
  return {
    netRxRate: computeRate(current.netRxBytes, prev ? prev.netRxBytes : null, elapsedSec),
    netTxRate: computeRate(current.netTxBytes, prev ? prev.netTxBytes : null, elapsedSec),
    blockReadRate: computeRate(current.blockReadBytes, prev ? prev.blockReadBytes : null, elapsedSec),
    blockWriteRate: computeRate(current.blockWriteBytes, prev ? prev.blockWriteBytes : null, elapsedSec),
  };
}

async function getStats(host) {
  const stdout = await run([...hostArgs(host), 'stats', '--no-stream', '--format', '{{json .}}']);
  const byId = {};
  for (const line of stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const raw = JSON.parse(line);
    const netIO = parseIOPair(raw.NetIO);
    const blockIO = parseIOPair(raw.BlockIO);
    byId[raw.Container.slice(0, 12)] = {
      cpuPerc: raw.CPUPerc,
      memUsage: raw.MemUsage,
      memPerc: raw.MemPerc,
      netIO: raw.NetIO,
      blockIO: raw.BlockIO,
      netRxBytes: netIO.in,
      netTxBytes: netIO.out,
      blockReadBytes: blockIO.in,
      blockWriteBytes: blockIO.out,
    };
  }
  return byId;
}

// Emits an edge for a network-sharing pair unless both are in the same compose project - that
// relationship is already conveyed by the group box, and repeating it is most of the hairball
// in a typical stack. Cross-project/ungrouped pairs still get one (e.g. stacks sharing a proxy net).
function networkEdges(containers) {
  const byNetwork = new Map();
  for (const c of containers) {
    for (const net of c.networks) {
      if (!byNetwork.has(net)) byNetwork.set(net, []);
      byNetwork.get(net).push(c);
    }
  }
  const seen = new Set();
  const edges = [];
  for (const [net, members] of byNetwork.entries()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a.composeProject && b.composeProject && a.composeProject === b.composeProject) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: a.id, target: b.id, kind: 'network', label: net });
      }
    }
  }
  return edges;
}

// Resolves com.docker.compose.depends_on ("service:condition:restart" triples) into dependency
// edges; fetched via a dedicated `docker ps` format since parseLabels comma-splits the whole
// Labels blob and would truncate a multi-dependency value. Edge: source depends on target.
function dependsOnEdges(containers, dependsOnRaw) {
  const byProjectService = new Map();
  for (const c of containers) {
    if (!c.composeProject || !c.composeService) continue;
    const key = `${c.composeProject}::${c.composeService}`;
    if (!byProjectService.has(key)) byProjectService.set(key, []);
    byProjectService.get(key).push(c.id);
  }
  const byId = new Map(containers.map((c) => [c.id, c]));

  const edges = [];
  for (const line of (dependsOnRaw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    const id = tabIdx === -1 ? trimmed : trimmed.slice(0, tabIdx);
    const value = tabIdx === -1 ? '' : trimmed.slice(tabIdx + 1);
    if (!value) continue;
    const source = byId.get(id);
    if (!source || !source.composeProject) continue;
    for (const entry of value.split(',')) {
      const [service, condition] = entry.split(':');
      if (!service) continue;
      const targets = byProjectService.get(`${source.composeProject}::${service}`) || [];
      for (const targetId of targets) {
        if (targetId === id) continue;
        edges.push({ source: id, target: targetId, kind: 'depends_on', label: condition || null });
      }
    }
  }
  return edges;
}

// Resolves opendockwatch.depends_on into manual dependency edges - a compose-native alternative
// to hosts.json's `edges` array, declared on the service itself. Each entry is "target[:label]":
// resolves to a same-project service by short name first, else a literal container name.
function customDependsOnEdges(containers, customDependsOnRaw) {
  const byProjectService = new Map();
  for (const c of containers) {
    if (!c.composeProject || !c.composeService) continue;
    const key = `${c.composeProject}::${c.composeService}`;
    if (!byProjectService.has(key)) byProjectService.set(key, []);
    byProjectService.get(key).push(c.id);
  }
  const byName = new Map(containers.map((c) => [c.name, c.id]));
  const byId = new Map(containers.map((c) => [c.id, c]));

  const edges = [];
  for (const line of (customDependsOnRaw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    const id = tabIdx === -1 ? trimmed : trimmed.slice(0, tabIdx);
    const value = tabIdx === -1 ? '' : trimmed.slice(tabIdx + 1);
    if (!value) continue;
    const source = byId.get(id);
    if (!source) continue;
    for (const entry of value.split(',')) {
      const [rawTarget, rawLabel] = entry.split(':');
      const target = (rawTarget || '').trim();
      if (!target) continue;
      const sameProjectTargets = source.composeProject ? byProjectService.get(`${source.composeProject}::${target}`) : null;
      const targetIds =
        sameProjectTargets && sameProjectTargets.length ? sameProjectTargets : byName.has(target) ? [byName.get(target)] : [];
      for (const targetId of targetIds) {
        if (targetId === id) continue;
        edges.push({ source: id, target: targetId, kind: 'manual', label: rawLabel ? rawLabel.trim() : null });
      }
    }
  }
  return edges;
}

// Resolves each container's mount sources for tree mode. `{{.Mounts}}` truncates long bind-mount
// paths, so this uses its own `docker ps --no-trunc` call (hence the id sliced back to 12 chars).
// kind is inferred from the source string: "/" prefix -> bind; 64-hex -> anon volume; else named.
const ANON_VOLUME_RE = /^[0-9a-f]{64}$/i;

function parseMountsList(raw) {
  const byId = new Map();
  for (const line of (raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    const fullId = tabIdx === -1 ? trimmed : trimmed.slice(0, tabIdx);
    const value = tabIdx === -1 ? '' : trimmed.slice(tabIdx + 1);
    const id = fullId.slice(0, 12);
    const mounts = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((source) => ({ source, kind: source.startsWith('/') ? 'bind' : ANON_VOLUME_RE.test(source) ? 'volume-anon' : 'volume-named' }));
    byId.set(id, mounts);
  }
  return byId;
}

function manualEdges(containers, declared = []) {
  const byName = new Map(containers.map((c) => [c.name, c.id]));
  const edges = [];
  for (const e of declared) {
    const source = byName.get(e.from);
    const target = byName.get(e.to);
    if (source && target) {
      edges.push({ source, target, kind: 'manual', label: e.label || null });
    }
  }
  return edges;
}

// depends_on labels and mounts are fixed at container creation, so the cache key is the
// container-id set itself (create/destroy changes it, refetching immediately) with a TTL only
// as a backstop. `snapshot` reuses metricsCollector's cached poll to skip a second docker call.
const TOPOLOGY_META_TTL_MS = 60_000;
const topologyMetaCache = new Map(); // hostId -> { ts, signature, dependsOnRaw, customDependsOnRaw, mountsRaw }

async function getTopologyMeta(host, containers) {
  const signature = containers
    .map((c) => c.id)
    .sort()
    .join(',');
  const cached = topologyMetaCache.get(host.id);
  if (cached && cached.signature === signature && Date.now() - cached.ts < TOPOLOGY_META_TTL_MS) return cached;
  const [dependsOnRaw, customDependsOnRaw, mountsRaw] = await Promise.all([
    run([...hostArgs(host), 'ps', '-a', '--format', '{{.ID}}\t{{.Label "com.docker.compose.depends_on"}}']).catch(() => ''),
    run([...hostArgs(host), 'ps', '-a', '--format', '{{.ID}}\t{{.Label "opendockwatch.depends_on"}}']).catch(() => ''),
    run([...hostArgs(host), 'ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Mounts}}']).catch(() => ''),
  ]);
  const meta = { ts: Date.now(), signature, dependsOnRaw, customDependsOnRaw, mountsRaw };
  topologyMetaCache.set(host.id, meta);
  return meta;
}

// Called by metricsCollector.removeHost so a host deleted (or edited) through Settings doesn't
// leave its cached topology metadata behind for an id that may later be reused for a different
// daemon entirely.
function forgetHost(hostId) {
  topologyMetaCache.delete(hostId);
  lastCheckErrors.delete(hostId);
}

async function getTopology(host, snapshot) {
  const useSnapshot = snapshot && snapshot.containers && snapshot.containers.length;
  const containers = useSnapshot ? snapshot.containers : await listContainers(host);
  const [stats, meta] = await Promise.all([
    useSnapshot ? Promise.resolve(snapshot.stats || {}) : getStats(host).catch(() => ({})),
    getTopologyMeta(host, containers),
  ]);
  const { dependsOnRaw, customDependsOnRaw, mountsRaw } = meta;
  const mountsById = parseMountsList(mountsRaw);
  const nodes = containers.map((c) => {
    const s = stats[c.id];
    return {
      id: c.id,
      name: c.name,
      group: c.composeProject || 'ungrouped',
      state: c.state,
      status: c.status,
      health: c.health,
      image: c.image,
      composeService: c.composeService,
      ports: c.ports,
      networks: c.networks,
      mounts: mountsById.get(c.id) || [],
      cpuPerc: s ? parseFloat(s.cpuPerc) || 0 : null,
      memPerc: s ? parseFloat(s.memPerc) || 0 : null,
      netRxRate: s ? (s.netRxRate ?? null) : null,
      netTxRate: s ? (s.netTxRate ?? null) : null,
      blockReadRate: s ? (s.blockReadRate ?? null) : null,
      blockWriteRate: s ? (s.blockWriteRate ?? null) : null,
    };
  });
  const edges = [
    ...networkEdges(containers),
    ...dependsOnEdges(containers, dependsOnRaw),
    ...customDependsOnEdges(containers, customDependsOnRaw),
    ...manualEdges(containers, host.edges),
  ];
  return { nodes, edges };
}

// `docker inspect` is the one place env vars, mounts, labels, restart policy, and created time
// live - none of it comes back from `docker ps`/`docker stats`. Fetched on demand (container
// selection), not on the poll cycle, since unlike CPU/mem it can't change between polls.
async function getContainerInspect(host, id) {
  const stdout = await run([...hostArgs(host), 'inspect', id]);
  const [raw] = JSON.parse(stdout);
  return {
    createdAt: raw.Created,
    restartPolicy: raw.HostConfig?.RestartPolicy?.Name || 'no',
    restartMaxRetries: raw.HostConfig?.RestartPolicy?.MaximumRetryCount || 0,
    env: raw.Config?.Env || [],
    labels: raw.Config?.Labels || {},
    mounts: (raw.Mounts || []).map((m) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      rw: m.RW,
    })),
  };
}

// Config.Env entries are "KEY=value" and routinely hold DB passwords and API keys. Masks the
// value while keeping the key, so a read-only viewer still sees which variables a container has
// without the endpoint handing out every secret on every host. An empty value stays visibly empty.
const ENV_MASK = '••••••';

function maskEnvValues(env) {
  return (env || []).map((entry) => {
    const idx = entry.indexOf('=');
    if (idx === -1) return entry;
    const value = entry.slice(idx + 1);
    return `${entry.slice(0, idx)}=${value ? ENV_MASK : ''}`;
  });
}

// docker stop/restart wait out a 10s SIGTERM grace before SIGKILL - the same length as
// CMD_TIMEOUT_MS, so execFile could kill the CLI and report failure a moment before the stop
// actually completes daemon-side. Give action commands longer so a slow stop doesn't false-report.
const CONTAINER_ACTION_TIMEOUT_MS = 30_000;

async function containerAction(host, id, action) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  await run([...hostArgs(host), action, id], CONTAINER_ACTION_TIMEOUT_MS);
}

function streamLogs(host, id, { tail = 200 } = {}) {
  return spawn('docker', [...hostArgs(host), 'logs', '-f', '--timestamps', '--tail', String(tail), id]);
}

// Same as streamLogs but without -f, for a one-shot download instead of a live tail.
function downloadLogs(host, id, { tail = 1000 } = {}) {
  return spawn('docker', [...hostArgs(host), 'logs', '--timestamps', '--tail', String(tail), id]);
}

function streamEvents(host) {
  return spawn('docker', [...hostArgs(host), 'events', '--format', '{{json .}}']);
}

// `docker system df` deduplicates shared image layers by walking the whole overlay2 tree, so it
// gets its own much longer timeout - it is not in the same cost class as any other call here.
// **How much longer depends on the storage, not on the number of images**: measured on the same
// 32-image host, sub-second on native Linux against ~40-75s on WSL2/Docker Desktop, where the
// layers live on a virtual disk behind a 9p/virtiofs hop and every `stat` pays for it. The old
// 30s was picked on Linux and meant this call could never once succeed on WSL2 - the Disk panel
// was permanently empty and a heavyweight process was spawned and killed every 60s forever. Note
// the 40-75s spread across runs on one host: no fixed value is reliably right, which is why
// metricsCollector also backs off on failure rather than trusting this number alone.
const DISK_USAGE_TIMEOUT_MS = Number(process.env.DISK_USAGE_TIMEOUT_MS) || 120_000;

async function getDiskUsage(host) {
  const stdout = await run([...hostArgs(host), 'system', 'df', '--format', '{{json .}}'], DISK_USAGE_TIMEOUT_MS);
  const rows = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return rows.map((r) => ({
    type: r.Type,
    total: r.TotalCount,
    active: r.Active,
    size: r.Size,
    reclaimable: r.Reclaimable,
  }));
}

// `docker system df -v`'s parsed JSON -> a clean, largest-first (what you'd prune) per-image
// list. Kept pure and separate from getDiskUsageImages so it's unit-testable without mocking
// child_process, same as the other CLI-output parsers in this file.
function parseDiskUsageImages(data) {
  const images = (data && data.Images) || [];
  return images
    .map((r) => ({
      id: (r.ID || '').replace(/^sha256:/, '').slice(0, 12),
      repository: r.Repository && r.Repository !== '<none>' ? r.Repository : null,
      tag: r.Tag && r.Tag !== '<none>' ? r.Tag : null,
      size: r.Size,
      sharedSize: r.SharedSize,
      uniqueSize: r.UniqueSize,
      containers: parseInt(r.Containers, 10) || 0,
      createdSince: r.CreatedSince,
    }))
    .sort((a, b) => parseByteString(b.size) - parseByteString(a.size));
}

// The -v form returns a per-image breakdown instead of just the aggregate type rows above -
// fetched on demand (HostCard's Images disclosure), not the regular disk-usage poll, since
// walking every image's layer sizes is extra work nobody needs unless they open the list.
async function getDiskUsageImages(host) {
  const stdout = await run([...hostArgs(host), 'system', 'df', '-v', '--format', '{{json .}}'], DISK_USAGE_TIMEOUT_MS);
  return parseDiskUsageImages(JSON.parse(stdout.trim()));
}

module.exports = {
  checkHost,
  testHostConnection,
  forgetHost,
  listContainers,
  containerAction,
  streamLogs,
  downloadLogs,
  streamEvents,
  getStats,
  getTopology,
  getHostInfo,
  getDiskUsage,
  getDiskUsageImages,
  parseDiskUsageImages,
  getContainerInspect,
  maskEnvValues,
  parseByteString,
  parseMemUsedBytes,
  parseLabels,
  parseHealth,
  networkEdges,
  dependsOnEdges,
  customDependsOnEdges,
  parseMountsList,
  computeRate,
  computeIoRates,
  dockerCommandError,
  poolStats,
  lastCheckError,
  DISK_USAGE_TIMEOUT_MS,
  CONTAINER_ACTION_TIMEOUT_MS,
};
