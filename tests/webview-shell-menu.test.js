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

test('native Git Diff completion and failure use the status bar without an operation dialog', t => {
  const app = createApp(t, fixture(), { language: 'en' });
  for (const ok of [true, false]) {
    app.action('shell-context-menu'); const request = requests(app).at(-1);
    send(app, { type: 'shell-context-menu-result', requestId: request.requestId, action: 'git-diff', ok, error: 'Git unavailable', refreshed: false });
    assert.equal(app.document.querySelector('#status-message').textContent, ok ? 'Git diff opened.' : 'Git unavailable');
    assert.equal(app.document.querySelector('#modal').open, false);
  }
});

test('archive row context reports unavailable status without a native request or error dialog', t => {
  const state = fixture(), directory = 'zip:C%3A%2Ftmp%2Fsample.zip!/folder';
  state.panes[0].tabs = [directory];
  state.folders[directory] = state.folders['C:/tmp'];
  state.archiveLocations = { [directory]: { archive: 'C:/tmp/sample.zip', prefix: 'folder/' } };
  const app = createApp(t, state, { language: 'en', fileSettings: { useSystemContextMenu: true } });
  context(app, app.row('literal & Datei.txt'));
  assert.equal(requests(app).length, 0);
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.querySelector('.operation-error'), null);
  assert.equal(app.document.querySelector('#status-message').textContent, 'This action is unavailable inside a ZIP archive.');
  assert.deepEqual(Array.from(app.state().panes[0].selected), ['a', 'b']);
});

test('shell menu error copy includes request context and runtime diagnostics', t => {
  const app = createApp(t, fixture(), { language: 'en' }); app.action('shell-context-menu');
  const request = requests(app)[0];
  send(app, { type: 'shell-context-menu-result', requestId: request.requestId, ok: false, error: 'Invalid selection', diagnostic: {
    request: { ...request, paths: ['C:/tmp/literal & Datei.txt'] }, platform: 'win32', runtimeVersion: 'v22.test',
    failure: { code: 'NativeFailure', nativeCode: '31', operation: 'shell.showContextMenu', requestId: '2', generation: '7', stack: 'selection validation stack', cause: { nativeCode: '5', nativeStage: 'IContextMenu.InvokeCommand', hresult: '0x80004005', nativeCommand: 'delete', nativeCommandId: '0' } }
  } });
  app.click(app.document.querySelector('[data-copy-error]'));
  const copied = app.messages.find(message => message.type === 'selection-io' && message.action === 'copy');
  assert.ok(copied);
  for (const value of ['shell-context-menu', request.requestId, 'C:/tmp', 'menu-snapshot', 'v22.test', 'NativeFailure', 'Native code: 31', 'Native code: 5', 'Native operation: shell.showContextMenu', 'Native request ID: 2', 'Session generation: 7', 'selection validation stack', 'literal & Datei.txt']) assert.ok(copied.text.includes(value), value);
  assert.ok(copied.text.includes('Native stage: IContextMenu.InvokeCommand'));
  assert.ok(copied.text.includes('HRESULT: 0x80004005'));
  assert.ok(copied.text.includes('Native command: delete'));
  assert.ok(copied.text.includes('Native command ID: 0'));
});

test('Unix folder context uses the shared popup without launching a Windows shell helper', t => {
  for (const platform of ['linux']) {
    const state = fixture(); state.folders['C:/tmp'][0].type = 'folder'; state.panes[0].selected = ['a'];
    const app = createApp(t, state, { platform });
    const row = app.row('literal & Datei.txt'), event = context(app, row);
    assert.equal(event.defaultPrevented, true); assert.equal(requests(app).length, 0);
    assert.equal(JSON.parse(row.dataset.vscodeContext).webviewSection, 'folder');
    app.action('inspect-folder-locks'); assert.equal(requests(app)[0].inspectLocks, true);
    send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: true });
    context(app, app.row('second.txt'));
    assert.equal(JSON.parse(app.row('second.txt').dataset.vscodeContext).webviewSection, 'files');
  }
});

test('Unix menu context keeps the opening selection when the current selection changes before invocation', t => {
  const state = fixture(); state.folders['C:/tmp'][0].type = 'folder'; state.panes[0].selected = ['a'];
  const app = createApp(t, state, { platform: 'linux' });
  context(app, app.row('literal & Datei.txt'));
  const selection = JSON.parse(app.row('literal & Datei.txt').dataset.vscodeContext);
  app.click(app.row('second.txt').querySelector('[data-cell="size"]'));
  send(app, { type: 'action', action: 'inspect-folder-locks', contextSelection: selection });
  assert.deepEqual(Array.from(requests(app)[0].ids), ['a']); assert.equal(requests(app)[0].snapshotId, 'menu-snapshot');
});

test('folder lock command freezes selected IDs for direct host inspection', t => {
  const state = fixture(); state.folders['C:/tmp'][0].type = 'folder'; state.panes[0].selected = ['a'];
  const app = createApp(t, state); app.action('inspect-folder-locks');
  assert.equal(requests(app).length, 1); assert.equal(requests(app)[0].inspectLocks, true);
  assert.deepEqual(Array.from(requests(app)[0].ids), ['a']); assert.equal(requests(app)[0].paths, undefined);
});

test('row context freezes IDs and directory while suppressing the competing workbench menu; column settings use the shared popup', t => {
  const app = createApp(t, fixture(), { fileSettings: { useSystemContextMenu: true } }); let workbenchMenus = 0;
  app.window.addEventListener('contextmenu', event => { if (!event.defaultPrevented) workbenchMenus++; });
  const event = context(app, app.row('literal & Datei.txt').querySelector('[data-cell="size"]'));
  assert.equal(event.defaultPrevented, true);
  const request = requests(app)[0]; assert.ok(request);
  assert.deepEqual(Array.from(request.ids), ['a', 'b']); assert.equal(request.directory, 'C:/tmp'); assert.equal(request.snapshotId, 'menu-snapshot');
  assert.equal(request.paths, undefined); assert.equal(request.keyboard, false); assert.equal(workbenchMenus, 0);
  app.click(app.row('second.txt').querySelector('[data-cell="size"]'));
  assert.deepEqual(Array.from(request.ids), ['a', 'b'], 'subsequent selection cannot change the captured menu');
  assert.equal(context(app, app.document.querySelector('thead th')).defaultPrevented, true); assert.equal(workbenchMenus, 0);
  assert.ok(app.document.querySelector('[data-context-action="configure-columns"]'));
  assert.equal(requests(app).length, 1);
});

test('keyboard context targets the cursor selection and stale responses cannot replace the current menu outcome', t => {
  const app = createApp(t, fixture(), { fileSettings: { useSystemContextMenu: true } }), list = app.document.querySelector('.pane.active .list');
  app.key('F10', { shiftKey: true }, list);
  assert.equal(requests(app).length, 1); assert.equal(requests(app)[0].keyboard, true);
  send(app, { type: 'shell-context-menu-result', requestId: 'foreign', ok: false, error: 'foreign' }); assert.equal(app.document.querySelector('#modal').open, false);
  send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: false, error: 'Native detail <literal>' });
  assert.ok(app.document.querySelector('.operation-error-text').value.endsWith('Native detail <literal>'));
  assert.equal(app.document.querySelector('.operation-error-text literal'), null);
});

test('native menu DOM focus changes never schedule a filesystem refresh', t => {
  for (const refreshed of [true, false]) {
    const app = createApp(t, fixture()); app.action('shell-context-menu'); assert.equal(requests(app).length, 1);
    app.window.dispatchEvent(new app.window.Event('focus')); app.window.dispatchEvent(new app.window.Event('focus'));
    send(app, { type: 'window-focus' });
    assert.equal(app.messages.filter(message => message.type === 'filesystem-refresh').length, 0);
    send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: true, cancelled: !refreshed, invoked: refreshed, refreshed });
    assert.equal(app.messages.filter(message => message.type === 'filesystem-refresh').length, 0);
  }
});

test('native execution invalidates clipboard markers without accepting a late write acknowledgement', t => {
  for (const [action, mode, marker] of [['clipboard-cut', 'move', '.is-cut'], ['clipboard-copy', 'copy', '.is-copied']]) {
    const app = createApp(t, fixture()); app.action(action);
    const write = app.messages.find(message => message.type === 'clipboard-write'); assert.ok(write);
    assert.equal(app.document.querySelectorAll(marker).length, 2);
    app.action('shell-context-menu');
    send(app, { type: 'shell-context-menu-result', requestId: requests(app)[0].requestId, ok: true, invoked: true, refreshed: true, clipboardInvalidated: true });
    assert.equal(app.document.querySelectorAll(marker).length, 0);
    send(app, { type: 'clipboard-result', requestId: write.requestId, ok: true, selection: { paths: write.paths, mode, source: 'system', token: 'old' } });
    assert.equal(app.document.querySelectorAll(marker).length, 0);
    assert.equal(app.messages.some(message => message.type === 'clipboard-read'), false);
  }
});

test('empty list space and the parent entry cannot open an older selected file context', t => {
  for (const selector of ['.pane.active .list', '.pane.active [data-parent]']) {
    const app = createApp(t, fixture(), { fileSettings: { useSystemContextMenu: true } });
    const event = context(app, app.document.querySelector(selector));
    assert.equal(event.defaultPrevented, true);
    assert.equal(requests(app).length, 0);
    assert.deepEqual(Array.from(app.state().panes[0].selected), ['a', 'b']);
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.match(app.document.querySelector('#status-message').textContent, /Ordnerhintergrund/);
  }
});

test('path textbox context menu preserves native editing and never starts a shell menu', t => {
  const app = createApp(t, fixture());
  const input = app.document.querySelector('.path-input'); input.focus(); input.setSelectionRange(1, 4);
  const event = context(app, input);
  assert.equal(event.defaultPrevented, false);
  assert.equal(app.document.activeElement, input);
  assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 4);
  assert.equal(requests(app).length, 0);
  const ownContext = JSON.parse(input.dataset.vscodeContext);
  assert.equal(ownContext.webviewSection, 'textInput');
  assert.equal(ownContext.preventDefaultContextMenuItems, false);
});

test('textbox menu exposes a declared native select-all command and hides file commands', () => {
  const menus = require('../package.json').contributes.menus['webview/context'];
  assert.ok(menus.some(item => item.command === 'bitfroest.select-all-text' && item.when.includes('webviewSection == textInput')));
  assert.ok(require('../package.json').contributes.commands.some(item => item.command === 'bitfroest.select-all-text'));
  assert.ok(menus.every(item => item.command !== 'editor.action.selectAll'));
  for (const item of menus.filter(item => item.submenu || /bitfroest\.clipboard-/.test(item.command || ''))) assert.match(item.when, /webviewSection != textInput/);
});

test('inline rename text keeps the native editing menu inside a file row', t => {
  const app = createApp(t, fixture()); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input); input.focus();
  const event = context(app, input);
  assert.equal(event.defaultPrevented, false); assert.equal(requests(app).length, 0);
  assert.equal(JSON.parse(input.dataset.vscodeContext).webviewSection, 'textInput');
});

test('default file popup updates when system menus are enabled', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  const row = app.row('literal & Datei.txt');
  assert.equal(context(app, row).defaultPrevented, true);
  assert.equal(requests(app).length, 0);
  const captured = JSON.parse(row.dataset.vscodeContext);
  assert.equal(captured.fileMenu, true);
  assert.deepEqual(captured.ids, ['a', 'b']);
  assert.equal(captured.directory, 'C:/tmp');
  app.key('F10', { shiftKey: true }, app.document.querySelector('.pane.active .list'));
  assert.equal(requests(app).length, 0);
  send(app, { type: 'file-settings', settings: { useSystemContextMenu: true } });
  context(app, row);
  assert.equal(requests(app).length, 1);
});

test('clipboard menu commands preserve the opening selection and reject stale snapshots', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  context(app, app.row('literal & Datei.txt'));
  const captured = JSON.parse(app.row('literal & Datei.txt').dataset.vscodeContext);
  app.click(app.row('second.txt').querySelector('[data-cell="size"]'));
  send(app, { type: 'action', action: 'clipboard-copy', contextSelection: captured });
  const write = app.messages.find(message => message.type === 'clipboard-write');
  assert.deepEqual(Array.from(write.paths), ['C:/tmp/literal & Datei.txt', 'C:/tmp/second.txt']);
  send(app, { type: 'action', action: 'clipboard-cut', contextSelection: { ...captured, snapshotId: 'stale' } });
  assert.equal(app.messages.filter(message => message.type === 'clipboard-write').length, 1);
});

test('file menu schema defaults to false and includes lock inspection on Windows', () => {
  const manifest = require('../package.json');
  const setting = manifest.contributes.configuration.flatMap(group => Object.entries(group.properties)).find(([key]) => key === 'bitfroest.files.useSystemContextMenu')[1];
  assert.equal(setting.default, false); assert.equal(setting.type, 'boolean'); assert.equal(setting.scope, 'resource');
  const menu = manifest.contributes.menus['webview/context'];
  assert.ok(menu.find(item => item.command === 'bitfroest.inspect-folder-locks').when.includes('isWindows'));
  assert.equal(menu.some(item => item.submenu === 'bitfroest.menu'), false);
});

test('default background context offers paste without capturing previously selected files', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  const list = app.document.querySelector('.pane.active .list');
  assert.equal(context(app, list).defaultPrevented, true);
  const captured = JSON.parse(list.dataset.vscodeContext);
  assert.equal(captured.webviewSection, 'fileBackground');
  assert.deepEqual(captured.ids, []);
  assert.equal(requests(app).length, 0);
  const menu = require('../package.json').contributes.menus['webview/context'];
  for (const command of ['bitfroest.clipboard-copy', 'bitfroest.clipboard-cut']) assert.match(menu.find(item => item.command === command).when, /webviewSection != fileBackground/);
});
