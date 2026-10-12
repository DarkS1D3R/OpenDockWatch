// Wording for a container's imageUpdate verdict (server/imageUpdates.js), shared by the List badge,
// the detail panel and the Hosts tab. Pure, so it is unit-tested without a component.

import { formatDuration } from './duration.js';

const UNKNOWN_TEXT = {
  not_found: 'Not on its registry, or private - a local build looks like this',
  pinned: 'Pinned to a digest, so it never changes',
  no_tag: 'Runs an image by id, with no tag to check',
  no_local_digest: 'No registry digest is recorded for this image',
  rate_limited: 'Registry rate limit reached - the next check will try again',
  local_registry: "On a registry at localhost - that is the Docker host's own, which OpenDockWatch cannot reach",
};

// { text, tone } where tone is 'update' | 'ok' | 'muted', or null for a container never checked.
export function imageUpdateText(update) {
  if (!update) return null;
  if (update.status === 'outdated') return { text: 'Newer image available', tone: 'update' };
  if (update.status === 'current') return { text: 'Up to date', tone: 'ok' };
  return { text: UNKNOWN_TEXT[update.reason] || `Could not check: ${update.message || 'unknown error'}`, tone: 'muted' };
}

export function checkedAgo(update, now = Date.now()) {
  if (!update || !update.checkedAt) return null;
  const ms = Math.max(0, now - update.checkedAt);
  return ms < 60_000 ? 'checked just now' : `checked ${formatDuration(ms)} ago`;
}

// "sha256:2f8d5c2b6181" - enough to compare two by eye, without the full 71 characters.
export function shortDigest(digest) {
  return digest ? digest.slice(0, 19) : '';
}
