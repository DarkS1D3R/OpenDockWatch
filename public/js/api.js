async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthenticated');
  }
  return res;
}

async function jsonOrThrow(res) {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* body wasn't JSON, keep statusText */
    }
    throw new Error(message);
  }
  return res.json();
}

export async function apiGetHosts() {
  return jsonOrThrow(await apiFetch('/api/hosts'));
}

export async function apiGetContainers(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/containers`));
}

export async function apiGetStats(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/stats`));
}

export async function apiGetTopology(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/topology`));
}

export async function apiGetHostInfo(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/info`));
}

export async function apiContainerAction(hostId, id, action) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/containers/${id}/${action}`, { method: 'POST' }));
}

export function logsUrl(hostId, id, tail) {
  return `/api/hosts/${hostId}/containers/${id}/logs?tail=${tail}`;
}

export async function apiLogout() {
  await fetch('/logout', { method: 'POST' });
}

export async function apiGetDiskUsage(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/disk-usage`));
}

export async function apiGetMetricsHistory(hostId, { range = '1h', containerId } = {}) {
  const qs = new URLSearchParams({ range, ...(containerId ? { containerId } : {}) });
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/metrics/history?${qs}`));
}

export async function apiGetEvents(hostId, { since, limit } = {}) {
  const qs = new URLSearchParams({ ...(since ? { since } : {}), ...(limit ? { limit } : {}) });
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/events?${qs}`));
}

export function eventsStreamUrl(hostId) {
  return `/api/hosts/${hostId}/events/stream`;
}

export async function apiGetAlerts(hostId, limit) {
  const qs = new URLSearchParams({ ...(hostId ? { hostId } : {}), ...(limit ? { limit } : {}) });
  return jsonOrThrow(await apiFetch(`/api/alerts?${qs}`));
}

export async function apiAckAlert(id) {
  return jsonOrThrow(await apiFetch(`/api/alerts/${id}/ack`, { method: 'POST' }));
}
