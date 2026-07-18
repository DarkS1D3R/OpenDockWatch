const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const alerts = require('../server/alerts');

// alerts.js holds a reference to the real db module, so mocking methods on
// that same (require-cached) object intercepts every db call it makes,
// without touching sqlite.
function mockDb(t, overrides = {}) {
  const defaults = {
    getLastAlertFireTs: () => null,
    insertAlert: () => 1,
    countManualStopsSince: () => 0,
    countManualStartsSince: () => 0,
    countRestartsSince: () => 0,
    getSetting: () => null,
  };
  for (const [name, impl] of Object.entries({ ...defaults, ...overrides })) {
    t.mock.method(db, name, impl);
  }
}

function captureFired(t, extraOverrides = {}) {
  const fired = [];
  mockDb(t, { insertAlert: (a) => (fired.push(a), 1), ...extraOverrides });
  return fired;
}

const THRESHOLD_SETTING_KEYS = {
  cpuThreshold: 'alertCpuThreshold',
  memThreshold: 'alertMemThreshold',
  sustainMinutes: 'alertSustainMinutes',
  diskThresholdGb: 'alertDiskThresholdGb',
};

// Builds a db.getSetting stand-in from the friendly field names used by
// getThresholdConfig, so tests can write { cpuThreshold: 90 } instead of the
// raw settings-table key.
function mockThresholdSettings(overrides = {}) {
  const map = {};
  for (const [field, value] of Object.entries(overrides)) {
    map[THRESHOLD_SETTING_KEYS[field]] = String(value);
  }
  return (key) => (key in map ? map[key] : null);
}

test('handleEvent: container_crashed', async (t) => {
  await t.test('fires when a container dies with a non-zero exit code', () => {
    const fired = captureFired(t);
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '1' } } },
    });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'container_crashed');
  });

  await t.test('does not fire on a clean exit (code 0)', () => {
    const fired = captureFired(t);
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '0' } } },
    });
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire when the container was manually stopped just before dying', () => {
    const fired = captureFired(t, { countManualStopsSince: () => 1 });
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '137' } } },
    });
    assert.equal(fired.length, 0);
  });

  await t.test('an unparsable exit code still fires, with a readable message instead of "code NaN"', () => {
    const fired = captureFired(t);
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: 'not-a-number' } } },
    });
    assert.equal(fired.length, 1);
    assert.doesNotMatch(fired[0].message, /NaN/);
    assert.match(fired[0].message, /unrecognized exit code/);
  });
});

test('handleEvent: crash_loop', async (t) => {
  await t.test('fires when the restart count reaches the threshold with no manual restarts', () => {
    const fired = captureFired(t, { countRestartsSince: () => 3, countManualStartsSince: () => 0 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'crash_loop');
  });

  await t.test('does not fire when the restarts were manually triggered', () => {
    const fired = captureFired(t, { countRestartsSince: () => 3, countManualStartsSince: () => 3 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire below the threshold', () => {
    const fired = captureFired(t, { countRestartsSince: () => 2, countManualStartsSince: () => 0 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 0);
  });

  await t.test('the message reports the auto-restart count that met the threshold, not the raw total', () => {
    const fired = captureFired(t, { countRestartsSince: () => 5, countManualStartsSince: () => 2 });
    alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'start', ts: Date.now(), raw: {} });
    assert.equal(fired.length, 1);
    assert.match(fired[0].message, /restarted 3 times/);
  });
});

test('handleEvent: unhealthy fires on a health_status: unhealthy event', (t) => {
  const fired = captureFired(t);
  alerts.handleEvent({ hostId: 'h', containerId: 'c', containerName: 'web', action: 'health_status: unhealthy', ts: Date.now(), raw: {} });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].rule, 'unhealthy');
});

test('handleHostReachability', async (t) => {
  await t.test('fires on a reachable -> unreachable transition', () => {
    const fired = captureFired(t);
    alerts.handleHostReachability('h', 'Host', false, true);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'host_unreachable');
  });

  await t.test('does not fire if the host was already unreachable', () => {
    const fired = captureFired(t);
    alerts.handleHostReachability('h', 'Host', false, false);
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire on an unreachable -> reachable transition', () => {
    const fired = captureFired(t);
    alerts.handleHostReachability('h', 'Host', true, false);
    assert.equal(fired.length, 0);
  });
});

test('cooldown: does not re-fire the same rule within the cooldown window', (t) => {
  const fired = captureFired(t, { getLastAlertFireTs: () => Date.now() - 1000 });
  alerts.handleEvent({
    hostId: 'h',
    containerId: 'c',
    containerName: 'web',
    action: 'die',
    ts: Date.now(),
    raw: { Actor: { Attributes: { exitCode: '1' } } },
  });
  assert.equal(fired.length, 0);
});

const sampleAlert = { hostId: 'h', containerId: 'c', containerName: 'web', severity: 'critical', message: 'boom' };

test('buildDelivery', async (t) => {
  await t.test('routes discord:// to the Discord webhook API with a content payload', () => {
    const d = alerts.buildDelivery('discord://123456789012345678/abcDEF_token-XYZ', sampleAlert);
    assert.equal(d.url, 'https://discord.com/api/webhooks/123456789012345678/abcDEF_token-XYZ');
    assert.equal(d.headers['Content-Type'], 'application/json');
    assert.match(JSON.parse(d.body).content, /boom/);
  });

  await t.test('routes ntfy:// to the given server/topic with a plain-text body', () => {
    const d = alerts.buildDelivery('ntfy://ntfy.sh/mytopic', sampleAlert);
    assert.equal(d.url, 'https://ntfy.sh/mytopic');
    assert.equal(d.body, 'boom');
    assert.equal(d.headers.Priority, 'urgent');
  });

  await t.test('ntfy priority reflects a non-critical severity', () => {
    const d = alerts.buildDelivery('ntfy://ntfy.sh/mytopic', { ...sampleAlert, severity: 'warning' });
    assert.equal(d.headers.Priority, 'default');
  });

  await t.test('routes ntfy:// to a self-hosted server', () => {
    const d = alerts.buildDelivery('ntfy://ntfy.example.com/mytopic', sampleAlert);
    assert.equal(d.url, 'https://ntfy.example.com/mytopic');
  });

  await t.test('routes gotify:// over http with a token query param', () => {
    const d = alerts.buildDelivery('gotify://gotify.example.com/mytoken', sampleAlert);
    assert.equal(d.url, 'http://gotify.example.com/message?token=mytoken');
    assert.equal(JSON.parse(d.body).priority, 8);
  });

  await t.test('routes gotifys:// over https', () => {
    const d = alerts.buildDelivery('gotifys://gotify.example.com/mytoken', sampleAlert);
    assert.equal(d.url, 'https://gotify.example.com/message?token=mytoken');
  });

  await t.test('auto-detects a real Slack incoming webhook by hostname', () => {
    const d = alerts.buildDelivery('https://hooks.slack.com/services/T000/B000/XXXX', sampleAlert);
    assert.equal(JSON.parse(d.body).text.includes('boom'), true);
  });

  await t.test('posts the raw alert as generic JSON for a plain https URL', () => {
    const d = alerts.buildDelivery('https://example.com/webhook', sampleAlert);
    assert.deepEqual(JSON.parse(d.body), sampleAlert);
  });

  await t.test('format "slack" overrides a non-hooks.slack.com URL', () => {
    const d = alerts.buildDelivery('https://mattermost.example.com/hooks/xyz', sampleAlert, 'slack');
    assert.equal(JSON.parse(d.body).text.includes('boom'), true);
  });
});

test('webhook config (DB override vs .env default)', async (t) => {
  await t.test('falls back to env vars when no DB override exists', (t) => {
    mockDb(t, { getSetting: () => null });
    const original = { url: process.env.ALERT_WEBHOOK_URL, format: process.env.ALERT_WEBHOOK_FORMAT };
    process.env.ALERT_WEBHOOK_URL = 'https://example.com/from-env';
    process.env.ALERT_WEBHOOK_FORMAT = 'slack';
    t.after(() => {
      if (original.url === undefined) delete process.env.ALERT_WEBHOOK_URL;
      else process.env.ALERT_WEBHOOK_URL = original.url;
      if (original.format === undefined) delete process.env.ALERT_WEBHOOK_FORMAT;
      else process.env.ALERT_WEBHOOK_FORMAT = original.format;
    });

    const config = alerts.getWebhookConfig();
    assert.deepEqual(config, { url: 'https://example.com/from-env', format: 'slack', overridden: false });
  });

  await t.test('a DB row - even an empty one - takes priority over .env', (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? '' : null) });
    process.env.ALERT_WEBHOOK_URL = 'https://example.com/from-env';
    t.after(() => delete process.env.ALERT_WEBHOOK_URL);

    const config = alerts.getWebhookConfig();
    assert.deepEqual(config, { url: '', format: '', overridden: true });
  });

  await t.test('setWebhookConfig persists both keys and clearWebhookConfig removes them', (t) => {
    const store = new Map();
    mockDb(t, {
      getSetting: (key) => (store.has(key) ? store.get(key) : null),
      setSetting: (key, value) => store.set(key, value),
      deleteSetting: (key) => store.delete(key),
    });

    const saved = alerts.setWebhookConfig({ url: 'discord://1/2', format: '' });
    assert.deepEqual(saved, { url: 'discord://1/2', format: '', overridden: true });

    const cleared = alerts.clearWebhookConfig();
    assert.equal(cleared.overridden, false);
  });
});

test('sendTestAlert', async (t) => {
  await t.test('throws when no webhook is configured', async (t) => {
    mockDb(t, { getSetting: () => null });
    await assert.rejects(() => alerts.sendTestAlert(), /no webhook URL configured/);
  });

  await t.test('delivers a synthetic alert through the configured webhook', async (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? 'discord://1/2' : null) });
    const originalFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true };
    };
    t.after(() => (global.fetch = originalFetch));

    await alerts.sendTestAlert();
    assert.equal(captured.url, 'https://discord.com/api/webhooks/1/2');
    assert.match(JSON.parse(captured.opts.body).content, /test alert/i);
  });

  await t.test('throws when the webhook responds with a non-2xx status', async (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? 'discord://1/2' : null) });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    t.after(() => (global.fetch = originalFetch));

    await assert.rejects(() => alerts.sendTestAlert(), /HTTP 500/);
  });
});

test('threshold config (DB override vs .env default)', async (t) => {
  await t.test('falls back to env vars / built-in defaults when no DB override exists', (t) => {
    mockDb(t, { getSetting: () => null });
    const original = process.env.ALERT_CPU_THRESHOLD;
    process.env.ALERT_CPU_THRESHOLD = '85';
    t.after(() => {
      if (original === undefined) delete process.env.ALERT_CPU_THRESHOLD;
      else process.env.ALERT_CPU_THRESHOLD = original;
    });

    const config = alerts.getThresholdConfig();
    assert.equal(config.cpuThreshold, 85);
    assert.equal(config.memThreshold, 0);
    assert.equal(config.sustainMinutes, 5);
    assert.equal(config.diskThresholdGb, 0);
    assert.equal(config.overridden, false);
  });

  await t.test('a DB row - even "0" - takes priority over .env', (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertCpuThreshold' ? '0' : null) });
    process.env.ALERT_CPU_THRESHOLD = '85';
    t.after(() => delete process.env.ALERT_CPU_THRESHOLD);

    const config = alerts.getThresholdConfig();
    assert.equal(config.cpuThreshold, 0);
    assert.equal(config.overridden, true);
  });

  await t.test('setThresholdConfig persists all four keys and clearThresholdConfig removes them', (t) => {
    const store = new Map();
    mockDb(t, {
      getSetting: (key) => (store.has(key) ? store.get(key) : null),
      setSetting: (key, value) => store.set(key, value),
      deleteSetting: (key) => store.delete(key),
    });

    const saved = alerts.setThresholdConfig({ cpuThreshold: 90, memThreshold: 90, sustainMinutes: 5, diskThresholdGb: 50 });
    assert.deepEqual(saved, { cpuThreshold: 90, memThreshold: 90, sustainMinutes: 5, diskThresholdGb: 50, overridden: true });

    const cleared = alerts.clearThresholdConfig();
    assert.equal(cleared.overridden, false);
  });
});

test('handleSample: container_cpu / container_mem', async (t) => {
  await t.test('does not fire on the first breaching sample, fires once sustained for the configured window', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }) });
    const start = Date.now();
    alerts.handleSample({ hostId: 'h', containerId: 'c-sustain-fire', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    assert.equal(fired.length, 0);
    alerts.handleSample({
      hostId: 'h',
      containerId: 'c-sustain-fire',
      containerName: 'web',
      cpuPerc: 95,
      memPerc: 10,
      ts: start + 5 * 60_000,
    });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'container_cpu');
  });

  await t.test('resets the sustain window on a dip below threshold', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }) });
    const start = Date.now();
    alerts.handleSample({ hostId: 'h', containerId: 'c-sustain-reset', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    alerts.handleSample({
      hostId: 'h',
      containerId: 'c-sustain-reset',
      containerName: 'web',
      cpuPerc: 50,
      memPerc: 10,
      ts: start + 60_000,
    });
    alerts.handleSample({
      hostId: 'h',
      containerId: 'c-sustain-reset',
      containerName: 'web',
      cpuPerc: 95,
      memPerc: 10,
      ts: start + 5 * 60_000 + 1,
    });
    // breach restarted at start+60_000, so only ~4 minutes sustained by the last sample
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire when the rule is disabled (threshold 0)', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 0 }) });
    alerts.handleSample({ hostId: 'h', containerId: 'c-disabled', containerName: 'web', cpuPerc: 100, memPerc: 100, ts: Date.now() });
    assert.equal(fired.length, 0);
  });

  await t.test('skips containers labeled opendockwatch.alerts=off', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 1, sustainMinutes: 0 }) });
    alerts.handleSample({
      hostId: 'h',
      containerId: 'c-alerts-off',
      containerName: 'web',
      cpuPerc: 100,
      memPerc: 100,
      ts: Date.now(),
      alertsDisabled: true,
    });
    assert.equal(fired.length, 0);
  });

  await t.test('fires container_mem independently of container_cpu', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ memThreshold: 80, sustainMinutes: 0 }) });
    alerts.handleSample({ hostId: 'h', containerId: 'c-mem-only', containerName: 'web', cpuPerc: 10, memPerc: 85, ts: Date.now() });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'container_mem');
  });
});

test('handleHostSample: host_cpu / host_mem', async (t) => {
  await t.test('fires host_cpu once sustained', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 0 }) });
    alerts.handleHostSample({ hostId: 'h-host-cpu', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: Date.now() });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'host_cpu');
  });

  await t.test('fires host_mem once sustained', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ memThreshold: 90, sustainMinutes: 0 }) });
    alerts.handleHostSample({ hostId: 'h-host-mem', hostName: 'Host', cpuPercent: 10, memPercent: 95, ts: Date.now() });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'host_mem');
  });

  await t.test('does not fire below threshold', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, memThreshold: 90, sustainMinutes: 0 }) });
    alerts.handleHostSample({ hostId: 'h-host-ok', hostName: 'Host', cpuPercent: 10, memPercent: 10, ts: Date.now() });
    assert.equal(fired.length, 0);
  });
});

test('handleDiskUsage', async (t) => {
  await t.test('fires when the summed Size across df rows exceeds the threshold', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ diskThresholdGb: 10 }) });
    alerts.handleDiskUsage({
      hostId: 'h',
      hostName: 'Host',
      rows: [{ size: '5GB' }, { size: '3GB' }, { size: '4GB' }],
      ts: Date.now(),
    });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, 'docker_disk');
  });

  await t.test('does not fire below the threshold', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ diskThresholdGb: 100 }) });
    alerts.handleDiskUsage({ hostId: 'h', hostName: 'Host', rows: [{ size: '5GB' }], ts: Date.now() });
    assert.equal(fired.length, 0);
  });

  await t.test('does not fire when disabled (threshold 0)', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ diskThresholdGb: 0 }) });
    alerts.handleDiskUsage({ hostId: 'h', hostName: 'Host', rows: [{ size: '999GB' }], ts: Date.now() });
    assert.equal(fired.length, 0);
  });
});
