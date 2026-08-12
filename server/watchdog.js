const logger = require('./logger');

// Recovery, not detection: the process/port/sqlite are alive but the poll loop stopped turning,
// so views serve frozen data - Docker's restart policy only reacts to the process exiting, not
// to this, so self-exit below is the only path back. See CLAUDE.md for the two signals used.
const LAG_SAMPLE_MS = 1000;
const LAG_WARN_MS = 5000;

// Generous on purpose - a normal cycle is POLL_MS plus however long docker calls take (up to
// ~30s for a timing-out SSH host), so anything under a minute or two would measure slowness, not
// deadlock. Unhealthy is reported well before the exit, leaving a window to see it first.
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
      // No graceful shutdown, deliberately: whatever is wedged is likely what a graceful path
      // would also have to await, and hanging inside recovery is worse than doing nothing.
      // sqlite is in WAL mode and recovers from an abrupt exit on its own.
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
