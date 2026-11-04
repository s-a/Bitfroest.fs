const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function editor(app) {
  const shown = [], disposed = [];
  app.window.CommanderXrayEditor = { create(element, text, name) { shown.push({ text, name }); element.textContent = text; return { dispose() { disposed.push(name); } }; } };
  return { shown, disposed };
}

test('X-Ray cycles off, click, hover and restores the opposite list without moving focus', async t => {
  const app = createApp(t);
  const button = () => app.document.querySelector('[data-pane="0"] [data-xray-toggle]');
  assert.ok(button());
  app.click(app.row('package.json'));
  const before = JSON.stringify(app.state().panes[1]);
  app.click(button());
  assert.equal(button().dataset.mode, 'click');
  assert.ok(app.document.querySelector('[data-pane="1"] [data-xray]'));
  assert.equal(app.document.querySelector('#panes').dataset.xraySource, '0');
  assert.ok(app.document.activeElement.closest('[data-pane="0"]'));
  app.click(button()); assert.equal(button().dataset.mode, 'hover');
  app.click(button()); assert.equal(button().dataset.mode, 'off');
  assert.equal(app.document.querySelector('[data-xray]'), null);
  assert.equal(JSON.stringify(app.state().panes[1]), before);
});

test('footer right click never opens a file context menu', t => {
  const app = createApp(t);
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  app.document.querySelector('.pane-status').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.document.querySelector('#context-menu')?.hidden ?? true, true);
});

test('the X-Ray command uses the same mode control as the footer', t => {
  const app = createApp(t);
  app.action('xray');
  assert.ok(app.document.querySelector('[data-xray]'));
});

test('a pointer click survives the focus change before mouseup on the eye button', t => {
  const app = createApp(t);
  app.document.querySelector('[data-pane="1"] .list').focus();
  const button = app.document.querySelector('[data-pane="0"] [data-xray-toggle]');
  const icon = button.querySelector('svg');
  icon.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
  button.focus();
  assert.equal(button.isConnected, true, 'focus must not replace the pressed control');
  assert.equal(app.document.activeElement, button);
  icon.dispatchEvent(new app.window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  app.click(icon);
  assert.equal(button.dataset.mode, 'click');
  assert.ok(app.document.querySelector('[data-pane="1"] [data-xray]'));
});

test('enabling X-Ray closes an existing F3 view before replacing the opposite pane', t => {
  const app = createApp(t);
  app.click(app.row('README.md')); app.key('F3');
  assert.ok(app.document.querySelector('[data-lister]'));
  app.click(app.document.querySelector('[data-pane="1"] [data-xray-toggle]'));
  assert.equal(app.document.querySelector('[data-lister]'), null);
  assert.ok(app.document.querySelector('[data-pane="0"] [data-xray]'));
});

test('right click on the eye disables X-Ray directly', t => {
  const app = createApp(t);
  const button = app.document.querySelector('[data-pane="0"] [data-xray-toggle]');
  app.click(button);
  assert.ok(app.document.querySelector('[data-xray]'));
  button.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  assert.equal(app.document.querySelector('[data-xray]'), null);
});

test('X-Ray temporarily reduces its source grid to the filename and restores column state', t => {
  const app = createApp(t), grid = app.grid(0);
  const before = grid.getColumnState();
  const columns = JSON.stringify(app.state().panes[0].columns);
  app.click(app.document.querySelector('[data-pane="0"] [data-xray-toggle]'));
  assert.deepEqual(Array.from(grid.getAllDisplayedColumns(), column => column.getColId()), ['name']);
  assert.equal(JSON.stringify(app.state().panes[0].columns), columns);
  app.document.querySelector('[data-pane="0"] [data-xray-toggle]').dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  assert.deepEqual(grid.getColumnState(), before);
});

test('hover waits 200 ms, cancels on leaving and disposes the previous editor', async t => {
  const app = createApp(t), view = editor(app);
  app.click(app.row('package.json'));
  const toggle = () => app.document.querySelector('[data-pane="0"] [data-xray-toggle]');
  app.click(toggle()); app.click(toggle());
  const initial = view.shown.length, row = app.row('README.md');
  row.dispatchEvent(new app.window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(view.shown.length, initial);
  row.dispatchEvent(new app.window.MouseEvent('mouseout', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(view.shown.length, initial);
  row.dispatchEvent(new app.window.MouseEvent('mouseover', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(view.shown.at(-1).name, 'README.md');
  assert.ok(view.disposed.length);
  app.document.querySelector('[data-xray]').focus(); app.key('Escape');
  assert.equal(app.document.querySelector('[data-xray]'), null);
  assert.ok(app.document.activeElement.closest('[data-pane="0"]'));
});

test('real X-Ray rejects late replies after changing files or closing the preview', t => {
  const pane = path => ({ tabs: [path], tab: 0, filter: '', sort: 'name', descending: false, cursor: 'a', selected: ['a'] });
  const state = { version: 1, realFilesystem: true, active: 0, snapshotId: 'one', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.json', type: 'text', fsSource: 'C:/tmp/a.json', size: 2 }, { id: 'b', name: 'b.ps1', type: 'text', fsSource: 'C:/tmp/b.ps1', size: 2 }], 'C:/temp': [] } };
  const app = createApp(t, state), view = editor(app);
  app.click(app.document.querySelector('[data-xray-toggle]'));
  const first = app.messages.find(message => message.type === 'xray-open'); assert.ok(first);
  app.click(app.row('b.ps1'));
  const second = app.messages.filter(message => message.type === 'xray-open').at(-1);
  assert.notEqual(first.requestId, second.requestId);
  const reply = request => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'xray-result', requestId: request.requestId, ok: true, text: request.path } }));
  reply(first); assert.equal(view.shown.length, 0);
  reply(second); assert.equal(view.shown.at(-1).name, 'b.ps1');
  app.document.querySelector('[data-xray-toggle]').dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  reply(second); assert.equal(view.shown.length, 1);
});
