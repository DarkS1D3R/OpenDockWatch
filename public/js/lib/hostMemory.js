// Resolves what the mem SparkTile's corner box should show, given both the os-based host-wide
// total (hostUsage.js's os.totalmem() - the *physical* machine, once nested one level deep - see
// the caveat comment there) and the docker-reported total (docker info's MemTotal, which stays
// correctly scoped to an LXC/cgroup ceiling since dockerd itself isn't re-nested the way this
// app's own Node process is). When the two diverge by more than HOST_MEM_DIVERGENCE_RATIO,
// something between this app and the physical machine - most commonly a Proxmox LXC container -
// is capping memory below what os.totalmem() sees, so the box repurposes to show the capped
// (docker) total as primary and demotes the os-based figure to a secondary "physical host" line,
// rather than mislabeling the physical machine's total as if it were this deployment's own
// ceiling. No DOM/Vue - pure, so it's unit-testable the same way spark.js is.

export const HOST_MEM_DIVERGENCE_RATIO = 1.05;

function fmtGB(bytes) {
  return `${((bytes || 0) / 1e9).toFixed(1)} GB`;
}

// osUsedBytes/osTotalBytes: hostUsage.js-derived, local-host-only (osTotalBytes is null/undefined
// on a remote SSH host - see HostCard's hostSystemUsage - which is the only "no data at all" case,
// returned as null rather than a zeroed display). dockerTotalBytes: docker info's MemTotal, always
// present on a reachable local host. dockerUsedBytes: this app's own Docker-containers'-summed
// current usage (HostCard's memSamples, last element) - used as an approximation of "usage inside
// the LXC" in the divergent case. This is a deliberate simplification: it doesn't count non-Docker
// processes running directly in the LXC (sshd, cron, lxcfs, systemd, ...), since there's no way to
// read the LXC's true total usage from inside a second, separately-nested Docker container without
// extra host-level plumbing (e.g. bind-mounting the LXC's own lxcfs-corrected /proc/meminfo in).
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
