// Display logic for the Hosts tab (HostsOverview.js) over GET /api/overview's rows, kept pure so it is
// unit-tested without mounting the component. See server/overview.js for what each row carries.

import { formatGB } from '../format.js';
import { formatDuration } from './duration.js';

const STATUS_ORDER = { down: 0, warning: 1, pending: 2, ok: 3 };

export const STATUS_LABELS = { down: 'Unreachable', warning: 'Needs a look', pending: 'Waiting for first poll', ok: 'OK' };

// "Podman 5.8.7" or "Docker 29.1.3"; a host whose engine isn't known yet shows the bare version.
export function engineLabel(info) {
  if (!info || !info.serverVersion) return '';
  if (info.engine === 'podman') return `Podman ${info.serverVersion}`;
  if (info.engine === 'docker') return `Docker ${info.serverVersion}`;
  return info.serverVersion;
}

// Worst first, so a problem is on the top row however many hosts there are. Ties keep hosts.json order.
export function sortOverviewRows(rows) {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (STATUS_ORDER[a.row.status] ?? 9) - (STATUS_ORDER[b.row.status] ?? 9) || a.i - b.i)
    .map((x) => x.row);
}

// The one line above the table that answers "is anything wrong anywhere" before reading a row.
export function overviewSummary(rows) {
  if (!rows.length) return 'No hosts configured.';
  const down = rows.filter((r) => r.status === 'down').length;
  const warning = rows.filter((r) => r.status === 'warning').length;
  const alerts = rows.reduce((n, r) => n + (r.openAlerts || 0), 0);
  const hosts = `${rows.length} host${rows.length === 1 ? '' : 's'}`;
  if (!down && !warning) return rows.every((r) => r.status === 'ok') ? `All ${hosts} OK.` : `${hosts}, none with a problem so far.`;
  const parts = [];
  if (down) parts.push(`${down} unreachable`);
  if (warning) parts.push(`${warning} need${warning === 1 ? 's' : ''} a look`);
  if (alerts) parts.push(`${alerts} open alert${alerts === 1 ? '' : 's'}`);
  return `${hosts}: ${parts.join(', ')}.`;
}

export function containersLabel(row) {
  const c = row.containers;
  if (!c) return '—';
  return `${c.running} / ${c.total} running`;
}

// The parts of a host's container state that make it 'warning' - shown under the count.
export function containerProblems(row) {
  const c = row.containers;
  if (!c) return [];
  const out = [];
  if (c.unhealthy) out.push(`${c.unhealthy} unhealthy`);
  if (c.restarting) out.push(`${c.restarting} restarting`);
  return out;
}

export function cpuLabel(row) {
  return Number.isFinite(row.cpuPercent) ? `${row.cpuPercent.toFixed(1)}%` : '—';
}

export function memLabel(row) {
  if (!Number.isFinite(row.memUsedBytes)) return '—';
  if (!row.memTotalBytes) return formatGB(row.memUsedBytes);
  return `${formatGB(row.memUsedBytes)} / ${formatGB(row.memTotalBytes)}`;
}

export function memPercent(row) {
  if (!Number.isFinite(row.memUsedBytes) || !row.memTotalBytes) return null;
  return (row.memUsedBytes / row.memTotalBytes) * 100;
}

// "for 2h 10m" under an unreachable host; null when the outage start is not on record.
export function downForLabel(row, now = Date.now()) {
  if (row.status !== 'down' || !row.downSince) return null;
  return `for ${formatDuration(Math.max(0, now - row.downSince))}`;
}
