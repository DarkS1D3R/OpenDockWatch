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

  // This value ends up as a positional argv entry for the system `ssh` the docker CLI shells out
  // to, so a leading dash is read as an option (-oProxyCommand=...) rather than a host to connect
  // to. Admin-only route, but that's a privilege boundary worth keeping, not one worth spending.
  await t.test('rejects a host or user starting with a dash (ssh argv injection)', () => {
    assert.equal(isValidDockerHostUrl('ssh://-oProxyCommand=touch+pwned'), false);
    assert.equal(isValidDockerHostUrl('ssh://user@-oProxyCommand=touch+pwned'), false);
    assert.equal(isValidDockerHostUrl('ssh://-oProxyCommand=x@prod.example.com'), false);
  });

  await t.test('rejects an ssh URL with no host at all', () => {
    assert.equal(isValidDockerHostUrl('ssh://'), false);
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
