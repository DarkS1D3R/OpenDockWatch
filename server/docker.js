const { execFile, spawn } = require('child_process');

const CMD_TIMEOUT_MS = 10_000;
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

function hostArgs(host) {
  return host && host.dockerHost ? ['-H', host.dockerHost] : [];
}

function run(args, timeoutMs = CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
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

async function checkHost(host) {
  try {
    await run([...hostArgs(host), 'version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
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

// docker stats reports NetIO/BlockIO as cumulative totals since the container started, which
// carries no information about "right now" - a month-old container just reads e.g. "48GB / 52GB"
// forever. The actual signal is the rate of change, computed from the delta against the previous
// poll's cumulative bytes for the same container, over the elapsed time between polls. A negative
// delta means the counter reset (container restarted since the last poll) - treated as unknown
// rather than reported as a negative rate.
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

// Emits an edge for a network-sharing pair unless they're both in the same compose project -
// that relationship is already conveyed by the group box, and drawing it again is most of the
// hairball in a typical multi-service compose stack. Cross-project or ungrouped pairs still get
// an edge, since that's a genuinely useful signal (e.g. two separate stacks sharing a proxy net).
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

// Resolves com.docker.compose.depends_on into real dependency edges. That label is a
// comma-separated list of "service:condition:restart" triples, which is why it's fetched via a
// dedicated `docker ps` format rather than pulled out of the general Labels string already parsed
// by parseLabels - that field is comma-split for the *whole* labels blob, so a multi-dependency
// depends_on value would get silently truncated to its first entry.
//
// dependsOnRaw is tab-separated "<containerId>\t<depends_on value>" lines, one per container
// (value may be empty). Arrow direction: source is the dependent container, target is what it
// depends on - matches "A depends_on B" read as an edge from A to B.
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

// Resolves each container's mount sources for the Flow view's tree mode. Docker's `{{.Mounts}}`
// format truncates long bind-mount source paths (and, with --no-trunc, so does the paired
// {{.ID}} column - it comes back as the full 64-char id instead of the usual 12-char short one),
// which is why this is fetched via its own `docker ps --no-trunc` call rather than reusing
// listContainers's output, and why the id is sliced back to 12 chars to match it.
//
// raw is tab-separated "<full 64-char id>\t<mounts>" lines, one per container (mounts may be
// empty). kind is inferred from the source string alone (Docker doesn't return mount type in this
// format): starts with "/" -> bind; a bare 64-hex string -> Docker's own anonymous volume name;
// anything else -> a named volume.
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

// `snapshot` is metricsCollector's cached poll result for this host (containers + stats, already
// fetched on its own 5s cadence) - reusing it here avoids a second, independent round of `docker
// ps`/`docker stats` calls on every topology request, and it's the only place the rx/tx and
// read/write rates (computed by metricsCollector from consecutive polls) are available. Falls
// back to a fresh live fetch when there's no usable snapshot yet (e.g. right after server start).
async function getTopology(host, snapshot) {
  const useSnapshot = snapshot && snapshot.containers && snapshot.containers.length;
  const containers = useSnapshot ? snapshot.containers : await listContainers(host);
  const [stats, dependsOnRaw, mountsRaw] = await Promise.all([
    useSnapshot ? Promise.resolve(snapshot.stats || {}) : getStats(host).catch(() => ({})),
    run([...hostArgs(host), 'ps', '-a', '--format', '{{.ID}}\t{{.Label "com.docker.compose.depends_on"}}']).catch(() => ''),
    run([...hostArgs(host), 'ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Mounts}}']).catch(() => ''),
  ]);
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
  const edges = [...networkEdges(containers), ...dependsOnEdges(containers, dependsOnRaw), ...manualEdges(containers, host.edges)];
  return { nodes, edges };
}

// `docker inspect` is the one place env vars, mounts, labels, restart policy, and created time
// live - none of it comes back from `docker ps`/`docker stats`. Fetched on demand (container
// selection) rather than on the metrics poll cycle: unlike CPU/mem this doesn't change from one
// poll to the next, so there's no reason to shell out for it every 5s for every container.
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

// docker stop/restart send SIGTERM and wait out a 10s grace period before SIGKILL-ing a
// container that ignores it - the same length as CMD_TIMEOUT_MS, so execFile could kill the
// CLI and report failure a moment before the stop actually completes daemon-side. Give action
// commands longer than the grace period so a slow-to-stop container doesn't false-report.
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

// `docker system df` walks the whole build cache, which - unlike the other commands here, all
// polled every 5s - can genuinely take well over CMD_TIMEOUT_MS on a host with a lot of build
// history, so it gets a longer timeout of its own. Safe to be generous here specifically: this
// is only ever called from the 60s disk-usage poll (see metricsCollector.js's DISK_POLL_MS), not
// the 5s container poll, so a slow response here doesn't delay anything time-sensitive.
const DISK_USAGE_TIMEOUT_MS = 30_000;

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

// `docker system df -v`'s parsed JSON -> a clean, sorted (largest first - what you'd actually
// want to look at when deciding what to prune) per-image list. Kept pure and separate from
// getDiskUsageImages below so it's unit-testable without mocking child_process, same as the
// other CLI-output parsers in this file.
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

// The -v (verbose) form of the same command returns one JSON object with a per-image (and
// per-container/volume/build-cache) breakdown instead of just the aggregate type rows above -
// only fetched on demand (see HostCard's Images disclosure), not on the regular disk-usage poll,
// since walking every image's shared/unique layer sizes is extra work nobody needs unless they
// actually open the list.
async function getDiskUsageImages(host) {
  const stdout = await run([...hostArgs(host), 'system', 'df', '-v', '--format', '{{json .}}'], DISK_USAGE_TIMEOUT_MS);
  return parseDiskUsageImages(JSON.parse(stdout.trim()));
}

module.exports = {
  checkHost,
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
  parseByteString,
  parseMemUsedBytes,
  parseLabels,
  parseHealth,
  networkEdges,
  dependsOnEdges,
  parseMountsList,
  computeRate,
  computeIoRates,
};
