// Its own module, not a const inside index.js, so test/sharedConstants.test.js can require it
// without index.js's whole app bootstrap. Mirrored by constants.js's HISTORY_RANGE_SLOTS on the
// client side (CJS/ESM can't share a module) - see server/CLAUDE.md.
const HISTORY_RANGES = {
  '1h': { sinceMs: 3_600_000, bucketMs: 15_000 },
  '24h': { sinceMs: 86_400_000, bucketMs: 5 * 60_000 },
  '7d': { sinceMs: 7 * 86_400_000, bucketMs: 30 * 60_000 },
};

module.exports = { HISTORY_RANGES };
