const os = require('os');

// Real host-wide CPU/memory usage - every process on the machine, not just the containers this
// app itself watches (the existing host_cpu/host_mem numbers are a sum of container stats, which
// undercounts anything running outside Docker). Only meaningful for the local host Node itself
// runs on - a remote SSH host has no equivalent without installing an agent there, so callers
// should only use this when a host has no dockerHost set (see hasLocalHost in hosts.js).
//
// Node reads os.cpus()/os.totalmem() from /proc, which is not cgroup-virtualized - if
// OpenDockWatch itself runs in a container with a CPU/memory limit set, these still report the
// real host's figures rather than the container's limit. See the README for this caveat.

function sampleCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

// A single sampleCpuTimes() snapshot is only cumulative jiffies since boot, not an instantaneous
// percentage - needs a delta between two samples, same idea as computeIoRates in docker.js for
// container NET/DISK rates. Returns null with no previous sample (first poll) or no elapsed time.
function computeCpuPercent(prevSample, sample) {
  if (!prevSample) return null;
  const idleDelta = sample.idle - prevSample.idle;
  const totalDelta = sample.total - prevSample.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function getMemUsage() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return { totalBytes, usedBytes: totalBytes - freeBytes };
}

module.exports = { sampleCpuTimes, computeCpuPercent, getMemUsage };
