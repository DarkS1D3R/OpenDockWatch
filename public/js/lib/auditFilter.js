// The Audit log tab's two filters. Rows are `GET /api/audit`'s, straight from sqlite, so the fields
// are snake_case (`container_name`, `host_id`) unlike the camelCase the events feed uses.

// Everything a person might type to find a row: who, where, what it was done to, what was done, how
// it went, and the docker error text - the last is how "which of these failed with permission
// denied" is answered without a second control.
const SEARCH_FIELDS = ['username', 'host_id', 'container_name', 'container_id', 'action', 'result', 'error'];

export function filterAudit(rows, { search = '', failuresOnly = false } = {}) {
  const q = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (failuresOnly && row.result !== 'error') return false;
    if (!q) return true;
    return SEARCH_FIELDS.some((field) => (row[field] || '').toLowerCase().includes(q));
  });
}

// Which style the result badge takes. `pending` is a row whose action was requested and never
// reported back - normally a moment, but one left that way is a process that died mid-action.
export function resultClass(result) {
  if (result === 'ok') return 'audit-ok';
  if (result === 'error') return 'audit-error-badge';
  return 'audit-pending';
}
