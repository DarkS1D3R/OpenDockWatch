// Pure wording and action rules for a container row (List view, detail panel). See public/CLAUDE.md.
import { MEM_UNIT_BYTES, parsePublishedPorts } from '../format.js';

// Which of start/stop/restart apply to a container in this docker state. Start does not unpause,
// and a restarting container is crash-looping, so Stop is the one thing worth offering it.
export function rowActions(state) {
  if (state === 'running' || state === 'paused') return ['stop', 'restart'];
  if (state === 'restarting') return ['stop'];
  if (state === 'removing') return [];
  return ['start'];
}

const ACTION_LABELS = { start: 'Start', stop: 'Stop', restart: 'Restart' };
export function actionLabel(action) {
  return ACTION_LABELS[action];
}

// A compose project's batch actions: each is offered when at least one container would act on it.
export function groupActions(containers) {
  const offered = new Set(containers.flatMap((c) => rowActions(c.state)));
  return ['start', 'stop', 'restart'].filter((a) => offered.has(a));
}

const UNIT_SHORT = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };

// "Up 30 minutes (healthy)" -> "Up 30m". The health suffix goes because the dot beside it says the
// same; "(Paused)" and exit codes stay. The full text belongs in the cell's title.
export function shortStatus(status) {
  if (!status) return '';
  return status
    .replace(/\s*\((?:healthy|unhealthy|health: starting)\)/i, '')
    .replace(/\bLess than a second\b/i, '<1s')
    .replace(/\b(?:About )?an? (second|minute|hour|day|week|month|year)\b/gi, (_, u) => `1${UNIT_SHORT[u.toLowerCase()]}`)
    .replace(/\b(\d+) (second|minute|hour|day|week|month|year)s?\b/gi, (_, n, u) => `${n}${UNIT_SHORT[u.toLowerCase()]}`);
}

function parseBytes(str) {
  const m = String(str || '')
    .trim()
    .match(/^([\d.]+)\s*([A-Za-z]+)$/);
  return m ? parseFloat(m[1]) * (MEM_UNIT_BYTES[m[2].toLowerCase()] || 1) : null;
}

// docker stats' "516KiB / 15.24GiB" -> "516KiB". With no memory limit set, the second figure is the
// host's memory, which reads as a cap it is not; a real limit (below the host total) is kept.
export function memoryCell(memUsage, hostMemTotalBytes) {
  if (!memUsage) return '';
  const [used, limit] = memUsage.split('/').map((s) => s.trim());
  if (!limit) return used;
  const limitBytes = parseBytes(limit);
  if (!hostMemTotalBytes || limitBytes == null) return memUsage;
  return limitBytes < hostMemTotalBytes * 0.99 ? `${used} / ${limit}` : used;
}

// Published ports only, in docker run's "host:container" notation - the same as the Flow nodes.
export function portsCell(ports) {
  return parsePublishedPorts(ports);
}
