const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const hosts = require('../server/hosts');
const logger = require('../server/logger');
const alerts = require('../server/alerts');

// Same reasoning as mockDb below: alerts.js calls hosts.loadHosts() through the module object
// (not a destructured reference), so mocking it here reaches loadBreachState without touching the
// real config/hosts.json.
function mockHosts(t, list) {
  t.mock.method(hosts, 'loadHosts', () => list);
}

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
    setBreachStart: () => {},
    deleteBreachStart: () => {},
    getAllBreaches: () => [],
    markWebhookDelivered: () => {},
    markWebhookAttemptFailed: () => {},
    getPendingWebhookRetries: () => [],
    getContainerAlertRules: () => [],
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

// fire() calls notify() without awaiting it (deliberately - see alerts.js) so these flush a tick
// after triggering it through the public handleEvent API, same as a real caller would observe the
// db write slightly after the synchronous part of firing returns.
async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

function fireDeathEvent(hostId = 'h') {
  alerts.handleEvent({
    hostId,
    containerId: 'c',
    containerName: 'web',
    action: 'die',
    ts: Date.now(),
    raw: { Actor: { Attributes: { exitCode: '1' } } },
  });
}

test('notify: records delivery outcome against the alert row', async (t) => {
  await t.test('marks the row delivered on a successful attempt', async (t) => {
    const delivered = [];
    mockDb(t, {
      getSetting: (key) => (key === 'alertWebhookUrl' ? 'discord://1/2' : null),
      insertAlert: () => 42,
      markWebhookDelivered: (id) => delivered.push(id),
    });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true });
    t.after(() => (global.fetch = originalFetch));

    fireDeathEvent('h-notify-ok');
    await flushMicrotasks();
    assert.deepEqual(delivered, [42]);
  });

  await t.test('records a failed attempt (rather than only logging it) so it can be retried later', async (t) => {
    const failed = [];
    mockDb(t, {
      getSetting: (key) => (key === 'alertWebhookUrl' ? 'discord://1/2' : null),
      insertAlert: () => 43,
      markWebhookAttemptFailed: (id) => failed.push(id),
    });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    t.after(() => (global.fetch = originalFetch));

    fireDeathEvent('h-notify-fail');
    await flushMicrotasks();
    assert.deepEqual(failed, [43]);
  });
});

test('retryFailedWebhooks', async (t) => {
  await t.test('does nothing when no webhook is currently configured', async (t) => {
    const calls = [];
    mockDb(t, { getSetting: () => null, getPendingWebhookRetries: () => (calls.push(1), []) });
    await alerts.retryFailedWebhooks();
    assert.equal(calls.length, 0);
  });

  await t.test('redelivers a pending row and marks it delivered on success', async (t) => {
    const delivered = [];
    mockDb(t, {
      getSetting: (key) => (key === 'alertWebhookUrl' ? 'discord://1/2' : null),
      getPendingWebhookRetries: () => [
        {
          id: 7,
          ts: Date.now(),
          host_id: 'h',
          container_id: 'c',
          container_name: 'web',
          rule: 'container_cpu',
          severity: 'warning',
          message: 'boom',
          webhook_attempts: 1,
        },
      ],
      markWebhookDelivered: (id) => delivered.push(id),
    });
    const originalFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true };
    };
    t.after(() => (global.fetch = originalFetch));

    await alerts.retryFailedWebhooks();
    assert.deepEqual(delivered, [7]);
    assert.equal(captured.url, 'https://discord.com/api/webhooks/1/2');
  });

  await t.test('a still-failing row is recorded as another failed attempt rather than throwing', async (t) => {
    const failed = [];
    mockDb(t, {
      getSetting: (key) => (key === 'alertWebhookUrl' ? 'discord://1/2' : null),
      getPendingWebhookRetries: () => [
        {
          id: 8,
          ts: Date.now(),
          host_id: 'h',
          container_id: 'c',
          container_name: 'web',
          rule: 'container_cpu',
          severity: 'warning',
          message: 'boom',
          webhook_attempts: 2,
        },
      ],
      markWebhookAttemptFailed: (id) => failed.push(id),
    });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    t.after(() => (global.fetch = originalFetch));

    await assert.doesNotReject(() => alerts.retryFailedWebhooks());
    assert.deepEqual(failed, [8]);
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

test('resolveContainerConfig', async (t) => {
  await t.test('no matching rule falls through to the global threshold config unchanged', () => {
    mockDb(t, { getSetting: mockThresholdSettings({ cpuThreshold: 50, memThreshold: 50, sustainMinutes: 5 }) });
    const cfg = alerts.resolveContainerConfig({ hostId: 'h', containerName: 'web-1', composeProject: null });
    assert.equal(cfg.cpuThreshold, 50);
    assert.equal(cfg.memThreshold, 50);
    assert.equal(cfg.sustainMinutes, 5);
    assert.deepEqual(cfg.mutedEventRules, new Set());
    assert.equal(cfg.matchedRuleId, null);
  });

  await t.test('a name-match rule (case-insensitive substring) overrides only the fields it sets', () => {
    mockDb(t, {
      getSetting: mockThresholdSettings({ cpuThreshold: 50, memThreshold: 50, sustainMinutes: 5 }),
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: null,
          matchType: 'name',
          matchValue: 'REDIS',
          cpuThreshold: 90,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: [],
        },
      ],
    });
    const cfg = alerts.resolveContainerConfig({ hostId: 'h', containerName: 'my-redis-1', composeProject: null });
    assert.equal(cfg.cpuThreshold, 90);
    assert.equal(cfg.memThreshold, 50);
    assert.equal(cfg.sustainMinutes, 5);
    assert.equal(cfg.matchedRuleId, 1);
  });

  await t.test('a composeProject rule matches exactly, not by substring', () => {
    mockDb(t, {
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: null,
          matchType: 'composeProject',
          matchValue: 'billing',
          cpuThreshold: 70,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: [],
        },
      ],
    });
    const noMatch = alerts.resolveContainerConfig({ hostId: 'h', containerName: 'x', composeProject: 'billing-old' });
    assert.equal(noMatch.matchedRuleId, null);
    const match = alerts.resolveContainerConfig({ hostId: 'h', containerName: 'x', composeProject: 'billing' });
    assert.equal(match.matchedRuleId, 1);
    assert.equal(match.cpuThreshold, 70);
  });

  await t.test('a host-scoped rule only applies on its own host', () => {
    mockDb(t, {
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: 'prod',
          matchType: 'name',
          matchValue: 'web',
          cpuThreshold: 99,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: [],
        },
      ],
    });
    const onProd = alerts.resolveContainerConfig({ hostId: 'prod', containerName: 'web-1', composeProject: null });
    assert.equal(onProd.matchedRuleId, 1);
    const elsewhere = alerts.resolveContainerConfig({ hostId: 'staging', containerName: 'web-1', composeProject: null });
    assert.equal(elsewhere.matchedRuleId, null);
  });

  await t.test('first match wins: an earlier rule is used in full even if a later rule would also match', () => {
    mockDb(t, {
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: null,
          matchType: 'name',
          matchValue: 'web',
          cpuThreshold: 10,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: [],
        },
        {
          id: 2,
          hostId: null,
          matchType: 'name',
          matchValue: 'web',
          cpuThreshold: 20,
          memThreshold: 20,
          sustainMinutes: null,
          mutedRules: [],
        },
      ],
    });
    const cfg = alerts.resolveContainerConfig({ hostId: 'h', containerName: 'web-1', composeProject: null });
    assert.equal(cfg.cpuThreshold, 10);
    assert.equal(cfg.memThreshold, 0);
    assert.equal(cfg.matchedRuleId, 1);
  });

  await t.test('the opendockwatch.alerts=off label short-circuits handleSample before any rule lookup', () => {
    const calls = [];
    const fired = captureFired(t, {
      getSetting: mockThresholdSettings({ cpuThreshold: 1, sustainMinutes: 0 }),
      getContainerAlertRules: () => (calls.push(1), []),
    });
    alerts.handleSample({
      hostId: 'h',
      containerId: 'c',
      containerName: 'web',
      cpuPerc: 100,
      memPerc: 100,
      ts: Date.now(),
      alertsDisabled: true,
    });
    assert.equal(fired.length, 0);
    assert.equal(calls.length, 0, 'getContainerAlertRules should not run when the label already disabled alerting');
  });

  await t.test('one alertContext serves a whole poll without re-reading the rules table per container', () => {
    let reads = 0;
    const fired = captureFired(t, {
      getSetting: mockThresholdSettings({ cpuThreshold: 50, sustainMinutes: 0 }),
      getContainerAlertRules: () => {
        reads++;
        return [
          {
            id: 1,
            hostId: null,
            matchType: 'name',
            matchValue: 'quiet',
            cpuThreshold: 99,
            memThreshold: null,
            sustainMinutes: null,
            mutedRules: [],
          },
        ];
      },
    });
    const ctx = alerts.alertContext();
    assert.equal(reads, 1);
    for (const name of ['quiet-a', 'quiet-b', 'loud-a']) {
      alerts.handleSample(
        { hostId: 'ctxhost', containerId: name, containerName: name, cpuPerc: 60, memPerc: 0, ts: Date.now(), alertsDisabled: false },
        ctx
      );
    }
    assert.equal(reads, 1, 'the rules table should be read once per poll, not once per container');
    // The shared context must not flatten per-container resolution: the two "quiet" containers
    // match the rule's 99% override and stay under it, the third falls back to the global 50%.
    assert.deepEqual(
      fired.map((a) => a.containerName),
      ['loud-a']
    );
  });
});

test('handleEvent: a matched rule can mute individual event rules', async (t) => {
  await t.test('mutes container_crashed for a matching container while an unmatched one still fires', () => {
    const fired = captureFired(t, {
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: null,
          matchType: 'name',
          matchValue: 'noisy',
          cpuThreshold: null,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: ['container_crashed'],
        },
      ],
    });
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c1',
      containerName: 'noisy-app',
      composeProject: null,
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '1' } } },
    });
    assert.equal(fired.length, 0);
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c2',
      containerName: 'other-app',
      composeProject: null,
      action: 'die',
      ts: Date.now(),
      raw: { Actor: { Attributes: { exitCode: '1' } } },
    });
    assert.equal(fired.length, 1);
  });

  await t.test('mutes crash_loop for a matching container', () => {
    const fired = captureFired(t, {
      countRestartsSince: () => 3,
      countManualStartsSince: () => 0,
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: null,
          matchType: 'name',
          matchValue: 'noisy',
          cpuThreshold: null,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: ['crash_loop'],
        },
      ],
    });
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c1',
      containerName: 'noisy-app',
      composeProject: null,
      action: 'start',
      ts: Date.now(),
      raw: {},
    });
    assert.equal(fired.length, 0);
  });

  await t.test('logs alert.muted so a suppressed alert still leaves a trace to explain itself', () => {
    const logged = [];
    t.mock.method(logger, 'info', (event, fields) => logged.push({ event, fields }));
    captureFired(t, {
      getContainerAlertRules: () => [
        {
          id: 7,
          hostId: null,
          matchType: 'name',
          matchValue: 'noisy',
          cpuThreshold: null,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: ['unhealthy'],
        },
      ],
    });
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c1',
      containerName: 'noisy-app',
      composeProject: null,
      action: 'health_status: unhealthy',
      ts: Date.now(),
      raw: {},
    });
    const muted = logged.filter((l) => l.event === 'alert.muted');
    assert.equal(muted.length, 1);
    assert.equal(muted[0].fields.rule, 'unhealthy');
    assert.equal(muted[0].fields.container, 'noisy-app');
    assert.equal(muted[0].fields.ruleId, 7);
  });

  await t.test('mutes unhealthy for a matching container', () => {
    const fired = captureFired(t, {
      getContainerAlertRules: () => [
        {
          id: 1,
          hostId: null,
          matchType: 'name',
          matchValue: 'noisy',
          cpuThreshold: null,
          memThreshold: null,
          sustainMinutes: null,
          mutedRules: ['unhealthy'],
        },
      ],
    });
    alerts.handleEvent({
      hostId: 'h',
      containerId: 'c1',
      containerName: 'noisy-app',
      composeProject: null,
      action: 'health_status: unhealthy',
      ts: Date.now(),
      raw: {},
    });
    assert.equal(fired.length, 0);
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

// The breach counters are module-private, so these assert on the observable consequence of an
// entry surviving or not: a retained counter means the sustain window kept accumulating from the
// first breaching sample, a dropped one means the next breach starts its window over.
test('retainContainers / forgetHost: breach counter cleanup', async (t) => {
  await t.test('keeps the sustain window for a container that is still listed', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }) });
    const start = Date.now();
    alerts.handleSample({ hostId: 'h', containerId: 'c-kept', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    alerts.retainContainers('h', ['c-kept', 'c-other']);
    alerts.handleSample({ hostId: 'h', containerId: 'c-kept', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start + 5 * 60_000 });
    assert.equal(fired.length, 1);
  });

  await t.test('drops the counter for a container that is no longer listed', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }) });
    const start = Date.now();
    alerts.handleSample({ hostId: 'h', containerId: 'c-gone', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    alerts.retainContainers('h', ['c-other']);
    // Same id reappearing (a recreated container reusing it) starts a fresh window rather than
    // inheriting the old one, so this second breach is not yet sustained.
    alerts.handleSample({ hostId: 'h', containerId: 'c-gone', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start + 5 * 60_000 });
    assert.equal(fired.length, 0);
  });

  await t.test('leaves host-level counters alone', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }) });
    const start = Date.now();
    alerts.handleHostSample({ hostId: 'h-retain', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: start });
    alerts.retainContainers('h-retain', []);
    alerts.handleHostSample({ hostId: 'h-retain', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: start + 5 * 60_000 });
    assert.equal(fired.length, 1);
  });

  await t.test('forgetHost drops container and host counters for that host only', () => {
    const fired = captureFired(t, { getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }) });
    const start = Date.now();
    alerts.handleSample({ hostId: 'h-forget', containerId: 'c1', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    alerts.handleHostSample({ hostId: 'h-forget', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: start });
    alerts.handleSample({ hostId: 'h-stays', containerId: 'c2', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    alerts.forgetHost('h-forget');

    alerts.handleSample({ hostId: 'h-forget', containerId: 'c1', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start + 5 * 60_000 });
    alerts.handleHostSample({ hostId: 'h-forget', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: start + 5 * 60_000 });
    assert.equal(fired.length, 0);

    alerts.handleSample({ hostId: 'h-stays', containerId: 'c2', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start + 5 * 60_000 });
    assert.equal(fired.length, 1);
  });
});

test('breach persistence: checkSustained mirrors start/clear into db', (t) => {
  const setCalls = [];
  const deleteCalls = [];
  const fired = captureFired(t, {
    getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }),
    setBreachStart: (key, startTs) => setCalls.push({ key, startTs }),
    deleteBreachStart: (key) => deleteCalls.push(key),
  });
  const start = Date.now();
  alerts.handleSample({ hostId: 'h', containerId: 'c-persist', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
  assert.deepEqual(setCalls, [{ key: 'h:c-persist:container_cpu', startTs: start }]);

  // Still breaching on the next sample - the start is already recorded, no second db write.
  alerts.handleSample({ hostId: 'h', containerId: 'c-persist', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start + 60_000 });
  assert.equal(setCalls.length, 1);

  // Dips below threshold before the sustain window elapses - the persisted start is cleared.
  alerts.handleSample({ hostId: 'h', containerId: 'c-persist', containerName: 'web', cpuPerc: 10, memPerc: 10, ts: start + 120_000 });
  assert.deepEqual(deleteCalls, ['h:c-persist:container_cpu']);
  assert.equal(fired.length, 0);
});

// Before breaches were persisted, a rule switched off mid-breach just left its in-memory counter
// orphaned until the next restart quietly wiped it. Now that the counter survives restarts (see
// loadBreachState), disabling the rule has to actually clear its own row - not just stop firing -
// or that row leaks forever instead of self-healing the way it used to.
test('breach persistence: disabling a rule mid-breach clears its own row rather than leaking it', async (t) => {
  await t.test('container-level rule', () => {
    const deleteCalls = [];
    let cpuThreshold = 90;
    const fired = captureFired(t, {
      getSetting: (key) => (key === 'alertCpuThreshold' ? String(cpuThreshold) : null),
      deleteBreachStart: (key) => deleteCalls.push(key),
    });
    const start = Date.now();
    alerts.handleSample({ hostId: 'h', containerId: 'c-disabled-midbreach', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: start });
    assert.equal(deleteCalls.length, 0);

    // Disabled from Settings while cpuPerc is still over the old threshold - the row only clears
    // because "breached" now folds the enabled check in, not because the value dipped.
    cpuThreshold = 0;
    alerts.handleSample({
      hostId: 'h',
      containerId: 'c-disabled-midbreach',
      containerName: 'web',
      cpuPerc: 95,
      memPerc: 10,
      ts: start + 60_000,
    });
    assert.deepEqual(deleteCalls, ['h:c-disabled-midbreach:container_cpu']);
    assert.equal(fired.length, 0);
  });

  await t.test('host-level rule', () => {
    const deleteCalls = [];
    let cpuThreshold = 90;
    const fired = captureFired(t, {
      getSetting: (key) => (key === 'alertCpuThreshold' ? String(cpuThreshold) : null),
      deleteBreachStart: (key) => deleteCalls.push(key),
    });
    const start = Date.now();
    alerts.handleHostSample({ hostId: 'h-disabled-midbreach', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: start });
    assert.equal(deleteCalls.length, 0);

    cpuThreshold = 0;
    alerts.handleHostSample({ hostId: 'h-disabled-midbreach', hostName: 'Host', cpuPercent: 95, memPercent: 10, ts: start + 60_000 });
    assert.deepEqual(deleteCalls, ['h-disabled-midbreach:host:host_cpu']);
    assert.equal(fired.length, 0);
  });
});

test('loadBreachState', async (t) => {
  await t.test('a breach persisted from before a restart resumes counting instead of starting over', () => {
    // Already past the 5-minute sustain window as of "now" - if loadBreachState didn't restore
    // this, the very next sample would look like a brand-new breach and not fire.
    const start = Date.now() - 5 * 60_000;
    mockHosts(t, [{ id: 'h' }]);
    const fired = captureFired(t, {
      getSetting: mockThresholdSettings({ cpuThreshold: 90, sustainMinutes: 5 }),
      getAllBreaches: () => [{ key: 'h:c-resumed:container_cpu', startTs: start }],
    });
    alerts.loadBreachState();
    alerts.handleSample({ hostId: 'h', containerId: 'c-resumed', containerName: 'web', cpuPerc: 95, memPerc: 10, ts: Date.now() });
    assert.equal(fired.length, 1);
  });

  await t.test('drops a persisted breach for a host no longer in config/hosts.json', () => {
    const deleteCalls = [];
    mockHosts(t, []); // 'h-removed' isn't in this list - it was deleted from Settings while the process was down
    mockDb(t, {
      getAllBreaches: () => [{ key: 'h-removed:c:container_cpu', startTs: Date.now() - 60_000 }],
      deleteBreachStart: (key) => deleteCalls.push(key),
    });
    alerts.loadBreachState();
    assert.deepEqual(deleteCalls, ['h-removed:c:container_cpu']);
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

// A webhook URL *is* the credential - a Discord/Gotify token or an ntfy topic sits in its path, so
// anyone who can read `docker logs` can post as the alerting integration. webhookScheme() is the
// only sanctioned way to put one in a line; this proves no other path prints it. See server/CLAUDE.md.
const WEBHOOK_SECRET = 'zzleakcanaryzz';
const SECRET_URLS = {
  discord: `discord://123456789/${WEBHOOK_SECRET}`,
  ntfy: `ntfy://ntfy.sh/${WEBHOOK_SECRET}`,
  gotify: `gotify://gotify.example.com/${WEBHOOK_SECRET}`,
  slack: `https://hooks.slack.com/services/T00/B00/${WEBHOOK_SECRET}`,
};

// Every level, not just the one a given path uses: the whole point is to catch a line added later
// on a path nobody thought about, and a new line is as likely to be error as info.
function captureLogger(t) {
  const lines = [];
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(logger, level, (event, fields) => lines.push({ level, event, fields }));
  }
  return lines;
}

function assertNoLeak(lines, label) {
  const leaked = lines.filter((l) => JSON.stringify(l).includes(WEBHOOK_SECRET));
  assert.deepEqual(leaked, [], `${label} put the webhook credential in the log: ${JSON.stringify(leaked)}`);
  assert.ok(lines.length > 0, `${label} logged nothing at all - this assertion proved nothing`);
}

function stubFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => (global.fetch = original));
}

function pendingRow(overrides = {}) {
  return {
    id: 9,
    ts: Date.now(),
    host_id: 'h',
    container_id: 'c',
    container_name: 'web',
    rule: 'container_cpu',
    severity: 'warning',
    message: 'boom',
    webhook_attempts: 1,
    ...overrides,
  };
}

function unhealthyEvent() {
  return {
    hostId: 'h',
    containerId: 'c1',
    containerName: 'web',
    composeProject: null,
    action: 'health_status: unhealthy',
    ts: Date.now(),
    raw: {},
  };
}

test('the webhook URL never reaches a log line', async (t) => {
  await t.test('webhookScheme redacts every scheme buildDelivery accepts', () => {
    for (const [name, url] of Object.entries(SECRET_URLS)) {
      const scheme = alerts.webhookScheme(url);
      assert.ok(!scheme.includes(WEBHOOK_SECRET), `webhookScheme leaked the ${name} credential: ${scheme}`);
      assert.match(scheme, /^[a-z]+:\/\/…$/, `webhookScheme returned something other than a bare scheme for ${name}: ${scheme}`);
    }
  });

  await t.test('a delivered alert logs the scheme, not the URL', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.discord : null) });
    stubFetch(t, async () => ({ ok: true }));

    alerts.handleEvent(unhealthyEvent());
    await flushMicrotasks();
    assertNoLeak(lines, 'a successful notify()');
    assert.ok(
      lines.some((l) => l.event === 'alert.webhook.delivered' && l.fields.via === 'discord://…'),
      'the delivered line lost its redacted `via` field'
    );
  });

  await t.test('a failed delivery logs the error, not the URL', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.slack : null) });
    stubFetch(t, async () => ({ ok: false, status: 500 }));

    alerts.handleEvent(unhealthyEvent());
    await flushMicrotasks();
    assertNoLeak(lines, 'a failed notify()');
    assert.ok(
      lines.some((l) => l.event === 'alert.webhook.failed'),
      'the failure path stopped logging'
    );
  });

  // The timeout branch builds its own message rather than passing the fetch error through, which is
  // the branch most likely to reach for the URL to say *what* timed out.
  await t.test('a timed-out delivery logs the error, not the URL', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.ntfy : null) });
    stubFetch(t, async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    alerts.handleEvent(unhealthyEvent());
    await flushMicrotasks();
    assertNoLeak(lines, 'a timed-out notify()');
  });

  await t.test('the retry sweep logs neither the URL it retries against nor the backlog depth with it', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, {
      getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.gotify : null),
      getPendingWebhookRetries: () => [pendingRow()],
    });
    stubFetch(t, async () => ({ ok: true }));

    await alerts.retryFailedWebhooks();
    assertNoLeak(lines, 'a successful retry sweep');
    assert.ok(
      lines.some((l) => l.event === 'alert.webhook.retry_delivered'),
      'the retry sweep stopped logging deliveries'
    );
    assert.ok(
      lines.some((l) => l.event === 'alert.webhook.backlog'),
      'the backlog line went missing'
    );
  });

  await t.test('a still-failing retry logs the attempt, not the URL', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, {
      getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.discord : null),
      getPendingWebhookRetries: () => [pendingRow({ webhook_attempts: 3 })],
    });
    stubFetch(t, async () => ({ ok: false, status: 502 }));

    await alerts.retryFailedWebhooks();
    assertNoLeak(lines, 'a failed retry sweep');
    assert.ok(
      lines.some((l) => l.event === 'alert.webhook.retry_failed'),
      'the retry failure path stopped logging'
    );
  });

  // sendTestAlert throws rather than logging, and index.js hands that message to the admin's
  // browser - so the message itself is the surface here, not a log line.
  await t.test('the test-alert failure message carries no credential', async (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.slack : null) });
    stubFetch(t, async () => ({ ok: false, status: 500 }));

    await assert.rejects(
      () => alerts.sendTestAlert(),
      (err) => !err.message.includes(WEBHOOK_SECRET),
      'sendTestAlert put the webhook credential in the error it hands back to the caller'
    );
  });

  // The messages below are the ones a runtime that words its fetch errors differently would hand
  // back. undici says "fetch failed" today, so none of this is reachable on Node 22 - which is the
  // point: the guarantee must not rest on a message format nobody promised.
  await t.test('a runtime error naming the constructed URL is redacted before it is logged', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.discord : null) });
    stubFetch(t, async (url) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    });

    alerts.handleEvent(unhealthyEvent());
    await flushMicrotasks();
    assertNoLeak(lines, 'a fetch error naming the delivery URL');
    const failed = lines.find((l) => l.event === 'alert.webhook.failed');
    assert.equal(failed.fields.error, 'Failed to parse URL from https://…');
  });

  await t.test('a runtime error naming the raw URL is redacted before it is logged', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.discord : null) });
    stubFetch(t, async () => {
      throw new TypeError(`connect ECONNREFUSED for ${SECRET_URLS.discord}`);
    });

    alerts.handleEvent(unhealthyEvent());
    await flushMicrotasks();
    assertNoLeak(lines, 'a fetch error naming the configured URL');
    assert.match(lines.find((l) => l.event === 'alert.webhook.failed').fields.error, /discord:\/\/…$/);
  });

  // The narrower case the full-URL swap alone would miss: a message carrying only the credential
  // path, with no scheme or host in front of it to match on.
  await t.test('a runtime error naming only the credential path is redacted', async (t) => {
    const lines = captureLogger(t);
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.slack : null) });
    stubFetch(t, async () => {
      throw new Error(`404 Not Found: /services/T00/B00/${WEBHOOK_SECRET}`);
    });

    alerts.handleEvent(unhealthyEvent());
    await flushMicrotasks();
    assertNoLeak(lines, 'a fetch error naming the credential path');
    assert.equal(lines.find((l) => l.event === 'alert.webhook.failed').fields.error, '404 Not Found: /…');
  });

  // index.js answers Settings' "Test webhook" with this message, so it reaches a browser rather
  // than a log - the same credential, a different surface.
  await t.test('sendTestAlert redacts before handing the message back to the caller', async (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.gotify : null) });
    stubFetch(t, async (url) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    });

    await assert.rejects(
      () => alerts.sendTestAlert(),
      (err) => !err.message.includes(WEBHOOK_SECRET) && /Failed to parse URL/.test(err.message),
      'the test-alert error kept the credential on its way to the browser'
    );
  });

  await t.test('an error with nothing to redact is passed through whole, name and stack included', async (t) => {
    mockDb(t, { getSetting: (key) => (key === 'alertWebhookUrl' ? SECRET_URLS.discord : null) });
    const thrown = new TypeError('fetch failed');
    stubFetch(t, async () => {
      throw thrown;
    });

    await assert.rejects(
      () => alerts.sendTestAlert(),
      (err) => err === thrown,
      'a message with no credential in it was re-wrapped, trading the original name and stack for nothing'
    );
  });
});
