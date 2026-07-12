const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidHostId, isValidDockerHostUrl, hasLocalHost } = require('../server/hosts');

test('isValidHostId', async (t) => {
  await t.test('accepts letters, numbers, dashes, and underscores', () => {
    assert.equal(isValidHostId('prod'), true);
    assert.equal(isValidHostId('prod-2'), true);
    assert.equal(isValidHostId('prod_east_1'), true);
  });

  await t.test('rejects blank, missing, or non-string ids', () => {
    assert.equal(isValidHostId(''), false);
    assert.equal(isValidHostId(undefined), false);
    assert.equal(isValidHostId(null), false);
  });

  await t.test('rejects ids with spaces, slashes, or other punctuation', () => {
    assert.equal(isValidHostId('prod east'), false);
    assert.equal(isValidHostId('prod/east'), false);
    assert.equal(isValidHostId('prod.east'), false);
  });
});

test('isValidDockerHostUrl', async (t) => {
  await t.test('treats a blank value as valid (local socket)', () => {
    assert.equal(isValidDockerHostUrl(''), true);
    assert.equal(isValidDockerHostUrl(null), true);
    assert.equal(isValidDockerHostUrl(undefined), true);
  });

  await t.test('accepts a well-formed ssh:// URL', () => {
    assert.equal(isValidDockerHostUrl('ssh://deploy@prod.example.com'), true);
    assert.equal(isValidDockerHostUrl('ssh://deploy@prod.example.com:2222'), true);
  });

  await t.test('rejects non-ssh schemes', () => {
    assert.equal(isValidDockerHostUrl('http://prod.example.com'), false);
    assert.equal(isValidDockerHostUrl('tcp://prod.example.com:2375'), false);
  });

  await t.test('rejects malformed URLs', () => {
    assert.equal(isValidDockerHostUrl('not a url'), false);
    assert.equal(isValidDockerHostUrl('ssh//missing-colon'), false);
  });
});

test('hasLocalHost', async (t) => {
  await t.test('true when a host has no dockerHost set', () => {
    const hosts = [
      { id: 'local', dockerHost: null },
      { id: 'prod', dockerHost: 'ssh://deploy@prod' },
    ];
    assert.equal(hasLocalHost(hosts), true);
  });

  await t.test('false when every host is remote', () => {
    const hosts = [
      { id: 'prod', dockerHost: 'ssh://deploy@prod' },
      { id: 'staging', dockerHost: 'ssh://deploy@staging' },
    ];
    assert.equal(hasLocalHost(hosts), false);
  });

  await t.test('false on an empty list', () => {
    assert.equal(hasLocalHost([]), false);
  });

  await t.test('excludeId lets a host being edited ignore itself', () => {
    const hosts = [{ id: 'local', dockerHost: null }];
    assert.equal(hasLocalHost(hosts, 'local'), false);
    assert.equal(hasLocalHost(hosts, 'someone-else'), true);
  });
});
