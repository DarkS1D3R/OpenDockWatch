// How the detail panel words a container's resource limits next to its live usage. `limits` is the
// server's parseResourceLimits shape, where null means "no limit" - a different fact from "not
// loaded yet", which is why each of these takes the whole object and returns null for undefined.

const BINARY_UNITS = [
  [1024 ** 3, 'GiB'],
  [1024 ** 2, 'MiB'],
  [1024, 'KiB'],
];

// Binary units, not format.js's decimal formatBytes: a limit is set as `512m` and shown by docker
// as 512MiB, so "536.9 MB" would read as a different number than the one someone configured.
function formatLimitBytes(bytes) {
  for (const [threshold, unit] of BINARY_UNITS) {
    if (bytes >= threshold) return `${Number((bytes / threshold).toFixed(2))} ${unit}`;
  }
  return `${bytes} B`;
}

// Null when no CPU limit is set, like the PID limit: the panel shows this as "· limit <label>",
// and unlike memory, nothing in the CPU row needs a "no limit" caveat to read correctly.
export function cpuLimitLabel(limits) {
  if (!limits || limits.cpuLimit === null) return null;
  // 1.5 CPUs, 2 CPUs, 0.25 CPUs - trailing zeros trimmed, and "1 CPU" singular.
  const n = Number(limits.cpuLimit.toFixed(2));
  return `${n} ${n === 1 ? 'CPU' : 'CPUs'}`;
}

export function memoryLimitLabel(limits) {
  if (!limits) return null;
  return limits.memoryLimitBytes === null ? 'no limit' : formatLimitBytes(limits.memoryLimitBytes);
}

// Only worth a row when one is set - almost every container has none, and a "no limit" line on all
// of them would be noise beside the two that matter.
export function pidsLimitLabel(limits) {
  return limits && limits.pidsLimit !== null ? String(limits.pidsLimit) : null;
}
