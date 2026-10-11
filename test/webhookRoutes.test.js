const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let wr;
before(async () => {
  wr = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'webhookRoutes.js')));
});

test('maskWebhookUrl keeps the scheme and host and hides the path, where the token lives', () => {
  assert.equal(wr.maskWebhookUrl('discord://123456/s3cr3t-token'), 'discord://123456/…');
  assert.equal(wr.maskWebhookUrl('ntfy://ntfy.sh/private-topic'), 'ntfy://ntfy.sh/…');
  assert.equal(wr.maskWebhookUrl('https://hooks.slack.com/services/T0/B0/XYZ'), 'https://hooks.slack.com/…');
  assert.equal(wr.maskWebhookUrl('not a url'), '(invalid URL)');
});

test('routeSummary says what a route takes', () => {
  const hosts = [{ id: 'edge', name: 'Edge box' }];
  const base = { hostId: null, rules: [], minSeverity: 'warning' };
  assert.equal(wr.routeSummary(base, hosts), 'every rule on any host');
  assert.equal(
    wr.routeSummary({ ...base, hostId: 'edge', rules: ['host_unreachable', 'oom_killed'], minSeverity: 'critical' }, hosts),
    'Host unreachable, OOM kill on Edge box, critical only'
  );
  assert.equal(wr.routeSummary({ ...base, hostId: 'gone' }, hosts), 'every rule on gone', 'a host removed since still names something');
});

test('routeDraft copies, so editing the form never edits the listed route', () => {
  const route = {
    id: 3,
    name: 'r',
    url: 'https://example.com',
    format: '',
    hostId: null,
    rules: ['host_cpu'],
    minSeverity: 'warning',
    notifyRecovery: true,
    enabled: true,
  };
  const draft = wr.routeDraft(route);
  assert.equal(draft.hostId, '', 'null would leave the "Any host" option unselected');
  draft.rules.push('host_mem');
  assert.deepEqual(route.rules, ['host_cpu']);
});
