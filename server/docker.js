const { execFile, spawn } = require('child_process');

const CMD_TIMEOUT_MS = 10_000;
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

function hostArgs(host) {
  return host && host.dockerHost ? ['-H', host.dockerHost] : [];
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: CMD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  for (const members of byNetwork.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a.composeProject && b.composeProject && a.composeProject === b.composeProject) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: a.id, target: b.id, kind: 'network' });
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

async function getTopology(host) {
  const containers = await listContainers(host);
  const [stats, dependsOnRaw] = await Promise.all([
    getStats(host).catch(() => ({})),
    run([...hostArgs(host), 'ps', '-a', '--format', '{{.ID}}\t{{.Label "com.docker.compose.depends_on"}}']).catch(() => ''),
  ]);
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
      cpuPerc: s ? parseFloat(s.cpuPerc) || 0 : null,
      memPerc: s ? parseFloat(s.memPerc) || 0 : null,
    };
  });
  const edges = [...networkEdges(containers), ...dependsOnEdges(containers, dependsOnRaw), ...manualEdges(containers, host.edges)];
  return { nodes, edges };
}

async function containerAction(host, id, action) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  await run([...hostArgs(host), action, id]);
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

async function getDiskUsage(host) {
  const stdout = await run([...hostArgs(host), 'system', 'df', '--format', '{{json .}}']);
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
  parseByteString,
  parseMemUsedBytes,
  parseLabels,
  parseHealth,
  networkEdges,
  dependsOnEdges,
};
