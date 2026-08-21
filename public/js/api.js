// A browser allows ~6 connections per origin over HTTP/1.1, and this app permanently holds some
// open for SSE streams - a fetch with no timeout is a connection slot held hostage, and enough of
// them piling up leaves the tab unable to issue any request. A request that gives up releases its slot.
const DEFAULT_TIMEOUT_MS = 15_000;

async function apiFetch(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = opts;
  let res;
  try {
    res = await fetch(url, { ...rest, signal: rest.signal || AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // "signal is aborted without reason" tells the user nothing - name the timeout instead.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
    }
    throw err;
  }
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

// Deliberately not apiFetch, and deliberately not async: this is called from the global error
// handlers, so it must never throw (anything it threw would land back in the handler that called
// it and loop), never redirect on 401 the way apiFetch does, and never retry. keepalive lets a
// report survive the page unloading, which is exactly when a boot failure tends to be reported.
export function reportClientError(payload) {
  try {
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* a failed report must never become an error of its own */
  }
}

export async function apiGetHosts() {
  return jsonOrThrow(await apiFetch('/api/hosts'));
}

// fresh bypasses the server's snapshot for the one case where up-to-POLL_MS staleness is visible
// to the user: the refetch right after a start/stop/restart.
export async function apiGetContainers(hostId, { fresh = false } = {}) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/containers${fresh ? '?fresh=1' : ''}`));
}

// Containers, stats, host history and alerts in one request - everything the poll loop needs that
// the server already holds in memory. Four serial fetches per cycle spent four round trips and
// four of the browser's ~6 connections on it; see public/CLAUDE.md. Topology stays separate (it can
// shell out) and the caller runs it alongside this one rather than after it.
export async function apiGetDashboard(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/dashboard`));
}

export async function apiGetTopology(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/topology`));
}

export async function apiGetHostInfo(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/info`));
}

// Longer than the default: a stop/restart waits out docker's 10s SIGTERM grace period before
// SIGKILL, and server-side containerAction allows 30s for it - giving up at 15s here would
// report failure for an action that was about to succeed.
export async function apiContainerAction(hostId, id, action) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/containers/${id}/${action}`, { method: 'POST', timeoutMs: 45_000 }));
}

export async function apiGetContainerInspect(hostId, id) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/containers/${id}/inspect`));
}

export function logsUrl(hostId, id, tail) {
  return `/api/hosts/${hostId}/containers/${id}/logs?tail=${tail}`;
}

export function downloadLogsUrl(hostId, id, tail) {
  return `/api/hosts/${hostId}/containers/${id}/logs/download?tail=${tail}`;
}

export async function apiLogout() {
  await fetch('/logout', { method: 'POST' });
}

export async function apiGetSession() {
  return jsonOrThrow(await apiFetch('/api/session'));
}

export async function apiGetDiskUsage(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/disk-usage`));
}

// `docker system df -v` walks every image's shared/unique layer sizes and gets 30s server-side,
// so this needs headroom over the default too.
export async function apiGetDiskUsageImages(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/disk-usage/images`, { timeoutMs: 40_000 }));
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

export async function apiClearEvents(hostId) {
  return jsonOrThrow(await apiFetch(`/api/hosts/${hostId}/events`, { method: 'DELETE' }));
}

export async function apiAckAlert(id) {
  return jsonOrThrow(await apiFetch(`/api/alerts/${id}/ack`, { method: 'POST' }));
}

export async function apiAckAllAlerts(hostId) {
  return jsonOrThrow(await apiFetch(`/api/alerts/ack-all?hostId=${encodeURIComponent(hostId)}`, { method: 'POST' }));
}

export async function apiClearAlerts(hostId) {
  return jsonOrThrow(await apiFetch(`/api/alerts?hostId=${encodeURIComponent(hostId)}`, { method: 'DELETE' }));
}

export async function apiGetDefaultView() {
  return jsonOrThrow(await apiFetch('/api/settings/default-view'));
}

export async function apiSaveDefaultView(defaultView) {
  return jsonOrThrow(
    await apiFetch('/api/settings/default-view', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultView }),
    })
  );
}

export async function apiClearDefaultView() {
  return jsonOrThrow(await apiFetch('/api/settings/default-view', { method: 'DELETE' }));
}

export async function apiGetWebhookConfig() {
  return jsonOrThrow(await apiFetch('/api/settings/webhook'));
}

export async function apiSaveWebhookConfig(url, format) {
  return jsonOrThrow(
    await apiFetch('/api/settings/webhook', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format }),
    })
  );
}

export async function apiClearWebhookConfig() {
  return jsonOrThrow(await apiFetch('/api/settings/webhook', { method: 'DELETE' }));
}

export async function apiTestWebhook() {
  return jsonOrThrow(await apiFetch('/api/settings/webhook/test', { method: 'POST' }));
}

export async function apiGetThresholdConfig() {
  return jsonOrThrow(await apiFetch('/api/settings/thresholds'));
}

export async function apiSaveThresholdConfig(values) {
  return jsonOrThrow(
    await apiFetch('/api/settings/thresholds', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
  );
}

export async function apiClearThresholdConfig() {
  return jsonOrThrow(await apiFetch('/api/settings/thresholds', { method: 'DELETE' }));
}

export async function apiGetHostsConfig() {
  return jsonOrThrow(await apiFetch('/api/settings/hosts'));
}

export async function apiAddHost(host) {
  return jsonOrThrow(
    await apiFetch('/api/settings/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(host),
    })
  );
}

export async function apiUpdateHost(id, host) {
  return jsonOrThrow(
    await apiFetch(`/api/settings/hosts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(host),
    })
  );
}

export async function apiDeleteHost(id) {
  return jsonOrThrow(await apiFetch(`/api/settings/hosts/${id}`, { method: 'DELETE' }));
}

// The SSH reachability probe behind this allows 20s of its own for a first connection on a slow
// link (see SSH_CHECK_TIMEOUT_MS) - the point of the button is to wait for the real answer.
export async function apiTestHost(id) {
  return jsonOrThrow(await apiFetch(`/api/settings/hosts/${id}/test`, { method: 'POST', timeoutMs: 30_000 }));
}

export async function apiGetContainerRules() {
  return jsonOrThrow(await apiFetch('/api/settings/container-rules'));
}

export async function apiAddContainerRule(rule) {
  return jsonOrThrow(
    await apiFetch('/api/settings/container-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    })
  );
}

export async function apiUpdateContainerRule(id, rule) {
  return jsonOrThrow(
    await apiFetch(`/api/settings/container-rules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    })
  );
}

export async function apiDeleteContainerRule(id) {
  return jsonOrThrow(await apiFetch(`/api/settings/container-rules/${id}`, { method: 'DELETE' }));
}

export async function apiReorderContainerRules(orderedIds) {
  return jsonOrThrow(
    await apiFetch('/api/settings/container-rules/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    })
  );
}
