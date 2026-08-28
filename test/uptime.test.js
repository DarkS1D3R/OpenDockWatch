const test = require('node:test');
const assert = require('node:assert/strict');
const { computeContainerUptime, computeHostUptime } = require('../server/uptime');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('computeContainerUptime', async (t) => {
  await t.test('a container running the whole window with no events reports 100% from the live anchor alone', () => {
    const r = computeContainerUptime({ events: [], since: 0, until: DAY, liveState: { running: true, health: null } });
    assert.equal(r.unknownMs, 0);
    assert.equal(r.downMs, 0);
    assert.equal(r.upHealthyMs, DAY);
    assert.equal(r.upPercent, 100);
    assert.equal(r.healthyPercent, 100);
    assert.equal(r.hasHealthcheck, false);
  });

  await t.test('a container with no events and no live anchor is entirely unknown, not silently up or down', () => {
    const r = computeContainerUptime({ events: [], since: 0, until: DAY, liveState: null });
    assert.equal(r.unknownMs, DAY);
    assert.equal(r.upPercent, null);
    assert.equal(r.healthyPercent, null);
  });

  await t.test('a seed before the window resolves the leading gap instead of marking it unknown', () => {
    const r = computeContainerUptime({
      events: [{ ts: 10 * HOUR, action: 'die' }],
      since: 0,
      until: DAY,
      seedAction: 'start',
      liveState: { running: false, health: null },
    });
    assert.equal(r.unknownMs, 0);
    assert.equal(r.upHealthyMs, 10 * HOUR);
    assert.equal(r.downMs, DAY - 10 * HOUR);
  });

  await t.test('no seed and an in-window event marks the leading gap unknown, not up or down', () => {
    const r = computeContainerUptime({
      events: [{ ts: 10 * HOUR, action: 'die' }],
      since: 0,
      until: DAY,
      seedAction: null,
      liveState: { running: false, health: null },
    });
    assert.equal(r.unknownMs, 10 * HOUR);
    assert.equal(r.downMs, DAY - 10 * HOUR);
  });

  await t.test('an unhealthy stretch counts as up but not healthy', () => {
    const r = computeContainerUptime({
      events: [
        { ts: 0, action: 'start' },
        { ts: 5 * HOUR, action: 'health_status: unhealthy' },
        { ts: 8 * HOUR, action: 'health_status: healthy' },
      ],
      since: 0,
      until: 10 * HOUR,
      seedAction: null,
      liveState: { running: true, health: 'healthy' },
    });
    assert.equal(r.upHealthyMs, 5 * HOUR + 2 * HOUR);
    assert.equal(r.unhealthyMs, 3 * HOUR);
    assert.equal(r.downMs, 0);
    assert.equal(r.hasHealthcheck, true);
    assert.equal(r.upPercent, 100);
    assert.equal(Math.round(r.healthyPercent), 70);
  });

  await t.test('a restart resets health to unknown-but-up rather than carrying the old health forward', () => {
    const r = computeContainerUptime({
      events: [
        { ts: 0, action: 'start' },
        { ts: 1 * HOUR, action: 'health_status: unhealthy' },
        { ts: 2 * HOUR, action: 'restart' },
      ],
      since: 0,
      until: 4 * HOUR,
      liveState: { running: true, health: null },
    });
    // [0,1h) unknown-health-but-up, [1h,2h) unhealthy, [2h,4h) up via live anchor (health null)
    assert.equal(r.unhealthyMs, 1 * HOUR);
    assert.equal(r.upHealthyMs, 3 * HOUR);
    assert.equal(r.downMs, 0);
  });

  await t.test('create without a following start never counts as up', () => {
    const r = computeContainerUptime({
      events: [{ ts: 0, action: 'create' }],
      since: 0,
      until: DAY,
      liveState: { running: false, health: null },
    });
    assert.equal(r.downMs, DAY);
    assert.equal(r.upHealthyMs, 0);
  });

  await t.test('the live anchor overrides the last event classification for the trailing segment', () => {
    // A die event landed in history, but the container is running again right now (e.g. the seed
    // query missed a subsequent start that fell outside the fetched action set for some reason) -
    // the live read of "is it up right now" should win for the segment closest to now.
    const r = computeContainerUptime({
      events: [{ ts: 1 * HOUR, action: 'die' }],
      since: 0,
      until: 2 * HOUR,
      seedAction: 'start',
      liveState: { running: true, health: null },
    });
    assert.equal(r.upHealthyMs, 1 * HOUR + 1 * HOUR);
    assert.equal(r.downMs, 0);
  });
});

test('computeHostUptime', async (t) => {
  await t.test('no transitions and a reachable live anchor reports 100% up', () => {
    const r = computeHostUptime({ transitions: [], since: 0, until: DAY, liveReachable: true });
    assert.equal(r.unknownMs, 0);
    assert.equal(r.upMs, DAY);
    assert.equal(r.upPercent, 100);
  });

  await t.test('no transitions and no live anchor is unknown', () => {
    const r = computeHostUptime({ transitions: [], since: 0, until: DAY, liveReachable: null });
    assert.equal(r.unknownMs, DAY);
    assert.equal(r.upPercent, null);
  });

  await t.test('a down window bounded by two transitions is subtracted from up time', () => {
    const r = computeHostUptime({
      transitions: [
        { ts: 5 * HOUR, reachable: false },
        { ts: 6 * HOUR, reachable: true },
      ],
      since: 0,
      until: 10 * HOUR,
      seedReachable: true,
      liveReachable: true,
    });
    assert.equal(r.downMs, 1 * HOUR);
    assert.equal(r.upMs, 9 * HOUR);
    assert.equal(r.upPercent, 90);
  });

  await t.test('a seed of false correctly starts the window down', () => {
    const r = computeHostUptime({
      transitions: [{ ts: 2 * HOUR, reachable: true }],
      since: 0,
      until: 4 * HOUR,
      seedReachable: false,
      liveReachable: true,
    });
    assert.equal(r.downMs, 2 * HOUR);
    assert.equal(r.upMs, 2 * HOUR);
  });
});
