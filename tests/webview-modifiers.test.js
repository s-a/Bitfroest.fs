const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./support/webview.cjs');
function choose(app, name, modifiers = {}) { app.click(app.row(name).querySelector('[data-filename]'), modifiers); }
function names(app) { return [...app.document.querySelectorAll('.pane.active tr.selected [data-filename]')].map(element => element.closest('tr').title || element.closest('td').title || element.textContent); }
test('Shift-arrow keeps the initial anchor and contracts when returning', t => {
  const app = createApp(t); choose(app, 'assets');
  app.key('ArrowDown', { shiftKey: true }); app.key('ArrowDown', { shiftKey: true });
  assert.deepEqual(names(app), ['assets', 'docs', 'src']);
  app.key('ArrowUp', { shiftKey: true });
  assert.deepEqual(names(app), ['assets', 'docs']);
  app.key('ArrowUp', { shiftKey: true }); assert.deepEqual(names(app), ['assets']);
});
test('Shift-click keeps its anchor across consecutive clicks and Ctrl-Shift preserves prior selection', t => {
  const app = createApp(t); choose(app, 'assets'); choose(app, 'src', { shiftKey: true });
  choose(app, 'docs', { shiftKey: true }); assert.deepEqual(names(app), ['assets', 'docs']);
  choose(app, 'README.md'); choose(app, 'assets', { ctrlKey: true });
  choose(app, 'src', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(names(app), ['assets', 'docs', 'src', 'README.md']);
  choose(app, 'docs', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(names(app), ['assets', 'docs', 'README.md']);
});
test('Shift-F7 proposes the cursor file stem and creates the folder in the opposite pane', t => {
  const app = createApp(t); choose(app, 'README.md'); app.key('F7', { shiftKey: true });
  assert.match(app.document.querySelector('#modal-body').textContent, /\/home\/demo\/Downloads/);
  assert.equal(app.document.querySelector('#value').value, 'README');
  app.document.querySelector('#value').value = 'Zielordner';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(app.state().folders['/home/demo/Downloads'].some(file => file.name === 'Zielordner'));
  assert.equal(app.state().folders['/workspace/bitfroest'].some(file => file.name === 'Zielordner'), false);
});

test('F7 removes only the last file extension and retains dotted folder and dotfile names', t => {
  for (const [name, type, expected] of [['report.backup.csv', 'text', 'report.backup'], ['docs.v1', 'folder', 'docs.v1'], ['.env', 'text', '.env']]) {
    const app = createApp(t);
    const state = app.state();
    state.folders['/workspace/bitfroest'].push({ id: 'proposal', name, type });
    state.panes[0].cursor = 'proposal';
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state } })); app.key('F7');
    assert.equal(app.document.querySelector('#value').value, expected, name);
  }
});
test('mkdir-other host command uses the opposite pane while ordinary F7 stays local', t => {
  const app = createApp(t); choose(app, 'README.md'); app.action('mkdir-other');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.match(app.document.querySelector('#modal-body').textContent, /\/home\/demo\/Downloads/);
  app.click(app.document.querySelector('#modal-cancel')); app.key('F7');
  assert.match(app.document.querySelector('#modal-body').textContent, /\/workspace\/bitfroest/);
});

