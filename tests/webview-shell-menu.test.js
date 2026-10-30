const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, realFilesystem: true, snapshotId: 'menu-snapshot', active: 0, panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'literal & Datei.txt', type: 'text', size: 12 }, { id: 'b', name: 'second.txt', type: 'text', size: 24 }], 'C:/temp': [] } };
  state.panes[0].selected = ['a', 'b']; state.panes[0].cursor = 'a'; return state;
}
const requests = app => app.messages.filter(message => message.type === 'shell-context-menu');
function context(app, target) { const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); target.dispatchEvent(event); return event; }
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));

test('folder lock command freezes selected IDs for direct host inspection', t => {
  const state = fixture(); state.folders['C:/tmp'][0].type = 'folder'; state.panes[0].selected = ['a'];
  const app = createApp(t, state); app.action('inspect-folder-locks');
  assert.equal(requests(app).length, 1); assert.equal(requests(app)[0].inspectLocks, true);
  assert.deepEqual(Array.from(requests(app)[0].ids), ['a']); assert.equal(requests(app)[0].paths, undefined);
});

test('row context freezes IDs and directory while suppressing the competing workbench menu; column settings stay native', t => {
  const app = createApp(t, fixture()); let workbenchMenus = 0;
  app.window.addEventListener('contextmenu', event => { if (!event.defaultPrevented) workbenchMenus++; });
  const event = context(app, app.row('literal & Datei.txt').querySelector('[data-cell="size"]'));
  assert.equal(event.defaultPrevented, true);
  const request = requests(app)[0]; assert.ok(request);
  assert.deepEqual(Array.from(request.ids), ['a', 'b']); assert.equal(request.directory, 'C:/tmp'); assert.equal(request.snapshotId, 'menu-snapshot');
  assert.equal(request.paths, undefined); assert.equal(request.keyboard, false); assert.equal(workbenchMenus, 0);
  app.click(app.row('second.txt').querySelector('[data-cell="size"]'));
  assert.deepEqual(Array.from(request.ids), ['a', 'b'], 'subsequent selection cannot change the captured menu');
  assert.equal(context(app, app.document.querySelector('thead th')).defaultPrevented, false); assert.equal(workbenchMenus, 1);
  assert.equal(requests(app).length, 1);
});

test('keyboard context targets the cursor selection and stale responses cannot replace the current menu outcome', t => {
  const app = createApp(t, fixture()), list = app.document.querySelector('.pane.active .list');
  app.key('F10', { shiftKey: true }, list);
  assert.equal(requests(app).length, 1); assert.equal(requests(app)[0].keyboard, true);
  send(app, { type: 'shell-context-menu-result', requestId: 'foreign', ok: false, error: 'foreign' }); assert.equal(app.document.querySelector('#modal').open, false);
  send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: false, error: 'Native detail <literal>' });
  assert.equal(app.document.querySelector('.operation-error-text').value, 'Native detail <literal>');
  assert.equal(app.document.querySelector('.operation-error-text literal'), null);
});

test('menu focus changes wait for the native result, with no duplicate refresh after confirmed metadata refresh', t => {
  for (const refreshed of [true, false]) {
    const app = createApp(t, fixture()); app.action('shell-context-menu'); assert.equal(requests(app).length, 1);
    app.window.dispatchEvent(new app.window.Event('focus')); app.window.dispatchEvent(new app.window.Event('focus'));
    assert.equal(app.messages.filter(message => message.type === 'filesystem-refresh').length, 0);
    send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: true, cancelled: !refreshed, invoked: refreshed, refreshed });
    assert.equal(app.messages.filter(message => message.type === 'filesystem-refresh').length, refreshed ? 0 : 1);
  }
});

test('native execution invalidates cut intent without reading clipboard contents or accepting a late write acknowledgement', t => {
  const app = createApp(t, fixture()); app.action('clipboard-cut');
  const write = app.messages.find(message => message.type === 'clipboard-write'); assert.ok(write);
  assert.equal(app.document.querySelectorAll('.is-cut').length, 2);
  app.action('shell-context-menu');
  send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: true, invoked: true, refreshed: true, clipboardInvalidated: true });
  assert.equal(app.document.querySelectorAll('.is-cut').length, 0);
  send(app, { type: 'clipboard-result', requestId: write.requestId, ok: true, selection: { paths: write.paths, mode: 'move', source: 'system', token: 'old' } });
  assert.equal(app.document.querySelectorAll('.is-cut').length, 0);
  assert.equal(app.messages.some(message => message.type === 'clipboard-read'), false);
});

test('empty list space and the parent entry cannot open an older selected file context', t => {
  for (const selector of ['.pane.active .list', '.pane.active [data-parent]']) {
    const app = createApp(t, fixture());
    const event = context(app, app.document.querySelector(selector));
    assert.equal(event.defaultPrevented, true);
    assert.equal(requests(app).length, 0);
    assert.deepEqual(Array.from(app.state().panes[0].selected), ['a', 'b']);
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.match(app.document.querySelector('#status-message').textContent, /Ordnerhintergrund/);
  }
});
