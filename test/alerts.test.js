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
