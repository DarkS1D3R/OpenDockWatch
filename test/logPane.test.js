const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Everything here was inline in LogViewer.js, where none of it could be reached without a browser.
// It is the pane's fiddliest logic - an inverted drag delta, a four-condition key guard - and it
// was documented at length in public/CLAUDE.md and verified by nobody. See public/CLAUDE.md.
let logPane;
before(async () => {
  logPane = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', 'logPane.js')));
});

test('clampPaneHeight', async (t) => {
  await t.test('passes a height that is already within bounds, rounded', () => {
    assert.equal(logPane.clampPaneHeight(120.4, { minHeight: 60, maxHeight: 300 }), 120);
  });

  await t.test('floors at minHeight and caps at maxHeight', () => {
    assert.equal(logPane.clampPaneHeight(10, { minHeight: 60, maxHeight: 300 }), 60);
    assert.equal(logPane.clampPaneHeight(9999, { minHeight: 60, maxHeight: 300 }), 300);
  });

  // A window short enough that the strip's floor exceeds what the body can spare. The cap has to
  // win, or the strip is drawn taller than the space that exists for it and the log body vanishes.
  await t.test('the cap wins when the two bounds cross', () => {
    assert.equal(logPane.clampPaneHeight(200, { minHeight: 60, maxHeight: 40 }), 40);
  });

  await t.test('always returns a whole number of pixels', () => {
    for (const px of [60.5, 61.4, 99.99]) {
      assert.ok(Number.isInteger(logPane.clampPaneHeight(px, { minHeight: 60, maxHeight: 300 })));
    }
  });
});

test('maxPaneHeight', async (t) => {
  await t.test('is the strip plus whatever the body can spare above its own floor', () => {
    assert.equal(logPane.maxPaneHeight({ paneHeight: 100, bodyHeight: 400, minBodyHeight: 120 }), 380);
  });

  // The body is already at or under its floor, so it has nothing to give - the strip may keep what
  // it has and no more. Without the Math.max this would go negative and shrink the strip on a drag
  // that was trying to grow it.
  await t.test('offers nothing extra when the body is already at its floor', () => {
    assert.equal(logPane.maxPaneHeight({ paneHeight: 100, bodyHeight: 120, minBodyHeight: 120 }), 100);
    assert.equal(logPane.maxPaneHeight({ paneHeight: 100, bodyHeight: 40, minBodyHeight: 120 }), 100);
  });
});

// The single most error-prone line in the component, and the reason the browser's native resize
// corner was the wrong affordance: the handle is the strip's TOP edge, on a pane anchored to the
// BOTTOM of the panel, so the delta is subtracted.
test('dragHeight', async (t) => {
  const bounds = { minHeight: 60, maxHeight: 400 };

  await t.test('dragging up makes the strip taller', () => {
    assert.equal(logPane.dragHeight({ startHeight: 100, startY: 500, clientY: 460, ...bounds }), 140);
  });

  await t.test('dragging down makes it shorter', () => {
    assert.equal(logPane.dragHeight({ startHeight: 100, startY: 500, clientY: 540, ...bounds }), 60);
  });

  await t.test('no movement leaves the height exactly as it was', () => {
    assert.equal(logPane.dragHeight({ startHeight: 137, startY: 500, clientY: 500, ...bounds }), 137);
  });

  // A fast drag routinely outruns the bounds in both directions - the listeners are on window
  // precisely because the pointer leaves the panel - so clamping has to hold at the extremes.
  await t.test('stays within bounds however far the pointer travels', () => {
    assert.equal(logPane.dragHeight({ startHeight: 100, startY: 500, clientY: -9999, ...bounds }), 400);
    assert.equal(logPane.dragHeight({ startHeight: 100, startY: 500, clientY: 9999, ...bounds }), 60);
  });

  // The regression that a sign flip causes and nothing else would catch: the strip growing when
  // the pointer moves away from its edge. Asserted as a direction, not a value.
  await t.test('height moves opposite to the pointer, never with it', () => {
    const up = logPane.dragHeight({ startHeight: 200, startY: 500, clientY: 450, ...bounds });
    const down = logPane.dragHeight({ startHeight: 200, startY: 500, clientY: 550, ...bounds });
    assert.ok(up > 200, `dragging up must grow the strip, got ${up}`);
    assert.ok(down < 200, `dragging down must shrink the strip, got ${down}`);
  });
});

test('shouldTogglePause', async (t) => {
  const key = (over = {}) => ({ key: ' ', code: 'Space', target: { tagName: 'DIV' }, ...over });

  await t.test('takes a plain space in a lone pane', () => {
    assert.equal(logPane.shouldTogglePause(key()), true);
  });

  await t.test('accepts either key or code, since layouts disagree', () => {
    assert.equal(logPane.shouldTogglePause(key({ key: ' ', code: 'Other' })), true);
    assert.equal(logPane.shouldTogglePause(key({ key: 'Unidentified', code: 'Space' })), true);
  });

  await t.test('ignores any other key', () => {
    assert.equal(logPane.shouldTogglePause(key({ key: 'a', code: 'KeyA' })), false);
  });

  // Every modifier, individually: ctrl+space is an IME toggle, and the others all mean something
  // that is not "pause this log".
  await t.test('ignores space with any modifier held', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      assert.equal(logPane.shouldTogglePause(key({ [mod]: true })), false, `${mod} should suppress the toggle`);
    }
  });

  // The listener is on document, so without this the filter box could not contain a space.
  await t.test('ignores space typed into a field, a control, or contenteditable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
      assert.equal(logPane.shouldTogglePause(key({ target: { tagName } })), false, `${tagName} should keep its own space`);
    }
    assert.equal(logPane.shouldTogglePause(key({ target: { tagName: 'DIV', isContentEditable: true } })), false);
  });

  await t.test('survives an event with no target at all', () => {
    assert.equal(logPane.shouldTogglePause(key({ target: null })), true);
  });

  // Four panes each carry the listener, so without the hover check one space pauses all of them.
  await t.test('in multi-pane only the hovered pane takes the press', () => {
    assert.equal(logPane.shouldTogglePause(key(), { multiPane: true, hovered: false }), false);
    assert.equal(logPane.shouldTogglePause(key(), { multiPane: true, hovered: true }), true);
  });

  await t.test('a lone pane needs no hover', () => {
    assert.equal(logPane.shouldTogglePause(key(), { multiPane: false, hovered: false }), true);
  });
});

test('statusBadge', async (t) => {
  await t.test('a streaming pane says so rather than saying nothing', () => {
    const badge = logPane.statusBadge({ paused: false, suspended: false });
    assert.equal(badge.cls, 'log-status-active');
    assert.match(badge.text, /active/);
  });

  await t.test('a paused pane reports how many lines are held, and omits the count at zero', () => {
    assert.match(logPane.statusBadge({ paused: true, pendingCount: 12 }).text, /paused · 12 held/);
    assert.equal(logPane.statusBadge({ paused: true, pendingCount: 0 }).text, '⏸ paused');
  });

  await t.test('a suspended pane is badged differently from a paused one', () => {
    const badge = logPane.statusBadge({ paused: false, suspended: true });
    assert.equal(badge.cls, 'log-status-suspended');
    assert.match(badge.text, /suspended/);
  });

  // "I paused this" and "the tab did" are different states, and if the user paused it that is the
  // answer to "why isn't this moving" - so manual pause has to win when both are true.
  await t.test('manual pause outranks suspension', () => {
    assert.equal(logPane.statusBadge({ paused: true, suspended: true }).cls, 'log-status-paused');
  });

  await t.test('every state carries a class, text and title - the badge is never half-rendered', () => {
    for (const state of [{ paused: true }, { suspended: true }, {}]) {
      const badge = logPane.statusBadge(state);
      for (const field of ['cls', 'text', 'title']) {
        assert.ok(badge[field], `${JSON.stringify(state)} produced no ${field}`);
      }
    }
  });
});
