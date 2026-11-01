// Focus handling for the app's dialogs (ContainerMetricsModal, SettingsPanel): move focus in on open,
// keep Tab inside a modal one, and hand focus back to whatever opened it on close. See docs/architecture/frontend.md.

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(el) {
  return el ? [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement) : [];
}

// Pure half of the Tab trap: where focus should go when Tab (or Shift+Tab) would leave `items`, or
// null to let the browser move it normally. Focus outside the list is pulled back to its first item.
export function nextTrapTarget(items, active, shiftKey) {
  if (!items.length) return null;
  const first = items[0];
  const last = items[items.length - 1];
  if (!items.includes(active)) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

export function trapTab(event, container) {
  if (event.key !== 'Tab') return;
  const target = nextTrapTarget(focusableIn(container), document.activeElement, event.shiftKey);
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

// Remembers what had focus when a dialog opened and returns a function that gives it back - only
// if that element is still in the page, since the row or button that opened it may have re-rendered.
export function rememberFocus() {
  const previous = document.activeElement;
  return () => {
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
  };
}

// True when another dialog is open on top (the metrics modal over Settings), so a panel's Escape
// handler leaves the key to it instead of both closing at once.
export function modalOpenAbove(self) {
  const modal = document.querySelector('[aria-modal="true"]');
  return !!modal && !self.contains(modal);
}
