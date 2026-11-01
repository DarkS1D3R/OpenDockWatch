// The topbar's four tabs, each over one or more views. The view ids stay what they were
// (DEFAULT_VIEW, VALID_VIEWS and saved links still name them); only the navigation groups them.
export const VIEW_GROUPS = [
  {
    id: 'hosts',
    label: 'Hosts',
    views: [
      { id: 'overview', label: 'All hosts' },
      { id: 'resources', label: 'Resources' },
    ],
  },
  {
    id: 'containers',
    label: 'Containers',
    views: [
      { id: 'list', label: 'List' },
      { id: 'flow', label: 'Flow' },
    ],
  },
  { id: 'logs', label: 'Logs', views: [{ id: 'logs', label: 'Logs' }] },
  {
    id: 'activity',
    label: 'Activity',
    views: [
      { id: 'activity', label: 'Alerts & events' },
      { id: 'uptime', label: 'Uptime' },
    ],
  },
];

// The views the All/Running/Stopped filter changes - it filters the container list they share.
export const STATE_FILTER_VIEWS = ['list', 'flow', 'logs'];

export function groupOf(view) {
  return VIEW_GROUPS.find((g) => g.views.some((v) => v.id === view)) || null;
}

// Clicking a tab returns to the view last used inside it, else its first.
export function viewForGroup(groupId, lastViewByGroup = {}) {
  const group = VIEW_GROUPS.find((g) => g.id === groupId);
  if (!group) return null;
  const last = lastViewByGroup[groupId];
  return group.views.some((v) => v.id === last) ? last : group.views[0].id;
}

// "Containers › Flow" for the Settings default-tab select; a one-view tab is just its name.
export function viewLabel(view) {
  const group = groupOf(view);
  if (!group) return view;
  if (group.views.length === 1) return group.label;
  return `${group.label} › ${group.views.find((v) => v.id === view).label}`;
}
