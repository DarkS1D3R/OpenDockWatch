const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same isolation reasoning as test/index.test.js: never open the real data/opendockwatch.db, which
// a running container may hold in WAL mode. node --test runs each file in its own process, so
// setting this before the require below is enough.
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-db-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const db = require('../server/db');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  }
});

const HOST = 'db-test-host';
let nextTs = 1_700_000_000_000;

function sample(containerId, overrides = {}) {
  return {
    hostId: HOST,
    containerId,
    ts: (nextTs += 1000),
    cpuPerc: 1.5,
    memUsedBytes: 1024,
    memPerc: 2.5,
    netRxBytes: 10,
    netTxBytes: 20,
    blockReadBytes: 30,
    blockWriteBytes: 40,
    ...overrides,
  };
}

function rowCountFor(containerId) {
  return db.client.prepare('SELECT COUNT(*) AS n FROM container_metrics WHERE container_id = ?').get(containerId).n;
}

test('insertMetrics', async (t) => {
  await t.test('writes every sample in the batch', () => {
    db.insertMetrics([sample('c-all-1'), sample('c-all-1'), sample('c-all-2')]);
    assert.equal(rowCountFor('c-all-1'), 2);
    assert.equal(rowCountFor('c-all-2'), 1);
  });

  await t.test('round-trips the column values, not just the row count', () => {
    const one = sample('c-values', { cpuPerc: 42.5, memUsedBytes: 999, netRxBytes: 7 });
    db.insertMetrics([one]);
    const row = db.client.prepare('SELECT * FROM container_metrics WHERE container_id = ?').get('c-values');
    assert.equal(row.cpu_perc, 42.5);
    assert.equal(row.mem_used_bytes, 999);
    assert.equal(row.net_rx_bytes, 7);
    assert.equal(row.host_id, HOST);
  });

  // An idle host has no running containers, so this is the every-poll case - it must not open a
  // transaction (or throw) just to write nothing.
  await t.test('an empty batch is a no-op', () => {
    const before = db.client.prepare('SELECT COUNT(*) AS n FROM container_metrics').get().n;
    assert.doesNotThrow(() => db.insertMetrics([]));
    assert.equal(db.client.prepare('SELECT COUNT(*) AS n FROM container_metrics').get().n, before);
  });

  // The point of the transaction is throughput, but atomicity comes with it and is worth pinning:
  // a malformed sample rolls the whole poll back rather than leaving the batch half-written, which
  // would put a partial instant into the history charts.
  await t.test('a bad sample rolls the whole batch back', () => {
    const bad = sample('c-atomic');
    delete bad.memPerc;
    assert.throws(() => db.insertMetrics([sample('c-atomic'), bad, sample('c-atomic')]));
    assert.equal(rowCountFor('c-atomic'), 0, 'partial batch survived a failed insert');
  });

  // Downsampling reads these rows back through BUCKET_EXPR and withIoRates; batching must not have
  // changed what lands in the table from the history queries' point of view.
  await t.test('batched rows are readable through the history query', () => {
    const base = nextTs + 1000;
    db.insertMetrics([
      sample('c-history', { ts: base, cpuPerc: 10, netRxBytes: 1000 }),
      sample('c-history', { ts: base + 1000, cpuPerc: 20, netRxBytes: 3000 }),
    ]);
    const rows = db.getContainerMetricsHistory(HOST, 'c-history', base - 1000, 15_000);
    assert.equal(rows.length, 1, 'both samples should fall in one 15s bucket');
    assert.equal(rows[0].cpuPerc, 15, 'bucket should average the two cpu samples');
  });

  // untilTs is what the panned charts page with: exclusive, so consecutive windows never share a row.
  await t.test('the history query stops before untilTs', () => {
    const base = nextTs + 60_000;
    db.insertMetrics([sample('c-until', { ts: base, cpuPerc: 10 }), sample('c-until', { ts: base + 30_000, cpuPerc: 50 })]);
    const before = db.getContainerMetricsHistory(HOST, 'c-until', base - 1000, 15_000, base + 30_000);
    assert.deepEqual(
      before.map((r) => r.cpuPerc),
      [10],
      'the sample at exactly untilTs belongs to the next window'
    );
    const all = db.getContainerMetricsHistory(HOST, 'c-until', base - 1000, 15_000);
    assert.equal(all.length, 2, 'omitting untilTs should read up to now');
  });
});

// clearEvents is a soft delete for the same reason clearAlerts below is: the events table is the
// source for the crash_loop rule and the List view's restartCount1h, so a hard delete empties a
// list *and* silently resets both - a container mid-crash-loop stops being detected as one.
test('clearEvents hides events without losing the restart history', async (t) => {
  const CLEAR_HOST = 'db-test-clear-events-host';
  const OTHER_HOST = 'db-test-clear-events-other';
  const CONTAINER = 'dddddddddddd';
  const event = (hostId, overrides = {}) => ({
    hostId,
    containerId: CONTAINER,
    containerName: 'web',
    action: 'start',
    ts: (nextTs += 1000),
    rawJson: '{}',
    ...overrides,
  });

  await t.test('cleared events leave the feed, scoped to one host', () => {
    db.insertEvent(event(CLEAR_HOST));
    db.insertEvent(event(CLEAR_HOST));
    db.insertEvent(event(OTHER_HOST));

    assert.equal(db.getEvents(CLEAR_HOST).length, 2);
    assert.equal(db.clearEvents(CLEAR_HOST), 2, 'changes should count the rows actually cleared');
    assert.equal(db.getEvents(CLEAR_HOST).length, 0);
    assert.equal(db.getEvents(OTHER_HOST).length, 1, "clearing one host cleared another host's events");
    assert.equal(db.clearEvents(CLEAR_HOST), 0, 'an already-cleared row must not be counted again');
  });

  // The whole point of the soft delete: both restart counters are what the container did, not what
  // the Activity tab is showing.
  await t.test('the restart counters still see the cleared events', () => {
    assert.equal(db.countRestartsSince(CLEAR_HOST, CONTAINER, 0), 2, 'clearing reset crash-loop detection');
    assert.equal(db.getRestartCountsByContainer(CLEAR_HOST, 0).get(CONTAINER), 2, 'clearing walked restartCount1h back to zero');
  });

  await t.test('events arriving after a clear are visible again', () => {
    db.insertEvent(event(CLEAR_HOST, { action: 'die' }));
    assert.equal(db.getEvents(CLEAR_HOST).length, 1);
    assert.equal(db.countRestartsSince(CLEAR_HOST, CONTAINER, 0), 2, 'a die is not a restart');
  });

  // `docker restart` sends restart beside its start, and Podman does for every restart - counting
  // both is how one restart read as two (and a single Podman auto-restart neared the crash loop).
  await t.test('a restart event beside its start is not counted again', () => {
    db.insertEvent(event(CLEAR_HOST, { action: 'restart' }));
    assert.equal(db.countRestartsSince(CLEAR_HOST, CONTAINER, 0), 2);
    assert.equal(db.getRestartCountsByContainer(CLEAR_HOST, 0).get(CONTAINER), 2);
  });

  // The plain (host_id, ts) index would walk every cleared row to answer this, which right after a
  // Clear is the host's whole retained history for an empty page. See the partial index in db.js.
  await t.test('getEvents plans against the partial index', () => {
    const plan = db.client
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE host_id = ? AND ts >= ? AND cleared_at IS NULL ORDER BY ts DESC LIMIT ?')
      .all(CLEAR_HOST, 0, 200);
    const detail = plan.map((r) => r.detail).join(' | ');
    assert.match(detail, /idx_events_host_ts_active/, `getEvents no longer uses the partial index: ${detail}`);
    assert.doesNotMatch(detail, /TEMP B-TREE/, `getEvents is sorting rather than walking the index: ${detail}`);
  });
});

test('getContainerLifecycleEvents / getContainerLifecycleSeed', async (t) => {
  const HOST2 = 'db-test-lifecycle-host';
  const CONTAINER = 'ccccccccffff';
  const event = (action, ts, overrides = {}) => ({
    hostId: HOST2,
    containerId: CONTAINER,
    containerName: 'web',
    action,
    ts,
    rawJson: '{}',
    ...overrides,
  });

  await t.test('the seed is the most recent qualifying event strictly before the window', () => {
    db.insertEvent(event('create', 1000));
    db.insertEvent(event('start', 2000));
    assert.equal(db.getContainerLifecycleSeed(HOST2, CONTAINER, 3000), 'start');
    assert.equal(db.getContainerLifecycleSeed(HOST2, CONTAINER, 1500), 'create');
    assert.equal(db.getContainerLifecycleSeed(HOST2, CONTAINER, 1000), null, 'strictly before, ts=1000 must not match itself');
  });

  await t.test('in-window events come back ascending and only the classifiable actions are included', () => {
    db.insertEvent(event('exec_create', 2500));
    db.insertEvent(event('health_status: healthy', 3000));
    db.insertEvent(event('die', 4000));
    const rows = db.getContainerLifecycleEvents(HOST2, CONTAINER, 2000);
    assert.deepEqual(
      rows.map((r) => r.action),
      ['start', 'health_status: healthy', 'die'],
      'exec_create is not a state-relevant action and must not appear'
    );
    assert.ok(
      rows.every((r, i) => i === 0 || r.ts >= rows[i - 1].ts),
      'rows must be ascending by ts'
    );
  });

  await t.test('a cleared event still counts - this is what the container did, not what the tab shows', () => {
    db.clearEvents(HOST2);
    const rows = db.getContainerLifecycleEvents(HOST2, CONTAINER, 0);
    assert.ok(rows.length > 0, 'clearing the Activity tab must not erase uptime history');
  });

  await t.test('getContainersWithLifecycleEvents lists each container once regardless of how many events it has', () => {
    db.insertEvent(event('start', 5000, { containerId: 'aaaaaaaaaaaa', containerName: 'db' }));
    db.insertEvent(event('die', 6000, { containerId: 'aaaaaaaaaaaa', containerName: 'db' }));
    const rows = db.getContainersWithLifecycleEvents(HOST2, 0);
    const ids = rows.map((r) => r.containerId).sort();
    assert.deepEqual(ids, [CONTAINER, 'aaaaaaaaaaaa'].sort());
  });

  await t.test('getContainersWithLifecycleEvents excludes a container whose only events are non-lifecycle', () => {
    db.insertEvent(event('exec_create', 7000, { containerId: 'bbbbbbbbbbbb', containerName: 'sidecar' }));
    db.insertEvent(event('oom', 7500, { containerId: 'bbbbbbbbbbbb', containerName: 'sidecar' }));
    const rows = db.getContainersWithLifecycleEvents(HOST2, 6500);
    assert.ok(!rows.some((r) => r.containerId === 'bbbbbbbbbbbb'), 'a container with no classifiable event in the window must not appear');
  });

  await t.test('getContainersWithLifecycleEvents resolves the name from the most recent event, not an arbitrary row', () => {
    db.insertEvent(event('start', 8000, { containerId: 'cccccccccccc', containerName: 'old-name' }));
    db.insertEvent(event('die', 9000, { containerId: 'cccccccccccc', containerName: 'new-name' }));
    const rows = db.getContainersWithLifecycleEvents(HOST2, 8000);
    const row = rows.find((r) => r.containerId === 'cccccccccccc');
    assert.equal(row.containerName, 'new-name');
  });
});

test('host_reachability transitions and seed', async (t) => {
  const HOST3 = 'db-test-reachability-host';

  await t.test('a fresh host has no seed and no transitions', () => {
    assert.equal(db.getHostReachabilitySeed(HOST3, 1000), null);
    assert.deepEqual(db.getHostReachabilityTransitions(HOST3, 0), []);
  });

  await t.test('insert round-trips as a boolean, and the seed resolves before the window', () => {
    db.insertHostReachability(HOST3, 1000, false);
    db.insertHostReachability(HOST3, 2000, true);
    assert.equal(db.getHostReachabilitySeed(HOST3, 1500), false);
    assert.equal(db.getHostReachabilitySeed(HOST3, 2500), true);
    const rows = db.getHostReachabilityTransitions(HOST3, 0);
    assert.deepEqual(
      rows.map((r) => r.reachable),
      [false, true]
    );
    assert.equal(typeof rows[0].reachable, 'boolean', 'reachable must come back as a real boolean, not 0/1');
  });
});

// clearAlerts is a soft delete, and the reason is the last subtest here: the alerts table is also
// alerts.js's cooldown store (getLastAlertFireTs), so a hard delete re-arms every rule on the host
// and a still-breaching one re-fires - webhook included - on the next 5s poll.
test('clearAlerts hides alerts without re-arming the cooldown', async (t) => {
  const CLEAR_HOST = 'db-test-clear-host';
  const OTHER_HOST = 'db-test-clear-other';
  const alert = (hostId, overrides = {}) => ({
    ts: (nextTs += 1000),
    hostId,
    containerId: 'cccccccccccc',
    containerName: 'web',
    rule: 'container_cpu',
    severity: 'warning',
    message: 'cpu high',
    ...overrides,
  });

  await t.test('cleared alerts leave the list, the open count and the per-container count', () => {
    db.insertAlert(alert(CLEAR_HOST));
    db.insertAlert(alert(CLEAR_HOST, { rule: 'container_mem' }));
    db.insertAlert(alert(OTHER_HOST));

    assert.equal(db.getAlerts(CLEAR_HOST).length, 2);
    assert.equal(db.clearAlerts(CLEAR_HOST), 2, 'changes should count the rows actually cleared');
    assert.equal(db.getAlerts(CLEAR_HOST).length, 0);
    assert.equal(db.countOpenAlerts(CLEAR_HOST), 0);
    assert.equal(db.getOpenAlertCountsByContainer(CLEAR_HOST).size, 0);
    assert.equal(db.getAlerts(null).filter((a) => a.host_id === CLEAR_HOST).length, 0, 'the all-hosts list still shows cleared rows');
  });

  await t.test('scoped to one host, and clearing twice is a no-op', () => {
    assert.equal(db.getAlerts(OTHER_HOST).length, 1, "clearing one host cleared another host's alerts");
    assert.equal(db.clearAlerts(CLEAR_HOST), 0, 'an already-cleared row must not be counted again');
  });

  await t.test('a cleared alert can no longer be acknowledged', () => {
    const id = db.insertAlert(alert(CLEAR_HOST, { rule: 'crash_loop' }));
    db.clearAlerts(CLEAR_HOST);
    db.ackAlert(id);
    assert.equal(db.client.prepare('SELECT acknowledged FROM alerts WHERE id = ?').get(id).acknowledged, 0);
    assert.equal(db.ackAllAlerts(CLEAR_HOST), 0);
  });

  await t.test('a resolved alert stops counting as open but stays in the list, unacknowledged', () => {
    const RESOLVE_HOST = 'db-test-resolve-host';
    const firing = db.insertAlert(alert(RESOLVE_HOST));
    const resolved = db.insertAlert(alert(RESOLVE_HOST, { containerId: 'dddddddddddd' }));
    const legacy = db.insertAlert(alert(RESOLVE_HOST, { containerId: 'eeeeeeeeeeee' }));
    db.markAlertResolved(resolved, (nextTs += 1000));
    db.client.prepare('UPDATE alerts SET resolved_at = 0 WHERE id = ?').run(legacy);

    assert.equal(db.countOpenAlerts(RESOLVE_HOST), 1, 'only the still-firing alert is open');
    assert.deepEqual([...db.getOpenAlertCountsByContainer(RESOLVE_HOST)], [['cccccccccccc', 1]]);
    const rows = db.getAlerts(RESOLVE_HOST);
    assert.equal(rows.length, 3, 'resolving must not hide an alert from the list');
    assert.ok(rows.every((r) => r.acknowledged === 0));
    assert.ok(rows.some((r) => r.id === firing));
  });

  // The whole point of the soft delete.
  await t.test('the cooldown still sees the cleared alert', () => {
    const ts = (nextTs += 1000);
    db.insertAlert(alert(CLEAR_HOST, { rule: 'host_cpu', containerId: null, ts }));
    db.clearAlerts(CLEAR_HOST);
    assert.equal(db.getAlerts(CLEAR_HOST).length, 0);
    assert.equal(
      db.getLastAlertFireTs(CLEAR_HOST, null, 'host_cpu'),
      ts,
      'clearing re-armed the cooldown - the alert will re-fire and re-notify'
    );
  });

  // A cleared alert is gone from the UI, so delivering it late would be a notification for
  // something nobody can see any more. A hard delete had the same effect, by losing the row.
  await t.test('a cleared alert drops out of the webhook retry queue', () => {
    const id = db.insertAlert(alert(CLEAR_HOST, { rule: 'unhealthy' }));
    const deliveryId = db.insertWebhookDelivery({ alertId: id, destination: 'main', kind: 'firing', ts: nextTs, payload: {} });
    db.markDeliveryFailed(deliveryId);
    const pending = () => db.getPendingDeliveries({ maxAttempts: 5, sinceTs: 0, limit: 10 }).some((d) => d.id === deliveryId);
    assert.equal(pending(), true);
    db.clearAlerts(CLEAR_HOST);
    assert.equal(pending(), false);
  });
});

test('alert resolution', async (t) => {
  const RHOST = 'db-test-resolve-host';
  const insert = (overrides = {}) =>
    db.insertAlert({
      ts: (nextTs += 1000),
      hostId: RHOST,
      containerId: null,
      containerName: null,
      rule: 'host_unreachable',
      severity: 'critical',
      message: 'down',
      ...overrides,
    });

  await t.test('a new alert is open, and getUnresolvedAlert finds the newest one for that host, container and rule', () => {
    insert();
    const newer = insert();
    insert({ rule: 'host_cpu' });
    insert({ containerId: 'cccccccccccc', containerName: 'web' });
    assert.equal(
      db.getUnresolvedAlert({ hostId: RHOST, rule: 'host_unreachable' }).id,
      newer,
      'a host-level rule must match NULL with IS, not ='
    );
  });

  await t.test('resolving marks it once - a second resolve reports nothing to do', () => {
    const open = db.getUnresolvedAlert({ hostId: RHOST, rule: 'host_unreachable' });
    assert.equal(db.markAlertResolved(open.id, nextTs), true);
    assert.equal(db.markAlertResolved(open.id, nextTs + 1), false, 'two racing recoveries would both announce it');
    assert.notEqual(db.getUnresolvedAlert({ hostId: RHOST, rule: 'host_unreachable' }).id, open.id);
  });

  await t.test('sinceTs keeps a recovery from closing an alert older than the breach that ended', () => {
    const old = insert({ rule: 'host_mem' });
    assert.equal(db.getUnresolvedAlert({ hostId: RHOST, rule: 'host_mem', sinceTs: nextTs + 1 }), null);
    assert.equal(db.getUnresolvedAlert({ hostId: RHOST, rule: 'host_mem', sinceTs: 0 }).id, old);
  });

  await t.test('a cleared alert can still be resolved - its webhook went out regardless', () => {
    const id = insert({ rule: 'docker_disk' });
    db.clearAlerts(RHOST);
    assert.equal(db.getUnresolvedAlert({ hostId: RHOST, rule: 'docker_disk' }).id, id);
  });
});

test('webhook delivery queue', async (t) => {
  const QHOST = 'db-test-queue-host';
  const alertId = db.insertAlert({
    ts: (nextTs += 1000),
    hostId: QHOST,
    containerId: null,
    containerName: null,
    rule: 'host_cpu',
    severity: 'warning',
    message: 'm',
  });
  const queue = (overrides = {}) =>
    db.insertWebhookDelivery({ alertId, destination: 'main', kind: 'firing', ts: nextTs, payload: { message: 'm' }, ...overrides });
  const pendingIds = () => db.getPendingDeliveries({ maxAttempts: 3, sinceTs: 0, limit: 50 }).map((d) => d.id);

  await t.test('only a tried-and-failed notice is pending, until it is delivered or out of attempts', () => {
    const id = queue();
    assert.ok(!pendingIds().includes(id), 'never-attempted rows are the first attempt still in flight');
    db.markDeliveryFailed(id);
    assert.ok(pendingIds().includes(id));
    db.markDeliveryFailed(id);
    db.markDeliveryFailed(id);
    assert.ok(!pendingIds().includes(id), 'past maxAttempts it must stop retrying');
    const ok = queue({ destination: 'route:1' });
    db.markDeliveryFailed(ok);
    db.markDeliveryDelivered(ok);
    assert.ok(!pendingIds().includes(ok));
  });

  await t.test('the payload round-trips, and the alert resolution rides along for the sweep', () => {
    const id = queue({ destination: 'route:2', payload: { message: 'exact text' } });
    db.markDeliveryFailed(id);
    const row = db.getPendingDeliveries({ maxAttempts: 5, sinceTs: 0, limit: 50 }).find((d) => d.id === id);
    assert.deepEqual(JSON.parse(row.payload), { message: 'exact text' });
    assert.equal(row.resolvedAt, null);
    db.markAlertResolved(alertId, nextTs);
    assert.ok(db.getPendingDeliveries({ maxAttempts: 5, sinceTs: 0, limit: 50 }).find((d) => d.id === id).resolvedAt > 0);
    db.deleteDelivery(id);
    assert.ok(!pendingIds().includes(id));
  });

  await t.test('getDeliveredDestinations lists where the firing notice arrived, and nothing else', () => {
    const other = db.insertAlert({
      ts: (nextTs += 1000),
      hostId: QHOST,
      containerId: null,
      containerName: null,
      rule: 'host_mem',
      severity: 'warning',
      message: 'm',
    });
    const add = (destination, kind, delivered) => {
      const id = db.insertWebhookDelivery({ alertId: other, destination, kind, ts: nextTs, payload: {} });
      if (delivered) db.markDeliveryDelivered(id);
    };
    add('main', 'firing', true);
    add('route:5', 'firing', false);
    add('route:6', 'resolved', true);
    add('main', 'firing', true);
    assert.deepEqual(db.getDeliveredDestinations(other), ['main']);
  });

  await t.test('pruned with the rest of the alert history', () => {
    const oldId = db.insertWebhookDelivery({ alertId, destination: 'main', kind: 'firing', ts: 1000, payload: {} });
    const res = db.pruneOld({ metricsRetentionMs: Date.now(), eventsRetentionMs: Date.now(), auditRetentionMs: Date.now() - 2000 });
    assert.ok(res.webhookDeliveries >= 1);
    assert.equal(db.client.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE id = ?').get(oldId).n, 0);
  });
});

test('reminder and escalation queries', async (t) => {
  const FHOST = 'db-test-follow-up-host';
  const insert = (overrides = {}) =>
    db.insertAlert({
      ts: (nextTs += 1000),
      hostId: FHOST,
      containerId: null,
      containerName: null,
      rule: 'host_unreachable',
      severity: 'critical',
      message: 'down',
      ...overrides,
    });
  const followUpIds = () =>
    db
      .getFollowUpAlerts({ limit: 500 })
      .filter((a) => a.hostId === FHOST)
      .map((a) => a.id);

  await t.test('a stateful rule is a candidate at any age, anything else only from incidentSince', () => {
    const outage = insert({ ts: 1000 });
    const oldCrash = insert({ ts: 2000, rule: 'container_crashed', containerId: 'dddddddddddd' });
    const recentCrash = insert({ ts: 9_000_000_000_000, rule: 'container_crashed', containerId: 'dddddddddddd' });
    const ids = (opts) =>
      db
        .getFollowUpAlerts({ limit: 500, ...opts })
        .filter((a) => a.hostId === FHOST)
        .map((a) => a.id);
    const remindable = ids({ statefulRules: ['host_unreachable'], incidentSince: 5_000_000_000_000 });
    assert.ok(remindable.includes(outage), 'an old outage still gets reminders');
    assert.ok(remindable.includes(recentCrash));
    assert.ok(!remindable.includes(oldCrash), 'an incident past every escalation window is left out');
    assert.deepEqual(ids({ statefulRules: [], incidentSince: 5_000_000_000_000 }), [recentCrash]);
    for (const id of [outage, oldCrash, recentCrash]) db.ackAlert(id);
  });

  await t.test('only unacknowledged, unresolved, uncleared alerts are candidates, newest first', () => {
    const acked = insert();
    db.ackAlert(acked);
    const resolved = insert();
    db.markAlertResolved(resolved, nextTs);
    const older = insert();
    const newer = insert({ rule: 'unhealthy', containerId: 'cccccccccccc', containerName: 'web' });
    assert.deepEqual(followUpIds(), [newer, older]);
    const row = db.getFollowUpAlerts({ limit: 500 }).find((a) => a.id === newer);
    assert.deepEqual(
      { ...row, id: 0, ts: 0 },
      {
        id: 0,
        ts: 0,
        hostId: FHOST,
        containerId: 'cccccccccccc',
        containerName: 'web',
        rule: 'unhealthy',
        severity: 'critical',
        message: 'down',
      }
    );
    db.clearAlerts(FHOST);
    assert.deepEqual(followUpIds(), [], 'a cleared alert gets no more reminders');
  });

  await t.test('hostIds limits candidates to those hosts; null means every host', () => {
    const here = insert();
    const elsewhere = insert({ hostId: 'db-test-deleted-host' });
    const ids = (hostIds) => db.getFollowUpAlerts({ limit: 500, statefulRules: ['host_unreachable'], hostIds }).map((a) => a.id);
    assert.ok(ids(null).includes(here) && ids(null).includes(elsewhere));
    assert.ok(ids([FHOST]).includes(here));
    assert.ok(!ids([FHOST]).includes(elsewhere), 'a host no longer configured gets no follow-ups');
    assert.deepEqual(ids([]), [], 'no hosts configured: nothing to follow up');
    db.ackAlert(here);
    db.ackAlert(elsewhere);
  });

  await t.test('getOpenContainerAlerts: open alerts on one host, for the named rules, acknowledged or not', () => {
    const OHOST = 'db-test-open-container-host';
    const add = (overrides) =>
      insert({
        hostId: OHOST,
        containerId: 'aaaaaaaaaaaa',
        containerName: 'web',
        rule: 'container_cpu',
        severity: 'warning',
        ...overrides,
      });
    const open = add();
    const acked = add({ rule: 'unhealthy' });
    db.ackAlert(acked);
    const resolved = add();
    db.markAlertResolved(resolved, nextTs);
    add({ rule: 'container_crashed' });
    add({ containerId: null, containerName: null, rule: 'host_cpu' });
    insert({ hostId: 'db-test-other-host', containerId: 'aaaaaaaaaaaa', rule: 'container_cpu' });
    const rows = db.getOpenContainerAlerts(OHOST, ['container_cpu', 'container_mem', 'unhealthy', 'host_cpu']);
    assert.deepEqual(rows.map((r) => r.id).sort(), [open, acked].sort());
    assert.deepEqual(
      { ...rows.find((r) => r.id === open), id: 0, ts: 0 },
      { id: 0, ts: 0, severity: 'warning', containerId: 'aaaaaaaaaaaa', containerName: 'web', rule: 'container_cpu' }
    );
    db.clearAlerts(OHOST);
    assert.deepEqual(db.getOpenContainerAlerts(OHOST, ['container_cpu', 'unhealthy']), [], 'a cleared alert is left alone');
  });

  await t.test('the partial index serves the sweep query', () => {
    const plan = db.client
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM alerts WHERE acknowledged = 0 AND resolved_at IS NULL AND cleared_at IS NULL ORDER BY ts DESC LIMIT 200'
      )
      .all()
      .map((r) => r.detail)
      .join(' | ');
    assert.match(plan, /idx_alerts_follow_up/);
  });

  await t.test('getAlertNotices: when the firing notice arrived, and the last reminder tried, per destination', () => {
    const id = insert();
    const add = (destination, kind, ts, delivered) => {
      const rowId = db.insertWebhookDelivery({ alertId: id, destination, kind, ts, payload: {} });
      if (delivered) db.markDeliveryDelivered(rowId);
    };
    add('main', 'firing', 1000, true);
    add('main', 'reminder', 5000, true);
    add('main', 'reminder', 9000, false);
    add('route:4', 'firing', 1000, false);
    const notices = Object.fromEntries(db.getAlertNotices(id).map((n) => [n.destination, n]));
    assert.ok(notices.main.firingDeliveredAt > 0);
    assert.equal(notices.main.lastReminderTs, 9000, 'a failed reminder still sets the pace - no retry every minute');
    assert.equal(notices['route:4'].firingDeliveredAt, null, 'never told, so no reminder');
    assert.equal(notices['route:4'].lastReminderTs, null);
  });

  await t.test('a failed reminder is never retried by the retry sweep', () => {
    const id = insert();
    const rowId = db.insertWebhookDelivery({ alertId: id, destination: 'main', kind: 'reminder', ts: nextTs, payload: {} });
    db.markDeliveryFailed(rowId);
    assert.ok(!db.getPendingDeliveries({ maxAttempts: 5, sinceTs: 0, limit: 500 }).some((d) => d.id === rowId));
  });
});

test('webhook_routes CRUD', () => {
  const id = db.insertWebhookRoute({ name: 'Ops phone', url: 'ntfy://ntfy.sh/ops', rules: ['host_unreachable'], minSeverity: 'critical' });
  let route = db.getWebhookRoutes().find((r) => r.id === id);
  assert.deepEqual(route, {
    id,
    name: 'Ops phone',
    url: 'ntfy://ntfy.sh/ops',
    format: '',
    hostId: null,
    rules: ['host_unreachable'],
    minSeverity: 'critical',
    notifyRecovery: false,
    enabled: true,
    delayMinutes: 0,
  });
  assert.equal(db.updateWebhookRoute(id, { ...route, hostId: 'edge', notifyRecovery: true, enabled: false, delayMinutes: 30 }), true);
  route = db.getWebhookRoutes().find((r) => r.id === id);
  assert.equal(route.delayMinutes, 30);
  assert.equal(route.hostId, 'edge');
  assert.equal(route.notifyRecovery, true);
  assert.equal(route.enabled, false);
  assert.equal(db.deleteWebhookRoute(id), true);
  assert.equal(db.deleteWebhookRoute(id), false);
  assert.equal(db.updateWebhookRoute(id, route), false);
});

test('container_alert_rules CRUD', async (t) => {
  await t.test('insertContainerAlertRule assigns increasing sort_order, returned in order by getContainerAlertRules', () => {
    const a = db.insertContainerAlertRule({ matchType: 'name', matchValue: 'redis' });
    const b = db.insertContainerAlertRule({ matchType: 'composeProject', matchValue: 'billing', hostId: 'h1' });
    const ids = db.getContainerAlertRules().map((r) => r.id);
    assert.ok(ids.indexOf(a) < ids.indexOf(b));
  });

  await t.test('round-trips nullable overrides and mutedRules', () => {
    const id = db.insertContainerAlertRule({
      matchType: 'name',
      matchValue: 'web',
      cpuThreshold: 80,
      memThreshold: null,
      sustainMinutes: 2,
      mutedRules: ['crash_loop', 'unhealthy'],
    });
    const rule = db.getContainerAlertRules().find((r) => r.id === id);
    assert.equal(rule.cpuThreshold, 80);
    assert.equal(rule.memThreshold, null);
    assert.equal(rule.sustainMinutes, 2);
    assert.deepEqual(rule.mutedRules, ['crash_loop', 'unhealthy']);
    assert.equal(rule.hostId, null);
  });

  await t.test('updateContainerAlertRule overwrites fields without changing sort_order', () => {
    const id = db.insertContainerAlertRule({ matchType: 'name', matchValue: 'orig' });
    const before = db.getContainerAlertRules().find((r) => r.id === id);
    db.updateContainerAlertRule(id, { matchType: 'composeProject', matchValue: 'updated', cpuThreshold: 55, mutedRules: ['unhealthy'] });
    const after = db.getContainerAlertRules().find((r) => r.id === id);
    assert.equal(after.matchType, 'composeProject');
    assert.equal(after.matchValue, 'updated');
    assert.equal(after.cpuThreshold, 55);
    assert.deepEqual(after.mutedRules, ['unhealthy']);
    assert.equal(after.sortOrder, before.sortOrder);
  });

  await t.test('deleteContainerAlertRule removes the row', () => {
    const id = db.insertContainerAlertRule({ matchType: 'name', matchValue: 'temp' });
    assert.equal(db.deleteContainerAlertRule(id), true);
    assert.equal(
      db.getContainerAlertRules().some((r) => r.id === id),
      false
    );
  });

  await t.test('update/delete report false for an id that no longer exists, so a route can 404', () => {
    const id = db.insertContainerAlertRule({ matchType: 'name', matchValue: 'gone' });
    db.deleteContainerAlertRule(id);
    assert.equal(db.deleteContainerAlertRule(id), false);
    assert.equal(db.updateContainerAlertRule(id, { matchType: 'name', matchValue: 'gone' }), false);
  });

  await t.test('reorderContainerAlertRules rewrites sort_order to match the given id list', () => {
    db.insertContainerAlertRule({ matchType: 'name', matchValue: 'order-x' });
    db.insertContainerAlertRule({ matchType: 'name', matchValue: 'order-y' });
    const before = db.getContainerAlertRules().map((r) => r.id);
    const reordered = [...before].reverse();
    db.reorderContainerAlertRules(reordered);
    const after = db.getContainerAlertRules().map((r) => r.id);
    assert.deepEqual(after, reordered);
  });
});

// Timing the synchronous writes is what makes event-loop lag attributable: watchdog.js can say the
// loop stalled, but only this says whether sqlite was the reason. Sampled into app.vitals.
test('write timing stats', async (t) => {
  await t.test('a metrics write is timed and reported', () => {
    db.takeWriteStats(); // clear anything earlier tests left behind
    db.insertMetrics([
      {
        hostId: 'wstat',
        containerId: 'c1',
        ts: Date.now(),
        cpuPerc: 1,
        memUsedBytes: 1,
        memPerc: 1,
        netRxBytes: 0,
        netTxBytes: 0,
        blockReadBytes: 0,
        blockWriteBytes: 0,
      },
    ]);
    const stats = db.takeWriteStats();
    assert.ok(stats.maxMs >= 0, 'a duration should have been recorded');
    assert.equal(stats.op, 'insertMetrics', 'and attributed to the statement that took it');
  });

  await t.test('maxMs resets on read so one slow write cannot pin the number forever', () => {
    // The property that makes a rising floor across consecutive vitals lines meaningful: without
    // it, a single bad commit at boot would keep reporting itself every minute thereafter.
    db.insertMetrics([
      {
        hostId: 'wstat',
        containerId: 'c2',
        ts: Date.now(),
        cpuPerc: 1,
        memUsedBytes: 1,
        memPerc: 1,
        netRxBytes: 0,
        netTxBytes: 0,
        blockReadBytes: 0,
        blockWriteBytes: 0,
      },
    ]);
    db.takeWriteStats();
    const second = db.takeWriteStats();
    assert.equal(second.maxMs, 0, 'a window with no writes reports no maximum');
    assert.equal(second.slow, 0);
  });

  await t.test('an empty sample list is not timed at all - it never reaches sqlite', () => {
    db.takeWriteStats();
    db.insertMetrics([]);
    assert.equal(db.takeWriteStats().op, null);
  });
});

// The host row used to be a loose .run() straight after the container transaction committed - two
// commits per host per poll where one would do. It now rides in the same
// transaction. These pin that: not "both rows exist" (which a split write also satisfies) but that
// they succeed and fail together, which only one transaction can do.
test('insertMetrics writes the host row in the same transaction', async (t) => {
  const hostRowsFor = (hostId) => db.client.prepare('SELECT COUNT(*) AS n FROM host_metrics WHERE host_id = ?').get(hostId).n;
  const hostSample = (hostId, overrides = {}) => ({
    hostId,
    ts: (nextTs += 1000),
    cpuPercent: 5,
    memUsedBytes: 100,
    systemCpuPercent: null,
    systemMemUsedBytes: null,
    systemMemTotalBytes: null,
    ...overrides,
  });

  await t.test('writes the container samples and the host row together', () => {
    db.insertMetrics([sample('c-with-host')], hostSample('h-with-container'));
    assert.equal(rowCountFor('c-with-host'), 1);
    assert.equal(hostRowsFor('h-with-container'), 1);
  });

  await t.test('round-trips the host row values', () => {
    db.insertMetrics([], hostSample('h-values', { cpuPercent: 33.5, memUsedBytes: 4242, systemCpuPercent: 12.25 }));
    const row = db.client.prepare('SELECT * FROM host_metrics WHERE host_id = ?').get('h-values');
    assert.equal(row.cpu_percent, 33.5);
    assert.equal(row.mem_used_bytes, 4242);
    assert.equal(row.system_cpu_percent, 12.25);
  });

  // An idle host has no running containers but still has a host row worth writing - so "no
  // container samples" must not be treated as "nothing to write" the way it was when this function
  // only ever wrote container rows.
  await t.test('a host row alone is still written', () => {
    db.insertMetrics([], hostSample('h-alone'));
    assert.equal(hostRowsFor('h-alone'), 1);
  });

  await t.test('no host row is fine too - not every poll has a cpu count to divide by', () => {
    db.insertMetrics([sample('c-no-host')], null);
    assert.equal(rowCountFor('c-no-host'), 1);
  });

  await t.test('nothing at all is a no-op', () => {
    const before = db.client.prepare('SELECT COUNT(*) AS n FROM host_metrics').get().n;
    assert.doesNotThrow(() => db.insertMetrics([], null));
    assert.equal(db.client.prepare('SELECT COUNT(*) AS n FROM host_metrics').get().n, before);
  });

  // The two halves of the atomicity check, and the pair is the actual point: either one alone
  // would still pass if the host row went back to being written outside the transaction.
  await t.test('a bad host row rolls the container samples back with it', () => {
    const bad = hostSample('h-bad');
    delete bad.systemMemTotalBytes;
    assert.throws(() => db.insertMetrics([sample('c-rolled-back'), sample('c-rolled-back')], bad));
    assert.equal(rowCountFor('c-rolled-back'), 0, 'container samples survived a failed host row - they are not in one transaction');
    assert.equal(hostRowsFor('h-bad'), 0);
  });

  await t.test('a bad container sample rolls the host row back with it', () => {
    const bad = sample('c-bad');
    delete bad.memPerc;
    assert.throws(() => db.insertMetrics([bad], hostSample('h-rolled-back')));
    assert.equal(hostRowsFor('h-rolled-back'), 0, 'the host row survived a failed container sample - it committed separately');
  });

  // db.js's timed() wraps this write specifically so a slow commit is attributable on the vitals
  // line. The host row was never inside it, so half the poll's storage cost was unreported.
  await t.test('the host row is inside the timed write, not outside it', () => {
    db.takeWriteStats();
    db.insertMetrics([], hostSample('h-timed'));
    const stats = db.takeWriteStats();
    assert.equal(stats.op, 'insertMetrics');
    assert.ok(stats.maxMs >= 0, 'a host-only write must still be measured');
  });
});

// Every alerts/events statement lives in db.js as a `name: db.prepare(`...`)` pair, so the check is
// a scan of the source rather than of the exports - that also catches a query added but not yet
// wired up. Prettier keeps the shape; PREPARE_COUNT_RE below fails loudly if one ever escapes it.
const DB_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
const NAMED_PREPARE_RE = /(\w+):\s*db\.prepare\(`([^`]*)`\)/g;
const PREPARE_COUNT_RE = /db\.prepare\(/g;
// Table position, not a bare word: `alert_breaches` and `container_alert_rules` are not soft-deleted
// and must not be dragged in by a substring match.
const SOFT_DELETED_TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:alerts|events)\b/i;

// Named, not pattern-matched, so adding a statement here is a deliberate act with a stated reason.
// The first three are the exceptions docs/architecture/server.md documents; the reasons are repeated at the statements
// themselves in db.js.
const CLEARED_AT_EXEMPT = {
  lastAlertFire: 'alerts.js cooldown - clearing the Activity tab must not re-arm a rule mid-cooldown',
  countRestartsSince: 'what the container did, not what the tab shows - clearing must not reset crash-loop detection',
  countRestartsByContainerSince: 'same as countRestartsSince, for the whole-host restart column',
  getContainerLifecycleEvents: 'same as countRestartsSince - the uptime rollup answers what the container actually did',
  getContainerLifecycleSeed: 'same as getContainerLifecycleEvents, for the single event that seeds the window',
  getContainersWithLifecycleEvents: 'same as getContainerLifecycleEvents - lists containers by what they did, clear or not',
  getUnresolvedAlert: 'a cleared alert was still sent by webhook, so its recovery is still news to whoever got it',
  markAlertResolved: 'single row by primary key; the id came from getUnresolvedAlert',
  pruneEvents: 'age-based retention delete - cleared rows are exactly what it has to reclaim',
  pruneAlerts: 'age-based retention delete, same as pruneEvents',
};

function preparedStatements() {
  const found = new Map();
  for (const [, name, sql] of DB_SOURCE.matchAll(NAMED_PREPARE_RE)) found.set(name, sql);
  return found;
}

test('alerts and events queries filter cleared_at', async (t) => {
  const statements = preparedStatements();

  await t.test('the scan sees every prepared statement in db.js', () => {
    const total = (DB_SOURCE.match(PREPARE_COUNT_RE) || []).length;
    assert.equal(statements.size, total, 'a statement is written in a shape this scan does not match - it would be checked by nobody');
  });

  await t.test('every soft-deleted read and update filters cleared_at', () => {
    const offenders = [];
    let checked = 0;
    for (const [name, sql] of statements) {
      if (!SOFT_DELETED_TABLE_RE.test(sql)) continue;
      if (/^\s*INSERT\b/i.test(sql)) continue;
      if (name in CLEARED_AT_EXEMPT) continue;
      checked += 1;
      if (!sql.includes('cleared_at')) offenders.push(name);
    }
    assert.ok(checked > 0, 'nothing was checked - the scan or the table pattern has stopped matching');
    assert.deepEqual(
      offenders,
      [],
      `these read cleared rows back: ${offenders.join(', ')}. Filter cleared_at, or add a reason to CLEARED_AT_EXEMPT.`
    );
  });

  // A renamed or deleted statement leaves its exemption behind, quietly excusing whatever takes the
  // name next. Failing here forces the reason to be re-justified against the new query.
  await t.test('no stale exemptions', () => {
    const stale = Object.keys(CLEARED_AT_EXEMPT).filter((name) => !statements.has(name));
    assert.deepEqual(stale, [], `exempted statements that no longer exist: ${stale.join(', ')}`);
  });

  await t.test('the clears themselves are still soft', () => {
    for (const name of ['clearEventsByHost', 'clearAlertsByHost']) {
      assert.match(statements.get(name), /^\s*UPDATE\b/i, `${name} must set cleared_at, never DELETE`);
      assert.ok(statements.get(name).includes('cleared_at = ?'), `${name} must stamp cleared_at`);
    }
  });
});

// The big tables prune by rowid rather than "WHERE ts < ?", which no index could serve and so
// scanned the whole table every hour (763ms on 6M rows). Rowid order is insert order, which is
// time order except across a clock step - so the one property that must hold whatever the order
// is that nothing inside retention is ever deleted.
test('pruneOld: rowid-walk prune of the metrics and events tables', async (t) => {
  const DAY = 86_400_000;
  const now = Date.now();
  const keepAll = Number.MAX_SAFE_INTEGER / 2;
  const reset = () => db.client.exec('DELETE FROM container_metrics; DELETE FROM host_metrics; DELETE FROM events');
  const sample = (ts) => ({
    hostId: 'prune-host',
    containerId: 'aaaaaaaaaaaa',
    ts,
    cpuPerc: 1,
    memUsedBytes: 1,
    memPerc: 1,
    netRxBytes: 0,
    netTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
  });
  const host = (ts) => ({
    hostId: 'prune-host',
    ts,
    cpuPercent: 1,
    memUsedBytes: 1,
    systemCpuPercent: null,
    systemMemUsedBytes: null,
    systemMemTotalBytes: null,
  });
  const metricTs = () =>
    db.client
      .prepare('SELECT ts FROM container_metrics ORDER BY id')
      .all()
      .map((r) => r.ts);
  const prune = (metricsDays) =>
    db.pruneOld({ metricsRetentionMs: metricsDays * DAY, eventsRetentionMs: keepAll, auditRetentionMs: keepAll });

  await t.test('deletes rows older than retention and keeps the rest', () => {
    reset();
    const ts = [now - 9 * DAY, now - 8 * DAY, now - 6 * DAY, now - DAY];
    for (const x of ts) db.insertMetrics([sample(x)], host(x));
    const res = prune(7);
    assert.equal(res.containerMetrics, 2);
    assert.equal(res.hostMetrics, 2);
    assert.deepEqual(metricTs(), ts.slice(2));
  });

  await t.test('never deletes a row inside retention, even out of insert order', () => {
    reset();
    // A clock stepped back: a recent row sits below an old one in rowid order.
    for (const x of [now - 9 * DAY, now - DAY, now - 8 * DAY, now - 2 * DAY]) db.insertMetrics([sample(x)]);
    prune(7);
    assert.deepEqual(metricTs(), [now - DAY, now - 8 * DAY, now - 2 * DAY], 'the stale row past the boundary waits for a later prune');
  });

  await t.test('a table with nothing inside retention is emptied', () => {
    reset();
    for (const x of [now - 9 * DAY, now - 8 * DAY]) db.insertMetrics([sample(x)]);
    assert.equal(prune(7).containerMetrics, 2);
    assert.deepEqual(metricTs(), []);
  });

  await t.test('events prune the same way', () => {
    reset();
    const event = (ts) =>
      db.insertEvent({ hostId: 'prune-host', containerId: 'aaaaaaaaaaaa', containerName: 'web', action: 'start', ts, rawJson: null });
    event(now - 40 * DAY);
    event(now - DAY);
    const res = db.pruneOld({ metricsRetentionMs: keepAll, eventsRetentionMs: 30 * DAY, auditRetentionMs: keepAll });
    assert.equal(res.events, 1);
    assert.deepEqual(
      db.client
        .prepare('SELECT ts FROM events')
        .all()
        .map((r) => r.ts),
      [now - DAY]
    );
  });

  await t.test('the delete is a rowid range, not a scan of the table', () => {
    for (const table of ['container_metrics', 'host_metrics', 'events']) {
      const sql = DB_SOURCE.match(new RegExp(`DELETE FROM ${table} WHERE id < [^\`]*`))[0];
      const plan = db.client
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(now)
        .map((r) => r.detail);
      assert.equal(plan[0], `SEARCH ${table} USING INTEGER PRIMARY KEY (rowid<?)`, `${table}: ${plan.join(' | ')}`);
    }
  });
  reset();
});
