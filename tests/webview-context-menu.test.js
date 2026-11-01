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
  context(app, list.querySelector('th'));
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
