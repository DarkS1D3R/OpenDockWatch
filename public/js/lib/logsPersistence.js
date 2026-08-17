import { MAX_OPEN_LOG_PANES } from '../constants.js';

// Which containers the Logs tab had open, per host, so leaving the tab stops losing the selection.
// The streams are deliberately not preserved, only the choice. sessionStorage rather than the
// localStorage graph/persistence.js uses next door, and nothing server-side - see CLAUDE.md.
const KEY_PREFIX = 'odw:logs:panes:';

const VIEW_MODES = new Set(['single', 'multi']);

// Validated on the way out, not merely parsed: hand-editable storage decides which log streams get
// opened here, so anything malformed degrades to "nothing open" rather than reaching the component.
// Same discipline as server/index.js validating a stored defaultView on read. Exported for tests.
export function normalizeOpenPanes(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const viewMode = VIEW_MODES.has(raw.viewMode) ? raw.viewMode : 'multi';
  const ids = Array.isArray(raw.openIds) ? raw.openIds.filter((id) => typeof id === 'string' && id) : [];
  // Deduped, then capped. Single mode holds exactly one pane by definition, and a stored list
  // longer than MAX_OPEN_LOG_PANES would open more EventSources than the ~6-per-origin connection
  // budget leaves room for - the one invariant here with a cost beyond a confusing screen.
  const openIds = [...new Set(ids)].slice(0, viewMode === 'single' ? 1 : MAX_OPEN_LOG_PANES);
  const open = new Set(openIds);
  // Both of these name panes, so both are meaningless for a pane that is not open: a stale main id
  // would silently put the group in leader-follower mode with no leader on screen, and a stale
  // disabled id would suppress sync for a pane nobody can see is opted out.
  const disabledSyncIds = (Array.isArray(raw.disabledSyncIds) ? raw.disabledSyncIds : []).filter((id) => open.has(id));
  const mainId = open.has(raw.mainId) ? raw.mainId : null;
  return { viewMode, openIds, disabledSyncIds, mainId };
}

export function loadOpenPanes(hostId) {
  if (!hostId) return null;
  try {
    return normalizeOpenPanes(JSON.parse(sessionStorage.getItem(KEY_PREFIX + hostId)));
  } catch {
    return null;
  }
}

export function saveOpenPanes(hostId, { viewMode, openIds, disabledSyncIds, mainId }) {
  if (!hostId) return;
  try {
    sessionStorage.setItem(KEY_PREFIX + hostId, JSON.stringify({ viewMode, openIds, disabledSyncIds, mainId }));
  } catch {
    /* sessionStorage unavailable or full - the tab still works, it just won't remember */
  }
}

// Called on logout: sessionStorage is scoped to the tab, not the account, so "per session" has to
// mean per sign-in. Keys are collected before removal - removing while walking by index skips
// entries, since each removal shifts the rest down. See CLAUDE.md.
export function clearAllOpenPanes() {
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
