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

test('insertContainerMetrics', async (t) => {
  await t.test('writes every sample in the batch', () => {
    db.insertContainerMetrics([sample('c-all-1'), sample('c-all-1'), sample('c-all-2')]);
    assert.equal(rowCountFor('c-all-1'), 2);
    assert.equal(rowCountFor('c-all-2'), 1);
  });

  await t.test('round-trips the column values, not just the row count', () => {
    const one = sample('c-values', { cpuPerc: 42.5, memUsedBytes: 999, netRxBytes: 7 });
    db.insertContainerMetrics([one]);
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
    assert.doesNotThrow(() => db.insertContainerMetrics([]));
    assert.equal(db.client.prepare('SELECT COUNT(*) AS n FROM container_metrics').get().n, before);
  });

  // The point of the transaction is throughput, but atomicity comes with it and is worth pinning:
  // a malformed sample rolls the whole poll back rather than leaving the batch half-written, which
  // would put a partial instant into the history charts.
  await t.test('a bad sample rolls the whole batch back', () => {
    const bad = sample('c-atomic');
    delete bad.memPerc;
    assert.throws(() => db.insertContainerMetrics([sample('c-atomic'), bad, sample('c-atomic')]));
    assert.equal(rowCountFor('c-atomic'), 0, 'partial batch survived a failed insert');
  });

  // Downsampling reads these rows back through BUCKET_EXPR and withIoRates; batching must not have
  // changed what lands in the table from the history queries' point of view.
  await t.test('batched rows are readable through the history query', () => {
    const base = nextTs + 1000;
    db.insertContainerMetrics([
      sample('c-history', { ts: base, cpuPerc: 10, netRxBytes: 1000 }),
      sample('c-history', { ts: base + 1000, cpuPerc: 20, netRxBytes: 3000 }),
    ]);
    const rows = db.getContainerMetricsHistory(HOST, 'c-history', base - 1000, 15_000);
    assert.equal(rows.length, 1, 'both samples should fall in one 15s bucket');
    assert.equal(rows[0].cpuPerc, 15, 'bucket should average the two cpu samples');
  });
});
