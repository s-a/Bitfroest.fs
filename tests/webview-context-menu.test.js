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
  const catalog = require('../media/commander-shortcuts').createCatalog(require('../package.json'));
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
