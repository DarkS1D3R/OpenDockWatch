const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ES module under public/js/lib - imported dynamically, same as test/format.test.js explains.
let lib;
before(async () => {
  lib = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'containerRow.js')));
});

test('rowActions offers only what applies to the state', () => {
  assert.deepEqual(lib.rowActions('running'), ['stop', 'restart']);
  assert.deepEqual(lib.rowActions('paused'), ['stop', 'restart']);
  assert.deepEqual(lib.rowActions('restarting'), ['stop']);
  assert.deepEqual(lib.rowActions('exited'), ['start']);
  assert.deepEqual(lib.rowActions('created'), ['start']);
  assert.deepEqual(lib.rowActions('dead'), ['start']);
  assert.deepEqual(lib.rowActions('removing'), []);
});

test('groupActions offers each batch action at least one container would take', () => {
  const allUp = [{ state: 'running' }, { state: 'running' }];
  assert.deepEqual(lib.groupActions(allUp), ['stop', 'restart']);
  assert.deepEqual(lib.groupActions([{ state: 'exited' }, { state: 'created' }]), ['start']);
  assert.deepEqual(lib.groupActions([{ state: 'running' }, { state: 'exited' }]), ['start', 'stop', 'restart']);
  assert.deepEqual(lib.groupActions([]), []);
});

test('actionLabel names every action rowActions can return', () => {
  for (const a of ['start', 'stop', 'restart']) assert.ok(lib.actionLabel(a), a);
});

test('shortStatus abbreviates durations and drops the health suffix the dot already shows', () => {
  const cases = [
    ['Up 30 minutes (healthy)', 'Up 30m'],
    ['Up 30 minutes (unhealthy)', 'Up 30m'],
    ['Up 5 seconds (health: starting)', 'Up 5s'],
    ['Up About a minute', 'Up 1m'],
    ['Up About an hour (healthy)', 'Up 1h'],
    ['Up 2 days', 'Up 2d'],
    ['Up 3 weeks', 'Up 3w'],
    ['Up 4 months', 'Up 4mo'],
    ['Up Less than a second', 'Up <1s'],
    ['Up 2 minutes (Paused)', 'Up 2m (Paused)'],
    ['Exited (0) 30 minutes ago', 'Exited (0) 30m ago'],
    ['Exited (137) About an hour ago', 'Exited (137) 1h ago'],
    ['Restarting (1) 5 seconds ago', 'Restarting (1) 5s ago'],
    ['Created', 'Created'],
  ];
  for (const [input, expected] of cases) assert.equal(lib.shortStatus(input), expected, input);
  assert.equal(lib.shortStatus(null), '');
});

test('memoryCell hides the host total but keeps a real limit', () => {
  const host = 15.24 * 1024 ** 3;
  assert.equal(lib.memoryCell('516KiB / 15.24GiB', host), '516KiB');
  assert.equal(lib.memoryCell('634.5MiB / 1GiB', host), '634.5MiB / 1GiB');
  // Host memory not known yet: show docker's own text rather than guess.
  assert.equal(lib.memoryCell('516KiB / 15.24GiB', null), '516KiB / 15.24GiB');
  assert.equal(lib.memoryCell('516KiB / ??', host), '516KiB / ??');
  assert.equal(lib.memoryCell('', host), '');
  assert.equal(lib.memoryCell(undefined, host), '');
});

test('portsCell shows published ports only, deduped across IPv4/IPv6', () => {
  assert.equal(lib.portsCell('0.0.0.0:8089->80/tcp, :::8089->80/tcp'), '8089:80');
  assert.equal(lib.portsCell('0.0.0.0:8088->80/tcp, 0.0.0.0:8443->443/tcp, 9000/tcp'), '8088:80, 8443:443');
  assert.equal(lib.portsCell('6379/tcp'), '');
  assert.equal(lib.portsCell(''), '');
});
