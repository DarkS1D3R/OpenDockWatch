// Resolves what the mem SparkTile's corner box shows: os.totalmem()'s physical-host total vs
// docker info's MemTotal (scoped to an LXC/cgroup ceiling). When they diverge by more than
// HOST_MEM_DIVERGENCE_RATIO (a capping LXC), shows the docker total primary, os figure secondary.

import { formatGB } from '../format.js';

export const HOST_MEM_DIVERGENCE_RATIO = 1.05;

function fmtGB(bytes) {
  return formatGB(bytes || 0);
}

// osTotalBytes null on a remote SSH host (the only "no data" case, returned as null not zeroed).
// dockerUsedBytes (HostCard's memSamples) approximates "usage inside the LXC" in the divergent
// case - a deliberate simplification, since it can't see non-Docker processes in the LXC (sshd, cron, ...).
export function resolveHostMemoryDisplay({ osUsedBytes, osTotalBytes, dockerTotalBytes, dockerUsedBytes }) {
  if (osTotalBytes == null) return null;

  const divergent = osTotalBytes > (dockerTotalBytes || 0) * HOST_MEM_DIVERGENCE_RATIO;
  if (!divergent) {
    return {
      heading: 'host total',
      label: `${fmtGB(osUsedBytes)} / ${fmtGB(osTotalBytes)}`,
      seriesLabel: 'host total',
      extraLabel: null,
    };
  }
  return {
    heading: 'LXC total',
    label: `${fmtGB(dockerUsedBytes)} / ${fmtGB(dockerTotalBytes)}`,
    seriesLabel: 'physical host',
    extraLabel: `physical host: ${fmtGB(osTotalBytes)}`,
  };
}
