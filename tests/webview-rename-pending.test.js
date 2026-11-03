const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');

function setup(t) {
  const pane = folder => ({ tabs: [folder], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  let now = 1000, sequence = 0;
  const timers = new Map();
  const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'a-long-filename.txt', type: 'text' }, { id: 'b', name: 'b.txt', type: 'text' }], '/right': []
  } }, { beforeApp({ window }) {
    window.Date.now = () => now;
    window.setTimeout = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { fn, due: now + delay }); return id; };
    window.clearTimeout = id => timers.delete(id);
  } });
  app.tick = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); } };
  app.name = text => app.row(text).querySelector('[data-filename]');
  return app;
}

function scheduleRename(app) {
  app.click(app.name('a-long-filename.txt')); app.tick(1000);
  assert.equal(app.name('a-long-filename.txt').classList.contains('rename-pending'), false, 'first selection click has no cue');
  app.click(app.name('a-long-filename.txt'));
  assert.equal(app.name('a-long-filename.txt').classList.contains('rename-pending'), true, 'cue starts as soon as the existing delay is scheduled');
}

test('delayed rename paints a full-cell cue during the shorter wait and clears it on entry', t => {
  const app = setup(t); scheduleRename(app);
  const style = app.document.createElement('style');
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  style.textContent = resolveThemeCss(css);
  app.document.head.append(style);
  const name = app.name('a-long-filename.txt'), wrapper = name.querySelector('.filename-text');
  const renderedText = name.textContent;
  assert.ok(wrapper);
  assert.equal(wrapper.textContent, renderedText);
  assert.equal(app.window.getComputedStyle(name).backgroundImage, 'none', 'the flex filename cell must not receive a background');
  assert.equal(app.window.getComputedStyle(wrapper).display, 'inline-block');
  assert.equal(app.window.getComputedStyle(wrapper).textOverflow, 'ellipsis');
  assert.match(style.textContent, /ag-cell:has\(.rename-pending\)::before[^}]*animation: rename-pending-fill 650ms linear forwards/);
  assert.match(css, /ag-cell:has\(.rename-pending,.drag-pending\)::before[^}]*background: var\(--vscode-editor-findMatchHighlightBackground/);
  app.tick(649);
  assert.equal(name.classList.contains('rename-pending'), true);
  assert.equal(app.document.querySelector('.inline-rename'), null);
  app.tick(1);
  assert.equal(app.name('a-long-filename.txt').classList.contains('rename-pending'), false);
  assert.equal(app.document.querySelector('.inline-rename').value, 'a-long-filename.txt');
  app.document.querySelector('.inline-rename').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(name.textContent, renderedText);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('filename text wrapper inherits link and selection decoration and text color', () => {
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /\.filename-text\s*\{[^}]*text-decoration:\s*inherit/s);
  assert.match(css, /\.filename-text\s*\{[^}]*text-underline-offset:\s*inherit/s);
  assert.match(css, /\.filename-text\s*\{[^}]*color:\s*inherit/s);
});

for (const cancel of ['pointerdown', 'focus', 'blur', 'key', 'selection', 'dblclick', 'dragstart', 'tab', 'command', 'pagehide']) {
  test(`delayed rename cue is removed immediately on ${cancel}`, t => {
    const app = setup(t); scheduleRename(app); app.tick(649);
    const name = app.name('a-long-filename.txt');
    assert.equal(name.classList.contains('rename-pending'), true);
    if (cancel === 'focus') app.document.querySelector('[data-action="copy"]').focus();
    else if (cancel === 'key') app.key('ArrowDown');
    else if (cancel === 'selection') app.click(app.name('b.txt'));
    else if (cancel === 'dragstart') app.row('a-long-filename.txt').dispatchEvent(new app.window.Event('dragstart', { bubbles: true, cancelable: true }));
    else if (cancel === 'tab') app.action('new-tab');
    else if (cancel === 'command') app.action('rename');
    else if (cancel === 'pagehide') app.window.dispatchEvent(new app.window.Event('pagehide'));
    else {
      const event = new app.window.MouseEvent(cancel, { bubbles: true, cancelable: true });
      (cancel === 'pointerdown' ? name.querySelector('.filename-text') : name).dispatchEvent(event);
      if (cancel === 'pointerdown') assert.equal(event.target.isConnected, true, 'cancelling the cue must not detach the active event target');
      if (cancel === 'pointerdown') assert.deepEqual(app.state().panes[0].selected, ['a']);
    }
    assert.equal(name.classList.contains('rename-pending'), false);
    app.tick(1000);
    assert.equal(app.document.querySelector('.inline-rename'), null);
  });
}

test('explicit immediate rename has no waiting cue', t => {
  const app = setup(t); app.action('rename-one');
  assert.equal(app.document.querySelector('.inline-rename').value, 'a-long-filename.txt');
  assert.equal(app.name('a-long-filename.txt').classList.contains('rename-pending'), false);
});

test('clearing a quick search retains the filename cue target for delayed rename', t => {
  const app = setup(t), name = app.name('a-long-filename.txt');
  app.key('a'); app.key('Escape');
  assert.ok(name.querySelector('.filename-text'), 'clearing the quick search must preserve the stable rendered filename wrapper');
  app.click(name); app.tick(1000); app.click(name);
  assert.equal(name.classList.contains('rename-pending'), true);
  assert.ok(name.querySelector('.filename-text'));
});
