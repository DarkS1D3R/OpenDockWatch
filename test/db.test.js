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
    action: 'restart',
    ts: (nextTs += 1000),
    rawJson: '{}',
    ...overrides,
  });

  await t.test('cleared events leave the feed, scoped to one host', () => {
    db.insertEvent(event(CLEAR_HOST));
    db.insertEvent(event(CLEAR_HOST, { action: 'start' }));
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
    db.markWebhookAttemptFailed(id);
    const pending = () => db.getPendingWebhookRetries({ maxAttempts: 5, sinceTs: 0, limit: 10 }).some((a) => a.id === id);
    assert.equal(pending(), true);
    db.clearAlerts(CLEAR_HOST);
    assert.equal(pending(), false);
  });
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
// The first three are the exceptions CLAUDE.md documents; the reasons are repeated at the statements
// themselves in db.js.
const CLEARED_AT_EXEMPT = {
  lastAlertFire: 'alerts.js cooldown - clearing the Activity tab must not re-arm a rule mid-cooldown',
  countRestartsSince: 'what the container did, not what the tab shows - clearing must not reset crash-loop detection',
  countRestartsByContainerSince: 'same as countRestartsSince, for the whole-host restart column',
  markWebhookDelivered: 'single row by primary key; the id came from getPendingWebhookRetries, which already filters',
  markWebhookAttemptFailed: 'single row by primary key, same as markWebhookDelivered',
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
