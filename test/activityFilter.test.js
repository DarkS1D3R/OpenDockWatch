const test = require('node:test');
const assert = require('node:assert/strict');

// ES module, so dynamic import - same pattern as the other public/js/lib tests.
let filterAlerts, filterEvents;
test.before(async () => {
  ({ filterAlerts, filterEvents } = await import('../public/js/lib/activityFilter.js'));
});

const alerts = [
  { id: 1, rule: 'container_cpu', message: 'cpu above 90%', containerName: 'web' },
  { id: 2, rule: 'container_mem', message: 'mem above 90%', containerName: 'db' },
  { id: 3, rule: 'container_cpu', message: 'cpu above 90%', containerName: 'worker' },
  { id: 4, rule: 'crash_loop', message: 'restarted 3 times, container_cpu is fine', containerName: 'web' },
];

const events = [
  { id: 1, action: 'start', containerName: 'web' },
  { id: 2, action: 'restart', containerName: 'web' },
  { id: 3, action: 'restart', containerName: 'db' },
  { id: 4, action: 'die', containerId: 'abc123' },
];

const keys = (rows) => rows.map((r) => r.id);

test('filterAlerts', async (t) => {
  await t.test('no filters passes the list through untouched', () => {
    const { searched, shown } = filterAlerts(alerts);
    assert.equal(searched, alerts, 'an unfiltered list should not be copied');
    assert.equal(shown, alerts);
  });

  await t.test('search matches rule, message or container name, case-insensitively', () => {
    assert.deepEqual(keys(filterAlerts(alerts, { search: 'WEB' }).shown), [1, 4]);
    assert.deepEqual(keys(filterAlerts(alerts, { search: 'mem above' }).shown), [2]);
    assert.deepEqual(keys(filterAlerts(alerts, { search: '  crash  ' }).shown), [4], 'search should be trimmed');
  });

  // The reason this is its own field rather than text typed into the search box: as a substring
  // search, "container_cpu" also pulled in alert 4, whose *message* happens to mention it.
  await t.test('the rule filter is an exact match on the rule, not a substring anywhere', () => {
    assert.deepEqual(keys(filterAlerts(alerts, { rule: 'container_cpu' }).shown), [1, 3]);
    assert.deepEqual(keys(filterAlerts(alerts, { search: 'container_cpu' }).shown), [1, 3, 4], 'the search box still matches substrings');
  });

  await t.test('both filters apply together', () => {
    assert.deepEqual(keys(filterAlerts(alerts, { search: 'web', rule: 'container_cpu' }).shown), [1]);
    assert.deepEqual(keys(filterAlerts(alerts, { search: 'db', rule: 'container_cpu' }).shown), []);
  });

  // What keeps every badge on screen while one of them is active - the badges are counted off
  // `searched`, so clicking one must not remove the others from the row you clicked it in.
  await t.test('searched ignores the rule filter, so the other rules are still represented', () => {
    const { searched, shown } = filterAlerts(alerts, { rule: 'crash_loop' });
    assert.deepEqual(keys(searched), [1, 2, 3, 4]);
    assert.deepEqual(keys(shown), [4]);
  });

  await t.test('an unknown rule matches nothing rather than everything', () => {
    assert.deepEqual(keys(filterAlerts(alerts, { rule: 'container_c' }).shown), []);
  });
});

test('filterEvents', async (t) => {
  // The exact case: "start" as a substring also matches "restart", so the badge said 1 and the
  // list showed 3.
  await t.test('the action filter separates start from restart', () => {
    assert.deepEqual(keys(filterEvents(events, { action: 'start' }).shown), [1]);
    assert.deepEqual(keys(filterEvents(events, { search: 'start' }).shown), [1, 2, 3], 'the search box still matches substrings');
  });

  await t.test('search falls back to the container id when there is no name', () => {
    assert.deepEqual(keys(filterEvents(events, { search: 'abc' }).shown), [4]);
    assert.deepEqual(keys(filterEvents(events, { search: 'web' }).shown), [1, 2]);
  });

  await t.test('both filters apply together, and searched ignores the action filter', () => {
    const { searched, shown } = filterEvents(events, { search: 'web', action: 'restart' });
    assert.deepEqual(keys(searched), [1, 2]);
    assert.deepEqual(keys(shown), [2]);
  });

  await t.test('missing fields do not throw', () => {
    const sparse = [{ id: 9 }];
    assert.deepEqual(keys(filterEvents(sparse, { search: 'x' }).shown), []);
    assert.deepEqual(keys(filterAlerts([{ id: 9 }], { search: 'x' }).shown), []);
  });
});
