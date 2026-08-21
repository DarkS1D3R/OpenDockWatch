const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const logger = require('./logger');
const { withIoRates, BUCKET_EXPR } = require('./metricsHistory');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Overridable so test/index.test.js can point this at an isolated temp file instead of the real
// data/opendockwatch.db - opening that file directly from a test risks wedging a real running
// container's WAL/shm state. Unset in normal operation, a no-op for npm start/the Dockerfile.
const DB_PATH = process.env.OPENDOCKWATCH_DB_PATH || path.join(DATA_DIR, 'opendockwatch.db');

const db = new Database(DB_PATH);
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
    mem_used_bytes INTEGER,
    system_cpu_percent REAL,
    system_mem_used_bytes INTEGER,
    system_mem_total_bytes INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_host_metrics_lookup ON host_metrics (host_id, ts);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id TEXT NOT NULL,
    container_id TEXT,
    container_name TEXT,
    action TEXT NOT NULL,
    ts INTEGER NOT NULL,
    raw_json TEXT,
    cleared_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_lookup ON events (host_id, container_id, ts);
  -- getEvents filters on host_id and ts but not container_id, so the index above can only use its
  -- leading column and SQLite sorts the host's whole retained history to answer a LIMIT 200.
  -- This one makes it an index walk that stops at the limit. Both are kept - countRestartsSince
  -- is per-container and still wants the first, and counts cleared rows so it needs the full index.
  CREATE INDEX IF NOT EXISTS idx_events_host_ts ON events (host_id, ts);
  -- A third events index (idx_events_host_ts_active) is created after the ALTER TABLE block below,
  -- not here: it is partial on cleared_at, which an upgrading database doesn't have yet.

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
    acknowledged INTEGER NOT NULL DEFAULT 0,
    webhook_delivered_at INTEGER,
    webhook_attempts INTEGER NOT NULL DEFAULT 0,
    cleared_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_lookup ON alerts (host_id, ts);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Persists alerts.js's in-memory sustained-breach tracking so a restart mid-breach doesn't
  -- silently reset the countdown. "key" is the string alerts.js builds in memory
  -- (hostId:containerId:rule or hostId:host:rule) - opaque to this table, just persisted as-is.
  CREATE TABLE IF NOT EXISTS alert_breaches (
    key TEXT PRIMARY KEY,
    start_ts INTEGER NOT NULL
  );

  -- Per-container/name/compose-project alert overrides, evaluated in sort_order as an ordered,
  -- first-match-wins list by alerts.js's resolveContainerConfig - see server/CLAUDE.md. host_id NULL
  -- means "all hosts"; cpu/mem/sustain NULL means "inherit the global threshold for that field".
  -- muted_rules is a JSON array (container_crashed/crash_loop/unhealthy) rather than one column
  -- per rule so a future event rule doesn't need an ALTER TABLE.
  CREATE TABLE IF NOT EXISTS container_alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id TEXT,
    match_type TEXT NOT NULL CHECK (match_type IN ('name', 'composeProject')),
    match_value TEXT NOT NULL,
    cpu_threshold REAL,
    mem_threshold REAL,
    sustain_minutes REAL,
    muted_rules TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_container_alert_rules_order ON container_alert_rules (sort_order);
`);

// host_metrics gained these three columns after the table already existed for upgrading installs
// - CREATE TABLE IF NOT EXISTS only covers a fresh database, so ALTER TABLE backfills them onto
// one that predates this, swallowing "duplicate column" once already applied (see server/CLAUDE.md).
for (const column of ['system_cpu_percent REAL', 'system_mem_used_bytes INTEGER', 'system_mem_total_bytes INTEGER']) {
  try {
    db.exec(`ALTER TABLE host_metrics ADD COLUMN ${column}`);
  } catch {
    /* column already exists */
  }
}

// Same upgrading-install backfill as above, for the webhook delivery tracking columns and the
// Activity tab's Clear marker. NULL means visible, so an existing row needs no backfill value.
for (const column of ['webhook_delivered_at INTEGER', 'webhook_attempts INTEGER NOT NULL DEFAULT 0', 'cleared_at INTEGER']) {
  try {
    db.exec(`ALTER TABLE alerts ADD COLUMN ${column}`);
  } catch {
    /* column already exists */
  }
}

// And events' own Clear marker. Its partial index has to be created down here rather than in the
// schema block: a CREATE INDEX naming a column the ALTER above has just added would throw on an
// upgrading database, where the block runs against the old table. See server/CLAUDE.md.
try {
  db.exec(`ALTER TABLE events ADD COLUMN cleared_at INTEGER`);
} catch {
  /* column already exists */
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_host_ts_active ON events (host_id, ts) WHERE cleared_at IS NULL`);

const stmts = {
  insertContainerMetric: db.prepare(`
    INSERT INTO container_metrics
      (host_id, container_id, ts, cpu_perc, mem_used_bytes, mem_perc, net_rx_bytes, net_tx_bytes, block_read_bytes, block_write_bytes)
    VALUES (@hostId, @containerId, @ts, @cpuPerc, @memUsedBytes, @memPerc, @netRxBytes, @netTxBytes, @blockReadBytes, @blockWriteBytes)
  `),
  insertHostMetric: db.prepare(`
    INSERT INTO host_metrics (host_id, ts, cpu_percent, mem_used_bytes, system_cpu_percent, system_mem_used_bytes, system_mem_total_bytes)
    VALUES (@hostId, @ts, @cpuPercent, @memUsedBytes, @systemCpuPercent, @systemMemUsedBytes, @systemMemTotalBytes)
  `),
  insertEvent: db.prepare(`
    INSERT INTO events (host_id, container_id, container_name, action, ts, raw_json)
    VALUES (@hostId, @containerId, @containerName, @action, @ts, @rawJson)
  `),
  insertAuditLog: db.prepare(`
    INSERT INTO audit_log (ts, username, host_id, container_id, container_name, action, result, error)
    VALUES (@ts, @username, @hostId, @containerId, @containerName, @action, @result, @error)
  `),
  updateAuditLogResult: db.prepare(`UPDATE audit_log SET result = ?, error = ? WHERE id = ?`),
  insertAlert: db.prepare(`
    INSERT INTO alerts (ts, host_id, container_id, container_name, rule, severity, message, acknowledged)
    VALUES (@ts, @hostId, @containerId, @containerName, @rule, @severity, @message, 0)
  `),
  ackAlert: db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ? AND cleared_at IS NULL`),
  // Used by index.js's ack route to know which host's dashboard cache to invalidate. Filtered same
  // as ackAlert's own WHERE, so "not found" needs no CLEARED_AT_EXEMPT entry. See server/CLAUDE.md.
  getAlertHostId: db.prepare(`SELECT host_id AS hostId FROM alerts WHERE id = ? AND cleared_at IS NULL`),
  ackAllAlerts: db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE host_id = ? AND acknowledged = 0 AND cleared_at IS NULL`),
  markWebhookDelivered: db.prepare(`UPDATE alerts SET webhook_delivered_at = ?, webhook_attempts = webhook_attempts + 1 WHERE id = ?`),
  markWebhookAttemptFailed: db.prepare(`UPDATE alerts SET webhook_attempts = webhook_attempts + 1 WHERE id = ?`),
  // Picked up by alerts.js's retry sweep: never-attempted rows (webhook_attempts = 0) are
  // deliberately excluded, only actually-tried-and-failed ones retry. sinceTs bounds the
  // lookback so a webhook down for hours doesn't get its whole backlog replayed at once.
  getPendingWebhookRetries: db.prepare(`
    SELECT * FROM alerts
    WHERE webhook_delivered_at IS NULL AND webhook_attempts > 0 AND webhook_attempts < @maxAttempts
      AND ts >= @sinceTs AND cleared_at IS NULL
    ORDER BY ts ASC
    LIMIT @limit
  `),
  setBreachStart: db.prepare(`
    INSERT INTO alert_breaches (key, start_ts) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET start_ts = excluded.start_ts
  `),
  deleteBreachStart: db.prepare(`DELETE FROM alert_breaches WHERE key = ?`),
  getAllBreaches: db.prepare(`SELECT key, start_ts AS startTs FROM alert_breaches`),
  // The one alerts query that deliberately ignores cleared_at: this is alerts.js's cooldown, and
  // clearing the Activity tab must not re-arm a rule that is still inside it. See server/CLAUDE.md.
  lastAlertFire: db.prepare(`
    SELECT ts FROM alerts
    WHERE host_id = ? AND container_id IS ? AND rule = ?
    ORDER BY ts DESC LIMIT 1
  `),
  // These two deliberately ignore cleared_at, the same exception lastAlertFire makes above: they
  // are what a container actually did, not what the Activity tab is showing, and emptying that
  // list must not reset crash-loop detection or walk the restart column back to zero.
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
    WHERE host_id = ? AND acknowledged = 0 AND cleared_at IS NULL
    GROUP BY container_id
  `),
  // No `result = 'ok'` filter: index.js writes this row's ts when the action is requested, before
  // the docker CLI call resolves, so it's present (still 'pending') when a fast die/start event
  // races the CLI call. Excluding pending/error rows would reopen that race.
  countManualStopsSince: db.prepare(`
    SELECT COUNT(*) AS n FROM audit_log
    WHERE host_id = ? AND container_id = ? AND ts >= ? AND action IN ('stop', 'restart')
  `),
  countManualStartsSince: db.prepare(`
    SELECT COUNT(*) AS n FROM audit_log
    WHERE host_id = ? AND container_id = ? AND ts >= ? AND action IN ('start', 'restart')
  `),
  pruneContainerMetrics: db.prepare(`DELETE FROM container_metrics WHERE ts < ?`),
  pruneHostMetrics: db.prepare(`DELETE FROM host_metrics WHERE ts < ?`),
  pruneEvents: db.prepare(`DELETE FROM events WHERE ts < ?`),
  pruneAuditLog: db.prepare(`DELETE FROM audit_log WHERE ts < ?`),
  pruneAlerts: db.prepare(`DELETE FROM alerts WHERE ts < ?`),
  clearEventsByHost: db.prepare(`UPDATE events SET cleared_at = ? WHERE host_id = ? AND cleared_at IS NULL`),
  clearAlertsByHost: db.prepare(`UPDATE alerts SET cleared_at = ? WHERE host_id = ? AND cleared_at IS NULL`),
  getEvents: db.prepare(`SELECT * FROM events WHERE host_id = ? AND ts >= ? AND cleared_at IS NULL ORDER BY ts DESC LIMIT ?`),
  getAuditLogByHost: db.prepare(`SELECT * FROM audit_log WHERE host_id = ? ORDER BY ts DESC LIMIT ?`),
  getAuditLogAll: db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`),
  getAlertsByHost: db.prepare(`SELECT * FROM alerts WHERE host_id = ? AND cleared_at IS NULL ORDER BY ts DESC LIMIT ?`),
  getAlertsAll: db.prepare(`SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY ts DESC LIMIT ?`),
  countOpenAlerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE host_id = ? AND acknowledged = 0 AND cleared_at IS NULL`),
  // Buckets into `bucketMs`-wide windows and averages numeric columns; the four I/O columns use
  // MAX not AVG since they're cumulative counters - metricsHistory.js's withIoRates turns
  // consecutive bucket totals into displayed rates. See server/CLAUDE.md for the restart-edge-case note.
  containerMetricsHistory: db.prepare(`
    SELECT
      ${BUCKET_EXPR} AS bucket,
      AVG(cpu_perc) AS cpuPerc,
      AVG(mem_used_bytes) AS memUsedBytes,
      AVG(mem_perc) AS memPerc,
      MAX(net_rx_bytes) AS netRxTotal,
      MAX(net_tx_bytes) AS netTxTotal,
      MAX(block_read_bytes) AS blockReadTotal,
      MAX(block_write_bytes) AS blockWriteTotal
    FROM container_metrics
    WHERE host_id = @hostId AND container_id = @containerId AND ts >= @sinceTs
    GROUP BY bucket
    ORDER BY bucket ASC
  `),
  hostMetricsHistory: db.prepare(`
    SELECT
      ${BUCKET_EXPR} AS bucket,
      AVG(cpu_percent) AS cpuPercent,
      AVG(mem_used_bytes) AS memUsedBytes,
      AVG(system_cpu_percent) AS systemCpuPercent,
      AVG(system_mem_used_bytes) AS systemMemUsedBytes,
      AVG(system_mem_total_bytes) AS systemMemTotalBytes
    FROM host_metrics
    WHERE host_id = @hostId AND ts >= @sinceTs
    GROUP BY bucket
    ORDER BY bucket ASC
  `),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  deleteSetting: db.prepare(`DELETE FROM settings WHERE key = ?`),
  ping: db.prepare(`SELECT 1`),
  insertContainerAlertRule: db.prepare(`
    INSERT INTO container_alert_rules
      (host_id, match_type, match_value, cpu_threshold, mem_threshold, sustain_minutes, muted_rules, sort_order)
    VALUES (@hostId, @matchType, @matchValue, @cpuThreshold, @memThreshold, @sustainMinutes, @mutedRules, @sortOrder)
  `),
  updateContainerAlertRule: db.prepare(`
    UPDATE container_alert_rules
    SET host_id = @hostId, match_type = @matchType, match_value = @matchValue,
        cpu_threshold = @cpuThreshold, mem_threshold = @memThreshold, sustain_minutes = @sustainMinutes,
        muted_rules = @mutedRules
    WHERE id = @id
  `),
  deleteContainerAlertRule: db.prepare(`DELETE FROM container_alert_rules WHERE id = ?`),
  // id ASC tiebreak keeps ordering deterministic even if two rows ever share a sort_order (e.g. a
  // double-submitted reorder from two open tabs) rather than depending on SQLite's unspecified tie order.
  getContainerAlertRules: db.prepare(`SELECT * FROM container_alert_rules ORDER BY sort_order ASC, id ASC`),
  getContainerAlertRuleMaxSortOrder: db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM container_alert_rules`),
  setContainerAlertRuleSortOrder: db.prepare(`UPDATE container_alert_rules SET sort_order = ? WHERE id = ?`),
};

// One transaction for the whole poll, not one commit per row - and that now includes the host
// row, which used to be a loose .run() right after this one committed. A commit is not an fsync
// here (WAL runs at synchronous=NORMAL) but it is still event-loop time. See server/CLAUDE.md.
const insertMetricsTx = db.transaction((samples, hostSample) => {
  for (const sample of samples) stmts.insertContainerMetric.run(sample);
  if (hostSample) stmts.insertHostMetric.run(hostSample);
});

function insertMetrics(samples, hostSample = null) {
  // better-sqlite3 would happily run an empty transaction; skipping it avoids a pointless commit
  // on a poll with nothing at all to write - an unreachable host's, or one whose `docker info`
  // came back without a cpu count to divide by.
  if (!samples.length && !hostSample) return;
  timed('insertMetrics', () => insertMetricsTx(samples, hostSample));
}

// better-sqlite3 is synchronous, so every write here is event-loop time - which is why a slow
// bind-mounted volume shows up as application lag, and why a WAL checkpoint (where the fsyncs
// actually are, not at each commit) can land inside one. watchdog.js can say the loop stalled but
// never why; this is the attribution. Only the two writes big enough to matter are wrapped (the
// per-poll transaction and the hourly prune, which is a full table scan) - timing every single-row
// statement would cost more than it tells you. Rounded on read to keep the hot path to one subtraction.
const SLOW_DB_WRITE_MS = Number(process.env.SLOW_DB_WRITE_MS) || 250;
let writeStats = { lastMs: 0, maxMs: 0, slow: 0, op: null };

function timed(op, fn) {
  const startedAt = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    writeStats.lastMs = ms;
    if (ms > writeStats.maxMs) {
      writeStats.maxMs = ms;
      writeStats.op = op;
    }
    if (ms >= SLOW_DB_WRITE_MS) {
      writeStats.slow += 1;
      logger.warn('db.write.slow', { op, tookMs: Math.round(ms), thresholdMs: SLOW_DB_WRITE_MS });
    }
  }
}

// Same contract as metricsCollector.takePollStats: maxMs is since the last read, so a rising
// floor across consecutive vitals lines is the storage degrading rather than one bad commit
// hours ago pinning the number forever.
function takeWriteStats() {
  const out = { ...writeStats, lastMs: Math.round(writeStats.lastMs), maxMs: Math.round(writeStats.maxMs) };
  writeStats = { lastMs: writeStats.lastMs, maxMs: 0, slow: 0, op: null };
  return out;
}

// The standalone form, deliberately not what the poll uses - it takes a commit of its own rather
// than joining the poll's. Kept for callers writing a host row outside a poll, e.g. seeding in tests.
function insertHostMetric(sample) {
  stmts.insertHostMetric.run(sample);
}

function insertEvent(event) {
  const info = stmts.insertEvent.run(event);
  return info.lastInsertRowid;
}

function insertAuditLog(entry) {
  return stmts.insertAuditLog.run(entry).lastInsertRowid;
}

function updateAuditLogResult(id, result, error) {
  stmts.updateAuditLogResult.run(result, error, id);
}

function insertAlert(alert) {
  const info = stmts.insertAlert.run(alert);
  return info.lastInsertRowid;
}

function ackAlert(id) {
  stmts.ackAlert.run(id);
}

function getAlertHostId(id) {
  const row = stmts.getAlertHostId.get(id);
  return row ? row.hostId : null;
}

function ackAllAlerts(hostId) {
  return stmts.ackAllAlerts.run(hostId).changes;
}

function markWebhookDelivered(id) {
  stmts.markWebhookDelivered.run(Date.now(), id);
}

function markWebhookAttemptFailed(id) {
  stmts.markWebhookAttemptFailed.run(id);
}

function getPendingWebhookRetries({ maxAttempts, sinceTs, limit }) {
  return stmts.getPendingWebhookRetries.all({ maxAttempts, sinceTs, limit });
}

function setBreachStart(key, startTs) {
  stmts.setBreachStart.run(key, startTs);
}

function deleteBreachStart(key) {
  stmts.deleteBreachStart.run(key);
}

function getAllBreaches() {
  return stmts.getAllBreaches.all();
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
  return stmts.getEvents.all(hostId, sinceTs, limit);
}

// Soft, like clearAlerts below: the row stays for countRestartsSince/getRestartCountsByContainer,
// which are the crash_loop rule and the List view's restartCount1h, and only getEvents filters it
// out. Distinct from pruneEvents above, which is the age-based retention sweep. See server/CLAUDE.md.
function clearEvents(hostId) {
  return stmts.clearEventsByHost.run(Date.now(), hostId).changes;
}

function getAuditLog(hostId, { limit = 200 } = {}) {
  return hostId ? stmts.getAuditLogByHost.all(hostId, limit) : stmts.getAuditLogAll.all(limit);
}

function getAlerts(hostId, { limit = 200 } = {}) {
  return hostId ? stmts.getAlertsByHost.all(hostId, limit) : stmts.getAlertsAll.all(limit);
}

// Soft, unlike deleteEvents: the row stays so lastAlertFire can still see it, and every other
// alerts query filters it out - clearing the tab must not re-arm alerts.js's cooldown and re-fire
// a still-breaching rule (with its webhook) on the next poll. See server/CLAUDE.md. hostId is required.
function clearAlerts(hostId) {
  return stmts.clearAlertsByHost.run(Date.now(), hostId).changes;
}

function countOpenAlerts(hostId) {
  return stmts.countOpenAlerts.get(hostId).n;
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

// Used by GET /healthz - a trivial round-trip through the actual sqlite connection, not just "is
// the process listening". Throws (not a boolean) on a wedged/erroring connection, e.g. WAL/shm
// lock contention - that's the failure mode a container healthcheck exists to catch.
function ping() {
  stmts.ping.get();
}

function getContainerMetricsHistory(hostId, containerId, sinceTs, bucketMs) {
  return withIoRates(stmts.containerMetricsHistory.all({ hostId, containerId, sinceTs, bucketMs }));
}

function getHostMetricsHistory(hostId, sinceTs, bucketMs) {
  return stmts.hostMetricsHistory.all({ hostId, sinceTs, bucketMs });
}

function rowToContainerAlertRule(row) {
  return {
    id: row.id,
    hostId: row.host_id,
    matchType: row.match_type,
    matchValue: row.match_value,
    cpuThreshold: row.cpu_threshold,
    memThreshold: row.mem_threshold,
    sustainMinutes: row.sustain_minutes,
    mutedRules: JSON.parse(row.muted_rules),
    sortOrder: row.sort_order,
  };
}

function getContainerAlertRules() {
  return stmts.getContainerAlertRules.all().map(rowToContainerAlertRule);
}

function insertContainerAlertRule(rule) {
  const maxOrder = stmts.getContainerAlertRuleMaxSortOrder.get().maxOrder;
  const info = stmts.insertContainerAlertRule.run({
    hostId: rule.hostId || null,
    matchType: rule.matchType,
    matchValue: rule.matchValue,
    cpuThreshold: rule.cpuThreshold ?? null,
    memThreshold: rule.memThreshold ?? null,
    sustainMinutes: rule.sustainMinutes ?? null,
    mutedRules: JSON.stringify(rule.mutedRules || []),
    sortOrder: maxOrder + 1,
  });
  return info.lastInsertRowid;
}

// Both return whether the row existed, so the routes can 404 rather than report success for an id
// another tab already deleted.
function updateContainerAlertRule(id, rule) {
  const info = stmts.updateContainerAlertRule.run({
    id,
    hostId: rule.hostId || null,
    matchType: rule.matchType,
    matchValue: rule.matchValue,
    cpuThreshold: rule.cpuThreshold ?? null,
    memThreshold: rule.memThreshold ?? null,
    sustainMinutes: rule.sustainMinutes ?? null,
    mutedRules: JSON.stringify(rule.mutedRules || []),
  });
  return info.changes > 0;
}

function deleteContainerAlertRule(id) {
  return stmts.deleteContainerAlertRule.run(id).changes > 0;
}

// Rewrites every row's sort_order to match orderedIds' position, in one transaction - a partial
// reorder would otherwise leave two rules sharing a sort_order mid-write, which briefly makes
// first-match-wins ambiguous for anything alerting concurrently.
const reorderContainerAlertRulesTx = db.transaction((orderedIds) => {
  orderedIds.forEach((id, index) => stmts.setContainerAlertRuleSortOrder.run(index, id));
});

function reorderContainerAlertRules(orderedIds) {
  reorderContainerAlertRulesTx(orderedIds);
}

function close() {
  db.close();
}

// Returns rows deleted per table so the caller can report what retention actually removed - this
// is the only path in the app that deletes anything, and it used to leave no trace at all.
function pruneOld({ metricsRetentionMs, eventsRetentionMs, auditRetentionMs }) {
  const now = Date.now();
  return timed('pruneOld', () => ({
    containerMetrics: stmts.pruneContainerMetrics.run(now - metricsRetentionMs).changes,
    hostMetrics: stmts.pruneHostMetrics.run(now - metricsRetentionMs).changes,
    events: stmts.pruneEvents.run(now - eventsRetentionMs).changes,
    auditLog: stmts.pruneAuditLog.run(now - auditRetentionMs).changes,
    alerts: stmts.pruneAlerts.run(now - auditRetentionMs).changes,
  }));
}

module.exports = {
  client: db,
  insertMetrics,
  insertHostMetric,
  insertEvent,
  insertAuditLog,
  updateAuditLogResult,
  insertAlert,
  ackAlert,
  getAlertHostId,
  ackAllAlerts,
  markWebhookDelivered,
  markWebhookAttemptFailed,
  getPendingWebhookRetries,
  setBreachStart,
  deleteBreachStart,
  getAllBreaches,
  getLastAlertFireTs,
  countRestartsSince,
  getRestartCountsByContainer,
  countManualStopsSince,
  countManualStartsSince,
  getEvents,
  clearEvents,
  getAuditLog,
  getAlerts,
  clearAlerts,
  countOpenAlerts,
  getOpenAlertCountsByContainer,
  getContainerMetricsHistory,
  getHostMetricsHistory,
  getSetting,
  setSetting,
  deleteSetting,
  ping,
  pruneOld,
  takeWriteStats,
  close,
  getContainerAlertRules,
  insertContainerAlertRule,
  updateContainerAlertRule,
  deleteContainerAlertRule,
  reorderContainerAlertRules,
};
