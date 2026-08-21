const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const docker = require('../server/docker');
const { HISTORY_RANGES } = require('../server/historyRanges');

// Two tables forked between server (CommonJS) and public/js/** (native ES modules, no build step
// to share a single file across that boundary) - each pair kept identical here instead of by hand,
// the same "written down and enforced" pattern as test/logger.test.js's no-console scan or
// test/db.test.js's cleared_at filter check.
test('byte-unit table stays identical between server and client', async () => {
  const format = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'format.js')));
  assert.deepEqual(docker.BYTE_UNIT_MULT, format.MEM_UNIT_BYTES);
});

test('history range slots stay derived from HISTORY_RANGES', async () => {
  const { HISTORY_RANGE_SLOTS } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'constants.js')));
  assert.deepEqual(Object.keys(HISTORY_RANGE_SLOTS).sort(), Object.keys(HISTORY_RANGES).sort());
  for (const [key, slots] of Object.entries(HISTORY_RANGE_SLOTS)) {
    const { sinceMs, bucketMs } = HISTORY_RANGES[key];
    assert.equal(slots, sinceMs / bucketMs, `${key}: HISTORY_RANGE_SLOTS should be sinceMs/bucketMs`);
  }
});
