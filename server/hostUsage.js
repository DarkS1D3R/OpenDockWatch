const os = require('os');

// Real host-wide CPU/memory usage (every process on the machine, not just watched containers) -
// only meaningful for the local host Node runs on, not a remote SSH host (see hasLocalHost in
// hosts.js). Not cgroup-virtualized: in a limited container this reports the real host, not the limit.
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
