const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'opendockwatch.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS container_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id TEXT NOT NULL,
    container_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu_perc REAL,
    mem_used_bytes INTEGER,
    mem_perc REAL,
    net_rx_bytes INTEGER,
    net_tx_bytes INTEGER,
    block_read_bytes INTEGER,
    block_write_bytes INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_container_metrics_lookup ON container_metrics (host_id, container_id, ts);

  CREATE TABLE IF NOT EXISTS host_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu_percent REAL,
    mem_used_bytes INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_host_metrics_lookup ON host_metrics (host_id, ts);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id TEXT NOT NULL,
    container_id TEXT,
    container_name TEXT,
    action TEXT NOT NULL,
    ts INTEGER NOT NULL,
    raw_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_lookup ON events (host_id, container_id, ts);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    username TEXT,
    host_id TEXT NOT NULL,
    container_id TEXT,
    container_name TEXT,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_lookup ON audit_log (host_id, ts);

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    host_id TEXT NOT NULL,
    container_id TEXT,
    container_name TEXT,
    rule TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_lookup ON alerts (host_id, ts);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const stmts = {
  insertContainerMetric: db.prepare(`
    INSERT INTO container_metrics
      (host_id, container_id, ts, cpu_perc, mem_used_bytes, mem_perc, net_rx_bytes, net_tx_bytes, block_read_bytes, block_write_bytes)
    VALUES (@hostId, @containerId, @ts, @cpuPerc, @memUsedBytes, @memPerc, @netRxBytes, @netTxBytes, @blockReadBytes, @blockWriteBytes)
  `),
  insertHostMetric: db.prepare(`
    INSERT INTO host_metrics (host_id, ts, cpu_percent, mem_used_bytes)
    VALUES (@hostId, @ts, @cpuPercent, @memUsedBytes)
  `),
  insertEvent: db.prepare(`
    INSERT INTO events (host_id, container_id, container_name, action, ts, raw_json)
    VALUES (@hostId, @containerId, @containerName, @action, @ts, @rawJson)
  `),
  insertAuditLog: db.prepare(`
    INSERT INTO audit_log (ts, username, host_id, container_id, container_name, action, result, error)
    VALUES (@ts, @username, @hostId, @containerId, @containerName, @action, @result, @error)
  `),
  insertAlert: db.prepare(`
    INSERT INTO alerts (ts, host_id, container_id, container_name, rule, severity, message, acknowledged)
    VALUES (@ts, @hostId, @containerId, @containerName, @rule, @severity, @message, 0)
  `),
  ackAlert: db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`),
  lastAlertFire: db.prepare(`
    SELECT ts FROM alerts
    WHERE host_id = ? AND container_id = ? AND rule = ?
    ORDER BY ts DESC LIMIT 1
  `),
  countRestartsSince: db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE host_id = ? AND container_id = ? AND ts >= ? AND action IN ('start', 'restart')
  `),
  countRestartsByContainerSince: db.prepare(`
    SELECT container_id AS containerId, COUNT(*) AS n FROM events
    WHERE host_id = ? AND ts >= ? AND action IN ('start', 'restart')
    GROUP BY container_id
  `),
  countOpenAlertsByContainer: db.prepare(`
    SELECT container_id AS containerId, COUNT(*) AS n FROM alerts
    WHERE host_id = ? AND acknowledged = 0
    GROUP BY container_id
  `),
  countManualStopsSince: db.prepare(`
    SELECT COUNT(*) AS n FROM audit_log
    WHERE host_id = ? AND container_id = ? AND ts >= ? AND action IN ('stop', 'restart') AND result = 'ok'
  `),
  countManualStartsSince: db.prepare(`
    SELECT COUNT(*) AS n FROM audit_log
    WHERE host_id = ? AND container_id = ? AND ts >= ? AND action IN ('start', 'restart') AND result = 'ok'
  `),
  pruneContainerMetrics: db.prepare(`DELETE FROM container_metrics WHERE ts < ?`),
  pruneHostMetrics: db.prepare(`DELETE FROM host_metrics WHERE ts < ?`),
  pruneEvents: db.prepare(`DELETE FROM events WHERE ts < ?`),
  pruneAuditLog: db.prepare(`DELETE FROM audit_log WHERE ts < ?`),
  pruneAlerts: db.prepare(`DELETE FROM alerts WHERE ts < ?`),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  deleteSetting: db.prepare(`DELETE FROM settings WHERE key = ?`),
};

function insertContainerMetric(sample) {
  stmts.insertContainerMetric.run(sample);
}

function insertHostMetric(sample) {
  stmts.insertHostMetric.run(sample);
}

function insertEvent(event) {
  const info = stmts.insertEvent.run(event);
  return info.lastInsertRowid;
}

function insertAuditLog(entry) {
  stmts.insertAuditLog.run(entry);
}

function insertAlert(alert) {
  const info = stmts.insertAlert.run(alert);
  return info.lastInsertRowid;
}

function ackAlert(id) {
  stmts.ackAlert.run(id);
}

function getLastAlertFireTs(hostId, containerId, rule) {
  const row = stmts.lastAlertFire.get(hostId, containerId, rule);
  return row ? row.ts : null;
}

function countRestartsSince(hostId, containerId, sinceTs) {
  return stmts.countRestartsSince.get(hostId, containerId, sinceTs).n;
}

// Batched form of countRestartsSince - one GROUP BY query per host instead of
// one query per container, for callers (poll loops, /metrics) that need the
// count for every container on a host at once.
function getRestartCountsByContainer(hostId, sinceTs) {
  const rows = stmts.countRestartsByContainerSince.all(hostId, sinceTs);
  return new Map(rows.map((r) => [r.containerId, r.n]));
}

function countManualStopsSince(hostId, containerId, sinceTs) {
  return stmts.countManualStopsSince.get(hostId, containerId, sinceTs).n;
}

function countManualStartsSince(hostId, containerId, sinceTs) {
  return stmts.countManualStartsSince.get(hostId, containerId, sinceTs).n;
}

function getEvents(hostId, { sinceTs = 0, limit = 200 } = {}) {
  return db.prepare(`SELECT * FROM events WHERE host_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`).all(hostId, sinceTs, limit);
}

function getAuditLog(hostId, { limit = 200 } = {}) {
  if (hostId) {
    return db.prepare(`SELECT * FROM audit_log WHERE host_id = ? ORDER BY ts DESC LIMIT ?`).all(hostId, limit);
  }
  return db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`).all(limit);
}

function getAlerts(hostId, { limit = 200 } = {}) {
  if (hostId) {
    return db.prepare(`SELECT * FROM alerts WHERE host_id = ? ORDER BY ts DESC LIMIT ?`).all(hostId, limit);
  }
  return db.prepare(`SELECT * FROM alerts ORDER BY ts DESC LIMIT ?`).all(limit);
}

function countOpenAlerts(hostId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE host_id = ? AND acknowledged = 0`).get(hostId).n;
}

// Batched form of countOpenAlerts, per-container - for the topology route, which needs an open
// alert count for every container on a host at once.
function getOpenAlertCountsByContainer(hostId) {
  const rows = stmts.countOpenAlertsByContainer.all(hostId);
  return new Map(rows.map((r) => [r.containerId, r.n]));
}

// null means "no row" (caller should fall back to a default), distinct from an
// explicitly-stored empty string.
function getSetting(key) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  stmts.setSetting.run(key, value);
}

function deleteSetting(key) {
  stmts.deleteSetting.run(key);
}

// Buckets samples into `bucketMs`-wide windows and averages numeric columns - keeps
// chart payloads small over long ranges without a separate downsampling job.
function getContainerMetricsHistory(hostId, containerId, sinceTs, bucketMs) {
  return db
    .prepare(
      `
      SELECT
        (ts / @bucketMs) * @bucketMs AS bucket,
        AVG(cpu_perc) AS cpuPerc,
        AVG(mem_used_bytes) AS memUsedBytes,
        AVG(mem_perc) AS memPerc,
        AVG(net_rx_bytes) AS netRxBytes,
        AVG(net_tx_bytes) AS netTxBytes,
        AVG(block_read_bytes) AS blockReadBytes,
        AVG(block_write_bytes) AS blockWriteBytes
      FROM container_metrics
      WHERE host_id = @hostId AND container_id = @containerId AND ts >= @sinceTs
      GROUP BY bucket
      ORDER BY bucket ASC
    `
    )
    .all({ hostId, containerId, sinceTs, bucketMs });
}

function getHostMetricsHistory(hostId, sinceTs, bucketMs) {
  return db
    .prepare(
      `
      SELECT
        (ts / @bucketMs) * @bucketMs AS bucket,
        AVG(cpu_percent) AS cpuPercent,
        AVG(mem_used_bytes) AS memUsedBytes
      FROM host_metrics
      WHERE host_id = @hostId AND ts >= @sinceTs
      GROUP BY bucket
      ORDER BY bucket ASC
    `
    )
    .all({ hostId, sinceTs, bucketMs });
}

function close() {
  db.close();
}

function pruneOld({ metricsRetentionMs, eventsRetentionMs, auditRetentionMs }) {
  const now = Date.now();
  stmts.pruneContainerMetrics.run(now - metricsRetentionMs);
  stmts.pruneHostMetrics.run(now - metricsRetentionMs);
  stmts.pruneEvents.run(now - eventsRetentionMs);
  stmts.pruneAuditLog.run(now - auditRetentionMs);
  stmts.pruneAlerts.run(now - auditRetentionMs);
}

module.exports = {
  client: db,
  insertContainerMetric,
  insertHostMetric,
  insertEvent,
  insertAuditLog,
  insertAlert,
  ackAlert,
  getLastAlertFireTs,
  countRestartsSince,
  getRestartCountsByContainer,
  countManualStopsSince,
  countManualStartsSince,
  getEvents,
  getAuditLog,
  getAlerts,
  countOpenAlerts,
  getOpenAlertCountsByContainer,
  getContainerMetricsHistory,
  getHostMetricsHistory,
  getSetting,
  setSetting,
  deleteSetting,
  pruneOld,
  close,
};
