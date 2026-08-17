const logger = require('./logger');

// Recovery, not detection: the process/port/sqlite are alive but the poll loop stopped turning,
// so views serve frozen data - Docker's restart policy only reacts to the process exiting, not
// to this, so self-exit below is the only path back. See CLAUDE.md for the two signals used.
const LAG_SAMPLE_MS = 1000;

// Two thresholds, because one number can't do both jobs. A single stall this big is worth a line
// of its own; anything smaller only means something as a pattern, so it goes into the rolling
// summary instead. The old single 5s threshold logged neither: a host losing 90-220s per hour in
// stalls that were each under 5s produced no record at all, and the only way to see it was to
// notice that an hourly setInterval was firing 3 minutes late.
const LAG_WARN_MS = Number(process.env.WATCHDOG_LAG_WARN_MS) || 2000;
const LAG_NOTICE_MS = 250;
const LAG_SUMMARY_MS = 60_000;

// Detection stays conservative: 24 missed polls. The worst *legitimate* cycle is a timing-out SSH
// host (SSH_CHECK_TIMEOUT_MS 20s) plus the SIGKILL grace (5s) plus a full semaphore queue wait
// (MAX_QUEUE_WAIT_MS 15s) - call it 45s, so this is still ~3x anything the collector does on
// purpose. The grace after that is what changed: it was 600s, making total recovery 13 minutes for
// a process that is by then definitively wedged. A restart costs ~10s (the Dockerfile's
// start-period) and loses nothing - the db is WAL and the history is already written - so once
// staleness is confirmed there is nothing left to wait for. Unhealthy is still reported at
// STALE_MS, well before the exit, so the state is visible before it's acted on.
const STALE_MS = Number(process.env.WATCHDOG_STALE_MS) || 120_000;
const EXIT_AFTER_MS = Number(process.env.WATCHDOG_EXIT_AFTER_MS) || 120_000;

// A suspended host (laptop sleep, a paused VM - this app's usual home is a WSL2/Docker Desktop
// box) stops the poll loop for hours with nothing wrong with it. CLOCK_MONOTONIC, which
// process.hrtime reads, does not advance across a suspend while Date.now() does, so a wall-clock
// jump this much bigger than the monotonic one is a resume rather than a stall. Told apart because
// they need opposite responses, and because the wrong answer is expensive in both directions: a
// starved VM advances both clocks together and must still be caught, while counting a resume as
// staleness would restart a healthy process every time the machine wakes - now much more likely,
// with the exit grace cut to two minutes.
const SUSPEND_JUMP_MS = 5000;
// After a resume, the collector's own timer needs a poll interval or so to turn again before
// lastPollCompletedTs means anything. Six of them, so waking up never flaps the healthcheck.
const RESUME_GRACE_MS = 30_000;

function createWatchdog({
  getLastPollCompletedTs,
  getHostCount,
  now = () => Date.now(),
  // Monotonic milliseconds. Separate from `now` on purpose - see SUSPEND_JUMP_MS. Lag has to be
  // measured on this one: on the wall clock every host suspend reads as a multi-hour freeze.
  monotonic = () => Number(process.hrtime.bigint() / 1_000_000n),
  exit = (code) => process.exit(code),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let lastTick = null; // { wall, mono }
  let lastLagMs = 0;
  let staleSince = null;
  let resumeGraceUntil = null; // monotonic
  let lagWindow = null;
  let exiting = false;

  function resuming(mono) {
    if (resumeGraceUntil === null) return false;
    if (mono < resumeGraceUntil) return true;
    resumeGraceUntil = null;
    return false;
  }

  function status() {
    // No hosts configured means nothing is expected to poll - "stale" would be permanently true
    // and the process would restart itself in a loop over an empty config.
    if (getHostCount() === 0) return { ok: true, staleMs: 0, lagMs: lastLagMs };
    // Reported healthy while the collector catches up after a resume, so waking the machine
    // doesn't briefly flap the container unhealthy off a staleness that only the wall clock saw.
    if (resuming(monotonic())) return { ok: true, staleMs: 0, lagMs: lastLagMs, resuming: true };
    const staleMs = now() - getLastPollCompletedTs();
    return {
      ok: staleMs < STALE_MS,
      staleMs,
      lagMs: lastLagMs,
      ...(staleMs < STALE_MS ? {} : { reason: `no metrics poll completed in ${Math.round(staleMs / 1000)}s` }),
    };
  }

  // Individually unremarkable stalls, accumulated over a window and reported as one line - the
  // shape that actually identifies a sick host ("blocked 14 times, 4.2s in total, worst 1.8s").
  // The window opens on the first stall worth noticing, so a healthy host logs nothing at all.
  function recordLag(mono, lagMs) {
    if (!lagWindow) lagWindow = { startedMono: mono, stalls: 0, maxMs: 0, totalMs: 0 };
    lagWindow.stalls++;
    lagWindow.maxMs = Math.max(lagWindow.maxMs, lagMs);
    lagWindow.totalMs += lagMs;
  }

  function flushLagSummary(mono) {
    if (!lagWindow) return;
    const elapsed = mono - lagWindow.startedMono;
    if (elapsed < LAG_SUMMARY_MS) return;
    const { stalls, maxMs, totalMs } = lagWindow;
    lagWindow = null;
    logger.warn('watchdog.lag_summary', {
      windowSec: Math.round(elapsed / 1000),
      stalls,
      maxMs: Math.round(maxMs),
      totalMs: Math.round(totalMs),
      blockedPct: Math.round((totalMs / elapsed) * 1000) / 10,
    });
  }

  function check() {
    const t = now();
    const mono = monotonic();

    let awayMs = 0;
    if (lastTick !== null) {
      const monoDelta = mono - lastTick.mono;
      // Wall time this tick took that the monotonic clock never saw pass - the suspend itself.
      awayMs = t - lastTick.wall - monoDelta;
      // No special case for a suspend here, deliberately: this reads the monotonic delta, which by
      // definition does not advance while the host is away, so a resume already measures as ~zero
      // lag. An earlier version zeroed it explicitly and a mutation proved the branch could never
      // change the result. The suspend handling that *does* matter is the awayMs check below.
      lastLagMs = Math.max(0, monoDelta - LAG_SAMPLE_MS);
      if (lastLagMs >= LAG_NOTICE_MS) recordLag(mono, lastLagMs);
      if (lastLagMs >= LAG_WARN_MS) {
        logger.warn('watchdog.event_loop_lag', { lagMs: Math.round(lastLagMs) });
      }
    }
    lastTick = { wall: t, mono };
    flushLagSummary(mono);

    if (awayMs >= SUSPEND_JUMP_MS) {
      // Not a stall: the host was away, and lastPollCompletedTs is wall-clock-old purely because
      // of it. Clearing staleSince matters as much as the grace - a countdown started before the
      // suspend would otherwise resume against a clock that jumped past the end of it.
      logger.info('watchdog.resumed', { awaySec: Math.round(awayMs / 1000) });
      staleSince = null;
      resumeGraceUntil = mono + RESUME_GRACE_MS;
      return;
    }
    if (resuming(mono)) return;

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

    if (t - staleSince >= EXIT_AFTER_MS && !exiting) {
      // No graceful shutdown, deliberately: whatever is wedged is likely what a graceful path
      // would also have to await, and hanging inside recovery is worse than doing nothing.
      // sqlite is in WAL mode and recovers from an abrupt exit on its own. `exiting` latches
      // because process.exit doesn't return but an injected one does, and the checks keep coming
      // at 1Hz until the process is actually gone.
      exiting = true;
      logger.error('watchdog.restarting', { reason: state.reason, stalledForMs: Math.round(t - staleSince) });
      exit(1);
    }
  }

  return {
    start() {
      if (timer) return;
      lastTick = { wall: now(), mono: monotonic() };
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
      resumeGraceUntil = null;
      lagWindow = null;
      exiting = false;
    },
    status,
    check,
  };
}

module.exports = {
  createWatchdog,
  STALE_MS,
  EXIT_AFTER_MS,
  LAG_WARN_MS,
  LAG_NOTICE_MS,
  LAG_SUMMARY_MS,
  SUSPEND_JUMP_MS,
  RESUME_GRACE_MS,
};
