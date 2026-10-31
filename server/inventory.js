// The Resources tab: images, volumes and networks per host, read-only. Refreshed in the background
// and served from memory, because `system df -v` can outlast a request (see server/CLAUDE.md).
const docker = require('./docker');
const logger = require('./logger');

// A view older than this is refreshed when someone next looks at it. On demand only - nothing
// polls this, so a host nobody opens the tab for costs nothing.
const INVENTORY_TTL_MS = 5 * 60_000;
// The Refresh button can't run `system df -v` back to back; one per host per this interval.
const MIN_FORCED_REFRESH_MS = 15_000;

const states = new Map();

function newState() {
  return {
    df: null, // { images, volumes, buildCache }
    dfTs: null,
    dfError: null,
    networks: null,
    networksTs: null,
    networksError: null,
    startedAt: 0,
    inFlight: null,
  };
}

function errorText(err) {
  return (err && (err.stderr || err.message)) || String(err);
}

// One refresh per host at a time; a second caller shares it. Each half lands as soon as it
// settles, so networks (fast) show while images and volumes are still being measured.
function refresh(host) {
  let state = states.get(host.id);
  if (!state) {
    state = newState();
    states.set(host.id, state);
  }
  if (state.inFlight) return state.inFlight;
  state.startedAt = Date.now();
  const live = () => states.get(host.id) === state; // a host edit/delete mid-refresh drops the result
  const dfPart = docker.getInventoryDf(host).then(
    (df) => {
      if (!live()) return;
      Object.assign(state, { df, dfTs: Date.now(), dfError: null });
    },
    (err) => {
      if (!live()) return;
      state.dfError = errorText(err);
      logger.warn('inventory.df.failed', { host: host.id, error: state.dfError });
    }
  );
  const netPart = docker.getNetworks(host).then(
    (networks) => {
      if (!live()) return;
      Object.assign(state, { networks, networksTs: Date.now(), networksError: null });
    },
    (err) => {
      if (!live()) return;
      state.networksError = errorText(err);
      logger.warn('inventory.networks.failed', { host: host.id, error: state.networksError });
    }
  );
  state.inFlight = Promise.all([dfPart, netPart]).finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

// Which containers (by name) sit on each network, from the collector's `ps -a` list. `unused` is
// null, not false, while that list is unknown: "nothing uses it" needs a list to be true of.
function withNetworkUsage(networks, containers) {
  return networks.map((n) => {
    const users = containers ? containers.filter((c) => (c.networks || []).includes(n.name)).map((c) => c.name) : null;
    return { ...n, containers: users, unused: n.builtin ? false : users ? users.length === 0 : null };
  });
}

// Starts a refresh when there is nothing yet, the view is stale, or `force` and the last one is
// old enough - never awaited, so this answers at once and the client polls while `refreshing`.
function getInventory(host, { force = false, containers = null, now = Date.now() } = {}) {
  const state = states.get(host.id);
  const stale = !state || !state.startedAt || now - state.startedAt > INVENTORY_TTL_MS;
  const forced = force && state && now - state.startedAt >= MIN_FORCED_REFRESH_MS;
  if (stale || forced) refresh(host);
  const s = states.get(host.id);
  return {
    refreshing: !!s.inFlight,
    images: s.df ? s.df.images : null,
    volumes: s.df ? s.df.volumes : null,
    buildCache: s.df ? s.df.buildCache : null,
    networks: s.networks ? withNetworkUsage(s.networks, containers) : null,
    dfTs: s.dfTs,
    networksTs: s.networksTs,
    errors: { df: s.dfError, networks: s.networksError },
  };
}

function forgetHost(hostId) {
  states.delete(hostId);
}

module.exports = { getInventory, refresh, forgetHost, withNetworkUsage, INVENTORY_TTL_MS, MIN_FORCED_REFRESH_MS };
