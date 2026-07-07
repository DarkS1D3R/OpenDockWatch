const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEventLine } = require('../server/eventWatcher');

const host = { id: 'local' };

test('parseEventLine', async (t) => {
  await t.test('parses a container start event', () => {
    const raw = {
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'abcdef0123456789', Attributes: { name: 'web' } },
      time: 1700000000,
    };
    assert.deepEqual(parseEventLine(JSON.stringify(raw), host), {
      hostId: 'local',
      containerId: 'abcdef012345',
      containerName: 'web',
      action: 'start',
      ts: 1700000000 * 1000,
      raw,
    });
  });

  await t.test('ignores non-container events', () => {
    const raw = { Type: 'network', Action: 'connect' };
    assert.equal(parseEventLine(JSON.stringify(raw), host), null);
  });

  await t.test('filters out exec_* actions (healthcheck noise)', () => {
    const raw = { Type: 'container', Action: 'exec_create', Actor: { ID: 'a', Attributes: {} } };
    assert.equal(parseEventLine(JSON.stringify(raw), host), null);
  });

  await t.test('does not filter health_status actions', () => {
    const raw = { Type: 'container', Action: 'health_status: unhealthy', Actor: { ID: 'a', Attributes: {} } };
    assert.ok(parseEventLine(JSON.stringify(raw), host));
  });

  await t.test('returns null for invalid JSON', () => {
    assert.equal(parseEventLine('not json', host), null);
  });

  await t.test('falls back to Date.now() when the event has no time field', () => {
    const before = Date.now();
    const raw = { Type: 'container', Action: 'start', Actor: { ID: 'a', Attributes: {} } };
    const result = parseEventLine(JSON.stringify(raw), host);
    assert.ok(result.ts >= before);
  });
});
