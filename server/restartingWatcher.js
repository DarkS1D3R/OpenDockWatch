const logger = require('./logger');

const RESTART_BASE_DELAY_MS = 2000;
const RESTART_MAX_DELAY_MS = 30000;
// How long a stream has to stay up before we consider it "healthy" and reset the backoff -
// spawning succeeds even for a doomed connection (e.g. SSH auth failure kills it right after),
// so resetting on 'spawn' never actually backs off for a permanently unreachable host.
const HEALTHY_AFTER_MS = 30000;

// The restart/backoff/teardown lifecycle eventWatcher.js and statsWatcher.js each ran a verbatim
// copy of, taking what differs between them (spawning, stdout parsing, a pre-restart hook) as
// options. Restart hangs off 'close' not 'exit', and re-checks watcher identity - see server/CLAUDE.md.
function createRestartingWatcher({ logPrefix, spawnChild, wireChild, beforeRestart, initState = () => ({}) }) {
  const watchers = new Map(); // hostId -> { child, stopped, restartDelay, ...initState() }

  function startWatcher(host) {
    const child = spawnChild(host);
    const state = watchers.get(host.id) || { restartDelay: RESTART_BASE_DELAY_MS, ...initState(host) };
    state.child = child;
    watchers.set(host.id, state);

    wireChild(state, child, host);

    // Without this handler, a spawn failure (docker not on PATH, bad SSH host, etc.) emits an
    // unhandled 'error' that crashes the whole process - taking down monitoring for every host.
    child.on('error', (err) => {
      logger.error(`${logPrefix}.stream.failed`, { host: host.id, error: err.message });
    });

    child.on('spawn', () => {
      if (watchers.get(host.id) !== state) return;
      logger.info(`${logPrefix}.stream.started`, { host: host.id, dockerHost: host.dockerHost || 'local' });
      state.healthyTimer = setTimeout(() => {
        state.restartDelay = RESTART_BASE_DELAY_MS;
      }, HEALTHY_AFTER_MS);
    });

    child.on('close', () => {
      if (watchers.get(host.id) !== state || state.stopped) return;
      if (state.healthyTimer) clearTimeout(state.healthyTimer);
      if (beforeRestart) beforeRestart(state, host);
      const delay = Math.min(state.restartDelay, RESTART_MAX_DELAY_MS);
      // A host whose stream keeps dying and backing off is otherwise entirely silent - the exit
      // isn't an error, so nothing logged it, and the growing delay was invisible.
      logger.warn(`${logPrefix}.stream.restarting`, { host: host.id, delayMs: delay });
      state.restartTimer = setTimeout(() => {
        if (watchers.get(host.id) !== state || state.stopped) return;
        startWatcher(host);
      }, delay);
      state.restartDelay = Math.min(delay * 2, RESTART_MAX_DELAY_MS);
    });
  }

  function addHost(host) {
    if (watchers.has(host.id)) return;
    startWatcher(host);
  }

  function teardown(state) {
    state.stopped = true;
    if (state.healthyTimer) clearTimeout(state.healthyTimer);
    if (state.restartTimer) clearTimeout(state.restartTimer);
    if (state.child) state.child.kill();
  }

  function removeHost(hostId) {
    const state = watchers.get(hostId);
    if (!state) return;
    teardown(state);
    watchers.delete(hostId);
    logger.info(`${logPrefix}.stream.stopped`, { host: hostId });
  }

  function stop() {
    for (const state of watchers.values()) teardown(state);
    watchers.clear();
  }

  return { watchers, startWatcher, addHost, removeHost, stop };
}

module.exports = { createRestartingWatcher };
