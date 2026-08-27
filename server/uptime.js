// Reconstructs "how much of this window was the container up/healthy" and "how much was the host
// reachable" purely from the durable event/transition history already retained for other reasons
// (server/CLAUDE.md's events table, and host_reachability below it) - no new sampling, no new
// retention window. Pure and exported so it's unit-tested without a database; server/index.js's
// uptime route is the only caller and supplies the db reads and the live-state anchor.

// A container's running state only ever changes on these actions - 'create' is deliberately absent
// (falls through to the down default in classifyContainerAction) since a created-but-never-started
// container has never been running. db.js's getContainerLifecycleEvents/-Seed filter to exactly
// this set (plus health_status:*) so every row this module sees is classifiable on its own, with
// no "ignore this one, it doesn't change state" case to carry through the walk (oom, exec_create,
// rename, resize, top, attach, ... all fire but say nothing about running/health).
const RUNNING_START = new Set(['start', 'restart', 'unpause']);
const RUNNING_STOP = new Set(['die', 'stop', 'kill', 'pause', 'destroy']);

function classifyContainerAction(action) {
  if (RUNNING_START.has(action)) return { running: true, health: null };
  if (RUNNING_STOP.has(action)) return { running: false, health: null };
  if (action === 'health_status: healthy') return { running: true, health: 'healthy' };
  if (action === 'health_status: unhealthy') return { running: true, health: 'unhealthy' };
  return { running: false, health: null }; // 'create'
}

// events: [{ts, action}] ascending, since <= ts <= until (caller's query already bounds this).
// seedAction: the action of the most recent qualifying event strictly before `since`, or null if
// none was found - which also covers "container has no history at all", the case a live anchor at
// the tail exists specifically to resolve (see below).
// liveState: {running, health} as of right now (until), or null if the container no longer exists.
//
// The only genuinely unknown span is the lead-in before the first fact this call has to go on: no
// seed, and (if there are no in-window events either) no live state. Everything else - including a
// container with zero events in the entire retention window - is resolved, because a completely
// silent history plus a live anchor means the state never changed for the whole window.
function computeContainerUptime({ events, since, until, seedAction = null, liveState = null }) {
  const windowMs = until - since;
  let upHealthyMs = 0;
  let unhealthyMs = 0;
  let downMs = 0;
  let unknownMs = 0;
  let hasHealthcheck = liveState ? liveState.health != null : false;

  const accumulate = (duration, state) => {
    if (duration <= 0) return;
    if (!state) {
      unknownMs += duration;
    } else if (!state.running) {
      downMs += duration;
    } else if (state.health === 'unhealthy') {
      unhealthyMs += duration;
    } else {
      upHealthyMs += duration;
    }
  };

  let cursor = since;
  let state = seedAction ? classifyContainerAction(seedAction) : null;
  for (const ev of events) {
    accumulate(ev.ts - cursor, state);
    if (ev.action.startsWith('health_status:')) hasHealthcheck = true;
    state = classifyContainerAction(ev.action);
    cursor = ev.ts;
  }
  // The trailing segment trusts the live anchor over the last event's own classification when both
  // are available - it is a direct read of "is it running right now", where the last event is only
  // as current as the last thing docker happened to report before this call.
  accumulate(until - cursor, liveState || state);

  const accountedMs = windowMs - unknownMs;
  return {
    windowMs,
    upHealthyMs,
    unhealthyMs,
    downMs,
    unknownMs,
    hasHealthcheck,
    upPercent: accountedMs > 0 ? ((upHealthyMs + unhealthyMs) / accountedMs) * 100 : null,
    healthyPercent: accountedMs > 0 ? (upHealthyMs / accountedMs) * 100 : null,
  };
}

// Same shape as computeContainerUptime, minus the health axis - a host is only ever reachable or
// not. transitions: [{ts, reachable}] ascending; seedReachable/liveReachable are booleans or null.
function computeHostUptime({ transitions, since, until, seedReachable = null, liveReachable = null }) {
  const windowMs = until - since;
  let upMs = 0;
  let downMs = 0;
  let unknownMs = 0;

  const accumulate = (duration, reachable) => {
    if (duration <= 0) return;
    if (reachable === null || reachable === undefined) unknownMs += duration;
    else if (reachable) upMs += duration;
    else downMs += duration;
  };

  let cursor = since;
  let state = seedReachable;
  for (const t of transitions) {
    accumulate(t.ts - cursor, state);
    state = t.reachable;
    cursor = t.ts;
  }
  accumulate(until - cursor, liveReachable === null || liveReachable === undefined ? state : liveReachable);

  const accountedMs = windowMs - unknownMs;
  return {
    windowMs,
    upMs,
    downMs,
    unknownMs,
    upPercent: accountedMs > 0 ? (upMs / accountedMs) * 100 : null,
  };
}

module.exports = { classifyContainerAction, computeContainerUptime, computeHostUptime };
