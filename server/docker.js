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

function networkEdges(containers) {
  const byNetwork = new Map();
  for (const c of containers) {
    for (const net of c.networks) {
      if (!byNetwork.has(net)) byNetwork.set(net, []);
      byNetwork.get(net).push(c.id);
    }
  }
  const seen = new Set();
  const edges = [];
  for (const ids of byNetwork.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = [ids[i], ids[j]].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: ids[i], target: ids[j], kind: 'network' });
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
  const nodes = containers.map((c) => ({
    id: c.id,
    name: c.name,
    group: c.composeProject || 'ungrouped',
    state: c.state,
    status: c.status,
    health: c.health,
    image: c.image,
    composeService: c.composeService,
  }));
  const edges = [...networkEdges(containers), ...manualEdges(containers, host.edges)];
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
};
