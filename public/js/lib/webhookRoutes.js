// Display logic for Settings > Webhook's routes list (SettingsWebhookRoutes.js), kept pure so it is
// unit-tested without mounting the component. See server/CLAUDE.md for how routes are matched.

import { ALERT_RULES } from '../constants.js';

// Scheme and host only: the path is where a Discord/Gotify token or an ntfy topic lives, and a list
// row only needs enough to tell two routes apart. The full URL is still in the edit form.
export function maskWebhookUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(invalid URL)';
  }
}

export function ruleLabel(value) {
  const rule = ALERT_RULES.find((r) => r.value === value);
  return rule ? rule.label : value;
}

// One line saying what a route takes, in the order it is checked: host, rules, severity.
export function routeSummary(route, hosts = []) {
  const host = route.hostId ? (hosts.find((h) => h.id === route.hostId) || {}).name || route.hostId : 'any host';
  const rules = route.rules.length ? route.rules.map(ruleLabel).join(', ') : 'every rule';
  const severity = route.minSeverity === 'critical' ? ', critical only' : '';
  return `${rules} on ${host}${severity}`;
}

export function blankRoute() {
  return { name: '', url: '', format: '', hostId: '', rules: [], minSeverity: 'warning', notifyRecovery: false, enabled: true };
}

// An editable copy. hostId goes back to '' (never null) or the "Any host" <option value=""> matches
// nothing and the select renders blank - the same trap SettingsContainerRules documents.
export function routeDraft(route) {
  return { ...blankRoute(), ...route, hostId: route.hostId || '', rules: [...route.rules] };
}
