const logger = require('./logger');

// Recovery, not detection. The failure this exists for is the one a restart fixes and nothing
// else does: the process is still alive, the port still accepts connections, sqlite still
// answers - but the poll loop has stopped turning, so every view serves data frozen at whatever
// moment it wedged. Nothing in Docker notices that on its own. Worth being explicit about why:
// `restart: unless-stopped` reacts to the process *exiting*, and a failing HEALTHCHECK marks a
// container unhealthy but never restarts it - Docker has no such behavior. So the only way a
// wedged instance recovers without a human is to notice and exit on its own, which is what the
// self-exit below does; the restart policy then does the actual restarting.
//
// Two independent signals:
//
//   staleness - how long since metricsCollector last completed a poll of any host. See the
//     comment on lastPollCompletedTs for why this tracks the loop rather than Docker: an
//     unreachable daemon still completes its poll, so this cannot be tripped by a monitored host
//     being down, only by the loop genuinely having stopped.
//
//   event-loop lag - how far a fixed-interval timer drifts. better-sqlite3 is synchronous, so
//     every metric write happens on the event loop; against a slow bind-mounted volume a poll
//     cycle's writes can block it long enough to stall the HTTP server. This is diagnostic only
//     and never triggers the exit - a one-off spike during the hourly prune is normal, and
//     killing the process over it would be a self-inflicted outage.
const LAG_SAMPLE_MS = 1000;
const LAG_WARN_MS = 5000;

// Generous on purpose. A normal cycle is POLL_MS plus however long the docker calls take (up to
// ~30s for an SSH host that is timing out), so anything under a minute or two would be measuring
// slowness rather than deadlock. Unhealthy is reported well before the process acts on it, so
// there's a window to see it in /healthz and the logs before a restart happens.
const STALE_MS = Number(process.env.WATCHDOG_STALE_MS) || 180_000;
const EXIT_AFTER_MS = Number(process.env.WATCHDOG_EXIT_AFTER_MS) || 600_000;

function createWatchdog({
  getLastPollCompletedTs,
  getHostCount,
  now = () => Date.now(),
  exit = (code) => process.exit(code),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let lastTick = null;
  let lastLagMs = 0;
  let staleSince = null;

  function status() {
    // No hosts configured means nothing is expected to poll - "stale" would be permanently true
    // and the process would restart itself in a loop over an empty config.
    if (getHostCount() === 0) return { ok: true, staleMs: 0, lagMs: lastLagMs };
    const staleMs = now() - getLastPollCompletedTs();
    return {
      ok: staleMs < STALE_MS,
      staleMs,
      lagMs: lastLagMs,
      ...(staleMs < STALE_MS ? {} : { reason: `no metrics poll completed in ${Math.round(staleMs / 1000)}s` }),
    };
  }

  function check() {
    const t = now();

    if (lastTick !== null) {
      lastLagMs = Math.max(0, t - lastTick - LAG_SAMPLE_MS);
      if (lastLagMs > LAG_WARN_MS) {
        logger.warn('watchdog.event_loop_lag', { lagMs: Math.round(lastLagMs) });
      }
    }
    lastTick = t;

    const state = status();
    if (state.ok) {
      if (staleSince !== null) {
        logger.info('watchdog.recovered', { staleForMs: Math.round(t - staleSince) });
        staleSince = null;
      }
      return;
    }

    if (staleSince === null) {
      staleSince = t;
      logger.error('watchdog.stalled', { reason: state.reason, exitAfterMs: EXIT_AFTER_MS });
      return;
    }

    if (t - staleSince >= EXIT_AFTER_MS) {
      // No graceful shutdown here, deliberately: whatever is wedged is very likely the same
      // thing a graceful path would have to await, and hanging inside the recovery is the one
      // outcome that leaves this no better than doing nothing. sqlite is in WAL mode and
      // recovers from an abrupt exit on its own.
      logger.error('watchdog.restarting', { reason: state.reason, stalledForMs: Math.round(t - staleSince) });
      exit(1);
    }
  }

  return {
    start() {
      if (timer) return;
      lastTick = now();
      timer = setIntervalImpl(check, LAG_SAMPLE_MS);
      // Never the reason the process stays alive - the HTTP server is.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = null;
      lastTick = null;
      staleSince = null;
    },
    status,
    check,
  };
}

module.exports = { createWatchdog, STALE_MS, EXIT_AFTER_MS, LAG_WARN_MS };
