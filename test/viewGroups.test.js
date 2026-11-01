const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { VALID_VIEWS } = require('../server/views');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let lib;
before(async () => {
  lib = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'viewGroups.js')));
});

test('every valid view sits under exactly one tab, and no tab names an unknown view', () => {
  const grouped = lib.VIEW_GROUPS.flatMap((g) => g.views.map((v) => v.id));
  assert.deepEqual([...grouped].sort(), [...VALID_VIEWS].sort());
  assert.equal(new Set(grouped).size, grouped.length, 'a view is listed under two tabs');
});

test('the state filter only applies to views that exist', () => {
  for (const v of lib.STATE_FILTER_VIEWS) assert.ok(VALID_VIEWS.has(v), v);
});

test('groupOf finds the tab a view belongs to', () => {
  assert.equal(lib.groupOf('flow').id, 'containers');
  assert.equal(lib.groupOf('uptime').id, 'activity');
  assert.equal(lib.groupOf('resources').id, 'hosts');
  assert.equal(lib.groupOf('nope'), null);
});

test('viewForGroup returns to the last view used in the tab, else its first', () => {
  assert.equal(lib.viewForGroup('containers'), 'list');
  assert.equal(lib.viewForGroup('containers', { containers: 'flow' }), 'flow');
  // A remembered view from another tab, or one that no longer exists, is ignored.
  assert.equal(lib.viewForGroup('containers', { containers: 'uptime' }), 'list');
  assert.equal(lib.viewForGroup('hosts', { containers: 'flow' }), 'overview');
  assert.equal(lib.viewForGroup('nope'), null);
});

test('viewLabel names a view by its tab', () => {
  assert.equal(lib.viewLabel('flow'), 'Containers › Flow');
  assert.equal(lib.viewLabel('overview'), 'Hosts › All hosts');
  assert.equal(lib.viewLabel('logs'), 'Logs');
});
