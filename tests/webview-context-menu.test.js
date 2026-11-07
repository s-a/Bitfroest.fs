const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const fixture = () => ({ version: 1, realFilesystem: true, snapshotId: 'ctx', active: 0,
  panes: [{ tabs: ['C:/one', 'C:/two'], tab: 0, filter: '', selected: ['a'], cursor: 'a' }, { tabs: ['C:/two'], tab: 0, filter: '', selected: [] }],
  folders: { 'C:/one': [{ id: 'a', name: 'one.txt', type: 'text', size: 1 }, { id: 'b', name: 'two.txt', type: 'text', size: 1 }], 'C:/two': [] } });
const context = (app, target) => {
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 30 });
  target.dispatchEvent(event); return event;
};
const menu = app => app.document.querySelector('[data-context-menu]:not([hidden])');

const post = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const sendFavorites = app => post(app, { type: 'favorite-settings', settings: {
  entries: { work: 'C:/two', old: 'C:/old' },
  order: ['work', 'old'], labels: { work: 'Work', old: 'Old' }, groups: { work: 'Projects' }
} });
const menuButton = (app, label) => [...menu(app).querySelectorAll('button')].findLast(button =>
  button.dataset.contextAction !== 'clipboard-copy' && button.querySelector('.menu-label')?.textContent === label);
const browseRequests = app => app.messages.filter(message => message.type === 'send-to-directories');

test('Send to shows configured favorites without reading their subfolders or changing tabs', t => {
  const app = createApp(t, fixture(), { language: 'en', platform: 'win32' });
  sendFavorites(app);
  context(app, app.row('one.txt'));
  const list = app.document.querySelector('.pane.active .list');
  const send = menuButton(app, 'Send to');
  assert.ok(send);
  assert.equal(send.previousElementSibling.getAttribute('role'), 'separator');
  assert.equal(send.previousElementSibling.previousElementSibling.dataset.contextAction, 'clipboard-paste');
  app.key('ArrowRight', {}, send);
  assert.equal(app.document.activeElement, menuButton(app, 'Projects'));
  app.key('ArrowRight');
  app.key('ArrowRight');
  assert.equal(browseRequests(app).length, 0);
  assert.ok(menuButton(app, 'Copy'));
  assert.ok(menuButton(app, 'Move'));
  assert.deepEqual(Array.from(app.state().panes, pane => pane.tabs[pane.tab]), ['C:/one', 'C:/two']);
  assert.equal(app.messages.some(message => ['filesystem-navigate', 'filesystem-apply', 'clipboard-write'].includes(message.type)), false);
  for (let i = 0; i < 5 && menu(app); i++) app.key('Escape');
  assert.equal(menu(app), null);
  assert.equal(app.document.activeElement, list);
});

test('Send to offers only transfer actions when switching between configured favorites', t => {
  const app = createApp(t, fixture(), { language: 'en', platform: 'win32' });
  sendFavorites(app);
  context(app, app.row('one.txt'));
  app.click(menuButton(app, 'Send to'));
  app.click(menuButton(app, 'Projects'));
  app.click(menuButton(app, 'Work'));
  app.click(menuButton(app, 'Old'));
  const branch = app.document.getElementById(menuButton(app, 'Old').getAttribute('aria-controls'));
  assert.deepEqual([...branch.querySelectorAll('.menu-label')].map(label => label.textContent), ['Copy', 'Move']);
  assert.equal(browseRequests(app).length, 0);
});

function openSendToTarget(app) {
  sendFavorites(app);
  context(app, app.row('one.txt'));
  for (const label of ['Send to', 'Projects', 'Work']) app.click(menuButton(app, label));
}

test('Send to can be cancelled in the standard dialog before preparing or writing', t => {
  const app = createApp(t, fixture(), { language: 'en', platform: 'win32' });
  openSendToTarget(app);
  app.click(menuButton(app, 'Move'));
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Move');
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.some(message => ['filesystem-prepare', 'filesystem-apply'].includes(message.type)), false);
});

test('typing a file search before Send to does not expand a single selection with the default mask', async t => {
  const saved = fixture(), app = createApp(t, saved, { language: 'en', platform: 'win32' });
  const list = app.document.querySelector('[data-pane="0"] .list');
  list.focus();
  for (const letter of 'one') app.key(letter, {}, app.document.activeElement);
  assert.equal(app.state().panes[0].filter, 'one');
  openSendToTarget(app);
  app.click(menuButton(app, 'Move'));
  assert.equal(app.document.querySelector('#transfer-filter').value, '*.*');
  app.click(app.document.querySelector('#modal-confirm'));
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  assert.deepEqual(Array.from(prepare.source.ids), ['a']);
  post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: saved });
  await new Promise(resolve => setImmediate(resolve));
  const write = app.messages.find(message => message.type === 'filesystem-apply');
  assert.deepEqual(Array.from(write.transfer.ids), ['a']);
  assert.deepEqual(Array.from(write.state.folders['C:/two'], file => file.name), ['one.txt']);
  assert.deepEqual(Array.from(write.state.folders['C:/one'], file => file.name), ['two.txt']);
});

for (const [mode, label, ids] of [['copy', 'Copy', ['a']], ['move', 'Move', ['a', 'b']]]) {
  test(`Send to starts one ${mode} for the captured selection and waits for host acknowledgement`, async t => {
    const saved = fixture();
    saved.panes[0].selected = ids;
    const app = createApp(t, saved, { language: 'en', platform: 'win32' });
    openSendToTarget(app);
    app.click(menuButton(app, label));
    assert.equal(app.document.querySelector('#modal').open, true);
    assert.equal(app.document.querySelector('#modal-title').textContent, label);
    assert.match(app.document.querySelector('#value').value, /two$/);
    assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
    app.click(app.document.querySelector('#modal-confirm'));
    const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
    assert.equal(prepare.requiredDirectory, 'C:/two');
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
    post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: saved });
    await new Promise(resolve => setImmediate(resolve));
    const writes = app.messages.filter(message => message.type === 'filesystem-apply');
    assert.equal(writes.length, 1);
    const [write] = writes;
    assert.equal(write.transfer.mode, mode);
    assert.deepEqual(Array.from(write.transfer.ids), ids);
    assert.equal(write.state.folders['C:/two'].length, ids.length);
    const status = app.document.querySelector('#status-message');
    assert.doesNotMatch(status.textContent, /copied|moved/i);
    post(app, { type: 'filesystem-result', operationId: write.operationId, ok: true, state: structuredClone(write.state) });
    assert.match(status.textContent, mode === 'copy' ? /copied/i : /moved/i);
  });
}

test('Send to cannot write after its destination disappears during preparation', async t => {
  const saved = fixture(), app = createApp(t, saved, { language: 'en', platform: 'win32' });
  openSendToTarget(app);
  app.click(menuButton(app, 'Move'));
  app.click(app.document.querySelector('#modal-confirm'));
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  assert.equal(prepare.requiredDirectory, 'C:/two');
  post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: false, error: 'Folder unavailable', state: saved });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  assert.equal(app.state().folders['C:/one'].length, 2);
  app.click(app.document.querySelector('#modal-cancel'));
  openSendToTarget(app);
  app.click(menuButton(app, 'Copy'));
  app.click(app.document.querySelector('#modal-confirm'));
  assert.equal(app.messages.filter(message => message.type === 'filesystem-prepare').length, 2);
});

test('Send to shows the progress and cancel control for a destination outside both tabs', t => {
  const saved = fixture();
  const destination = 'C:/old';
  saved.folders[destination] = [];
  const app = createApp(t, saved, { language: 'en', platform: 'win32' });
  sendFavorites(app);
  context(app, app.row('one.txt'));
  for (const label of ['Send to', 'Old']) app.click(menuButton(app, label));
  app.click(menuButton(app, 'Copy'));
  app.click(app.document.querySelector('#modal-confirm'));
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  assert.equal(prepare.requiredDirectory, destination);
  assert.deepEqual(Array.from(app.state().panes, pane => pane.tabs[pane.tab]), ['C:/one', 'C:/two']);
  assert.ok(app.document.querySelector('#statusbar').dataset.footerJobId);
  assert.equal(app.document.querySelector('#statusbar').classList.contains('job-context-hidden'), false);
  const cancel = app.document.querySelector('#status-cancel');
  assert.equal(cancel.hidden, false);
  app.click(cancel);
  assert.equal(app.messages.find(message => message.type === 'filesystem-cancel').operationId, prepare.operationId);
  const cancellation = app.messages.find(message => message.type === 'transfer-trace' && message.event.stage === 'cancel-requested');
  assert.equal(cancellation?.event.origin, 'job-control');
  assert.equal(cancellation.event.operationId, prepare.operationId);
  post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, cancelled: true, state: saved });
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('Send to uses the usual conflict prompt and supports cancellation before a write', async t => {
  const saved = fixture();
  saved.folders['C:/two'] = [{ id: 'existing', name: 'one.txt', type: 'text', size: 2 }];
  const app = createApp(t, saved, { language: 'en', platform: 'win32' });
  openSendToTarget(app);
  app.click(menuButton(app, 'Copy'));
  app.click(app.document.querySelector('#modal-confirm'));
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: saved });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.document.querySelector('[data-conflict-action="overwrite"]'));
  app.click(app.document.querySelector('[data-conflict-action="cancel"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  assert.equal(app.state().folders['C:/two'][0].id, 'existing');
});

test('Send to rejects a captured source changed while preparing the destination', async t => {
  const saved = fixture(), app = createApp(t, saved, { language: 'en', platform: 'win32' });
  openSendToTarget(app);
  app.click(menuButton(app, 'Move'));
  app.click(app.document.querySelector('#modal-confirm'));
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  const refreshed = structuredClone(saved);
  refreshed.folders['C:/one'][0].size = 20;
  post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: refreshed });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('Send to reports that nothing was moved when all selected files are skipped', async t => {
  const saved = fixture();
  saved.folders['C:/two'] = [{ id: 'existing', name: 'one.txt', type: 'text', size: 2 }];
  const app = createApp(t, saved, { language: 'en', platform: 'win32' });
  openSendToTarget(app);
  app.click(menuButton(app, 'Move'));
  app.click(app.document.querySelector('#modal-confirm'));
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  post(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: saved });
  await new Promise(resolve => setImmediate(resolve));
  app.click(app.document.querySelector('[data-conflict-action="skip"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  assert.match(app.document.querySelector('#status-message').textContent, /No files or folders were moved.*1 skipped/i);
});

test('file delete popup confirms its captured selection and allows cancellation', t => {
  for (const language of ['de', 'en']) {
    const app = createApp(t, fixture(), { language });
    context(app, app.row('one.txt'));
    const remove = menu(app).querySelector('[data-context-action="delete"]');
    assert.ok(remove);
    assert.ok(remove.textContent.includes(language === 'de' ? 'Löschen' : 'Delete'));
    app.click(app.row('two.txt'));
    app.click(remove);
    assert.equal(app.document.querySelector('#modal').open, true);
    assert.match(app.document.querySelector('#modal-body').textContent, /one\.txt/);
    assert.doesNotMatch(app.document.querySelector('#modal-body').textContent, /two\.txt/);
    assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
    app.click(app.document.querySelector('#modal-cancel'));
    assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
    context(app, app.row('two.txt'));
    app.click(menu(app).querySelector('[data-context-action="delete"]'));
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    const request = app.messages.find(message => message.type === 'filesystem-delete');
    assert.deepEqual(Array.from(request.paths), ['C:/one/two.txt']);
    assert.equal(request.useTrash, true);
  }
});

test('delete context actions reject a changed tab', t => {
  const app = createApp(t, fixture());
  context(app, app.row('one.txt'));
  const remove = menu(app).querySelector('[data-context-action="delete"]');
  assert.ok(remove);
  app.action('next-tab'); app.click(remove);
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
});

test('context deletion uses nested search result paths instead of the search root', t => {
  const saved = fixture();
  saved.folders['C:/one/sub'] = [{ id: 'nested', name: 'nested.txt', type: 'text', fsSource: 'C:/one/sub/nested.txt', size: 1 }];
  saved.panes[0].tabStates = [{ path: 'C:/one', searchResult: { id: 'search', source: 'C:/one', paths: ['C:/one/sub/nested.txt'] } }, { path: 'C:/two' }];
  saved.panes[0].selected = ['nested']; saved.panes[0].cursor = 'nested';
  const app = createApp(t, saved);
  context(app, app.row('nested.txt'));
  app.click(menu(app).querySelector('[data-context-action="delete"]'));
  assert.equal(app.document.querySelector('#modal').open, true);
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(Array.from(app.messages.find(message => message.type === 'filesystem-delete').paths), ['C:/one/sub/nested.txt']);
});

test('context deletion sends an unloaded folder directly after confirmation', t => {
  const saved = fixture();
  saved.folders['C:/one'].push({ id: 'folder', name: 'folder', type: 'folder', fsSource: 'C:/one/folder' });
  saved.folders['C:/one/folder'] = []; saved.unloadedFolders = ['C:/one/folder'];
  const app = createApp(t, saved);
  context(app, app.row('folder'));
  app.click(menu(app).querySelector('[data-context-action="delete"]'));
  const submit = () => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  submit();
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  assert.deepEqual(Array.from(app.messages.find(message => message.type === 'filesystem-delete')?.paths || []), ['C:/one/folder']);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('menus omit sample-only and focus-only actions and the generic webview command collection', () => {
  const menus = require('../package.json').contributes.menus;
  for (const command of ['bitfroest.reset', 'bitfroest.help', 'bitfroest.filter', 'bitfroest.background-tab']) {
    assert.equal(menus['bitfroest.menu'].some(item => item.command === command), false, command);
  }
  assert.equal(menus['webview/context'].some(item => item.submenu === 'bitfroest.menu'), false);
  for (const command of ['bitfroest.reset', 'bitfroest.help']) assert.equal(menus.commandPalette.find(item => item.command === command).when, 'false');
});

test('address right-click and keyboard context show no menu while path text keeps native editing', t => {
  const app = createApp(t, fixture());
  for (const selector of ['[data-breadcrumb]', '[data-path-edit]', '.pathbar']) {
    const target = app.document.querySelector(selector);
    assert.equal(context(app, target).defaultPrevented, true);
    assert.equal(menu(app), null);
  }
  const crumb = app.document.querySelector('[data-breadcrumb]'); crumb.focus();
  app.key('F10', { shiftKey: true }, crumb);
  assert.equal(menu(app), null);
  const input = app.document.querySelector('.path-input');
  assert.equal(context(app, input).defaultPrevented, false);
});

test('file popup has one copy action, retains its captured selection and rejects stale actions', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  context(app, app.row('one.txt'));
  assert.equal(menu(app).querySelectorAll('[data-context-action="clipboard-copy"]').length, 1);
  const copy = menu(app).querySelector('[data-context-action="clipboard-copy"]');
  app.click(app.row('two.txt'));
  app.click(copy);
  assert.deepEqual(Array.from(app.messages.find(message => message.type === 'clipboard-write').paths), ['C:/one/one.txt']);
  context(app, app.row('two.txt'));
  const stale = menu(app).querySelector('[data-context-action="clipboard-copy"]');
  app.action('next-tab'); app.click(stale);
  assert.equal(app.messages.filter(message => message.type === 'clipboard-write').length, 1);
});

test('context popup supports keyboard dismissal, background paste, columns and native text editing', t => {
  const app = createApp(t, fixture());
  const list = app.document.querySelector('.pane.active .list'); list.focus();
  app.key('ContextMenu', {}, list);
  assert.ok(menu(app));
  const first = app.document.activeElement;
  app.key('ArrowDown', {}, first);
  assert.notEqual(app.document.activeElement, first);
  app.key('Escape'); assert.equal(menu(app), null); assert.equal(app.document.activeElement, list);
  context(app, list);
  assert.deepEqual([...menu(app).querySelectorAll('[data-context-action]')].map(item => item.dataset.contextAction), ['clipboard-paste']);
  assert.equal(menu(app).querySelector('button').disabled, true);
  context(app, list.querySelector('.ag-header-cell'));
  assert.ok(menu(app).querySelector('[data-context-action="configure-columns"]'));
  const input = app.document.querySelector('.path-input');
  assert.equal(context(app, input).defaultPrevented, false);
  assert.equal(menu(app), null);
});

test('context shortcut hints follow overrides and retain keycaps', t => {
  const app = createApp(t, fixture());
  const catalog = require('../media/bitfroest-shortcuts').createCatalog(require('../package.json'));
  const entry = catalog.find(item => item.command === 'bitfroest.clipboard-copy');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'shortcut-settings', catalog, bindings: { [entry.id]: 'ctrl+shift+k' } } }));
  context(app, app.row('one.txt'));
  assert.deepEqual([...menu(app).querySelectorAll('[data-context-action="clipboard-copy"] kbd')].map(cap => cap.textContent), ['Strg', 'Umschalt', 'K']);
});

test('right-click close targets the clicked inactive tab and popup scrolling remains usable', t => {
  const app = createApp(t, fixture());
  context(app, app.document.querySelector('[data-pane="0"] [data-tab="1"]'));
  const popup = menu(app);
  app.click(popup.querySelector('[data-context-action="close-tab"]'));
  assert.deepEqual(app.state().panes[0].tabs, ['C:/one']);
  context(app, app.row('one.txt'));
  const scrolling = menu(app);
  scrolling.querySelector('[role="menu"]').dispatchEvent(new app.window.Event('scroll'));
  assert.equal(menu(app), scrolling);
});

test('Linux Shift+F10 uses the same popup even with the system menu setting enabled', t => {
  const app = createApp(t, fixture(), { platform: 'linux', fileSettings: { useSystemContextMenu: true } });
  const list = app.document.querySelector('.pane.active .list'); list.focus();
  app.key('F10', { shiftKey: true }, list);
  assert.ok(menu(app)?.querySelector('[data-context-action="clipboard-copy"]'));
});

test('inactive tab path copy uses its target and swapping panes invalidates an open file action', t => {
  const app = createApp(t, fixture());
  context(app, app.document.querySelector('[data-pane="0"] [data-tab="1"]'));
  app.click(menu(app).querySelector('[data-context-action="copy-path"]'));
  assert.equal(app.messages.find(message => message.type === 'selection-io').text, 'C:\\two');
  context(app, app.document.querySelector('[data-pane="0"] [data-tab="0"]'));
  const copy = menu(app).querySelector('[data-context-action="copy-path"]');
  app.action('swap'); app.click(copy);
  assert.equal(app.messages.filter(message => message.type === 'selection-io').length, 1);
});

test('file clipboard contributions are limited to file contexts', () => {
  const items = require('../package.json').contributes.menus['webview/context'];
  for (const action of ['copy', 'cut', 'paste']) {
    const condition = items.find(item => item.command === `bitfroest.clipboard-${action}`).when;
    assert.match(condition, /webviewSection == files/);
    assert.match(condition, /webviewSection == folder/);
    assert.equal(condition.includes('webviewSection == fileBackground'), action === 'paste');
    assert.doesNotMatch(condition, /webviewSection !=/);
  }
});
