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
