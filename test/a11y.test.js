const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Structural accessibility checks over every component template, the same enforce-don't-document
// approach as logger.test.js's console scan: three rules a new template can quietly break, each a
// control that a keyboard or screen-reader user cannot reach or cannot name. See public/CLAUDE.md.
const ROOT = path.join(__dirname, '..', 'public', 'js');
const FILES = [path.join(ROOT, 'app.js'), ...fs.readdirSync(path.join(ROOT, 'components')).map((f) => path.join(ROOT, 'components', f))];

// Click targets that are deliberately not keyboard-focusable, each with the keyboard route that
// replaces it. An entry that no longer matches a live tag fails too, so it can't outlive its reason.
const CLICK_EXEMPT = new Map([
  [
    'LogViewer.js|class="log-line"',
    'a log line is clickable only as a filter match; Enter/Shift+Enter and the arrow keys in the filter box walk the matches',
  ],
  [
    'LogMatchPane.js|class="log-match-row"',
    'same matches as the log body, walked from the filter box by keyboard; a tab stop per match would bury the controls',
  ],
  ['ContainerMetricsModal.js|class="metrics-modal-backdrop"', 'clicking outside closes the dialog; Escape does the same from the keyboard'],
  [
    'ContainerList.js|class="group-actions"',
    'only stops a click on its buttons from also toggling the group; the buttons themselves are focusable',
  ],
  ['ContainerList.js|class="actions"', 'same: stops propagation for the row buttons inside it'],
  [
    'ContainerList.js|class="group-header"',
    'a mouse convenience over the whole header; the group-toggle button inside it does the same by keyboard',
  ],
]);

const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'option', 'summary']);
const TAG_RE = /<(\/?)([a-z][a-z0-9-]*)\b((?:[^>"'`]|"[^"]*"|'[^']*')*)>/g;

function templatesOf(src) {
  const out = [];
  const re = /template:\s*`([\s\S]*?)`,?\s*\n\s*(?:\}|\w+:)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// Every opening tag with its attributes, whether it sits inside a <label>, and (for buttons) the
// text it would render: static text plus every string literal inside a {{ }} that has any.
function scan(template) {
  const tags = [];
  let labelDepth = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(template))) {
    const [all, closing, tag, attrs] = m;
    if (tag === 'label') {
      labelDepth += closing ? -1 : 1;
      continue;
    }
    if (closing) continue;
    const entry = { tag, attrs, inLabel: labelDepth > 0 };
    if (tag === 'button') {
      const end = template.indexOf('</button>', m.index);
      entry.inner = template.slice(m.index + all.length, end);
    }
    tags.push(entry);
  }
  return tags;
}

// True when the button shows words in every state: static text with a letter in it, or one {{ }}
// whose every literal branch has one. A {{ }} with no literal is data (a label, a count) - words.
const WORDY = /[A-Za-z0-9]/;
function alwaysHasText(inner) {
  const noTags = inner.replace(/<[^>]+>/g, ' ');
  if (WORDY.test(noTags.replace(/\{\{[\s\S]*?\}\}/g, ' '))) return true;
  return [...noTags.matchAll(/\{\{([\s\S]*?)\}\}/g)].some(([, expr]) => {
    const literals = [...expr.matchAll(/'([^']*)'|"([^"]*)"/g)].map((l) => l[1] ?? l[2]);
    return !literals.length || literals.every((l) => WORDY.test(l));
  });
}

const hasName = (attrs) => /(^|\s):?aria-label(ledby)?=/.test(attrs);
const all = FILES.flatMap((file) =>
  templatesOf(fs.readFileSync(file, 'utf8')).flatMap((t) => {
    // Ids a <label for=...> in the same template points at - such a field is labelled already.
    const labelled = new Set([...t.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    return scan(t).map((tag) => ({ ...tag, file: path.basename(file), labelled }));
  })
);

test('a11y: template scan found the templates', () => {
  // A scan that silently matched nothing would pass every rule below.
  assert.ok(all.filter((t) => t.tag === 'button').length > 100, 'expected well over 100 buttons across the templates');
});

test('a11y: every click target is reachable by keyboard', () => {
  const used = new Set();
  const bad = [];
  for (const t of all) {
    if (INTERACTIVE.has(t.tag) || !/@click/.test(t.attrs)) continue;
    const exempt = [...CLICK_EXEMPT.keys()].find((k) => {
      const [file, snippet] = k.split('|');
      return file === t.file && t.attrs.includes(snippet);
    });
    if (exempt) {
      used.add(exempt);
      continue;
    }
    // A <tr> keeps its row role (a role="button" would hide the cells from the table); the rest need one.
    const needsRole = t.tag !== 'tr';
    if (!/tabindex=/.test(t.attrs) || !/@keydown/.test(t.attrs) || (needsRole && !/role=/.test(t.attrs)))
      bad.push(`${t.file}: <${t.tag}${t.attrs.replace(/\s+/g, ' ').slice(0, 100)}>`);
  }
  assert.deepEqual(bad, [], 'a non-button with @click needs role, tabindex and a @keydown handler, or a real <button>');
  assert.deepEqual(
    [...CLICK_EXEMPT.keys()].filter((k) => !used.has(k)),
    [],
    'stale exemption'
  );
});

test('a11y: every button has an accessible name', () => {
  const bad = all
    .filter((t) => t.tag === 'button' && !hasName(t.attrs))
    .filter((t) => !alwaysHasText(t.inner))
    .map((t) => `${t.file}: <button${t.attrs.replace(/\s+/g, ' ').slice(0, 90)}> "${t.inner.trim().slice(0, 30)}"`);
  assert.deepEqual(bad, [], 'a button showing only a symbol (✕, ▲, ★, an icon) needs aria-label - title is not a reliable name');
});

test('a11y: a toggle button says whether it is on', () => {
  // `active` is this codebase's visual "on" state; without aria-pressed (a toggle) or aria-current
  // (the selected view or tab) that state is colour alone.
  const bad = all
    .filter((t) => t.tag === 'button' && /:class="[^"]*\bactive\b/.test(t.attrs))
    .filter((t) => !/:aria-(pressed|current|expanded)=/.test(t.attrs))
    .map((t) => `${t.file}: <button${t.attrs.replace(/\s+/g, ' ').slice(0, 100)}>`);
  assert.deepEqual(bad, [], 'a button styled `active` needs :aria-pressed, or :aria-current for a view/tab switch');
});

test('a11y: every form field has a label', () => {
  const bad = all
    .filter((t) => ['input', 'select', 'textarea'].includes(t.tag))
    .filter((t) => !/type="hidden"/.test(t.attrs) && !t.inLabel && !hasName(t.attrs))
    .filter((t) => !(/\bid="([^"]+)"/.test(t.attrs) && t.labelled.has(/\bid="([^"]+)"/.exec(t.attrs)[1])))
    .map((t) => `${t.file}: <${t.tag}${t.attrs.replace(/\s+/g, ' ').slice(0, 100)}>`);
  assert.deepEqual(bad, [], 'wrap the field in a <label> or give it aria-label - a placeholder disappears once typed in');
});
