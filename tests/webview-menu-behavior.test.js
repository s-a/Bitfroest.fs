const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
const hover = (app, item) => item.dispatchEvent(new app.window.MouseEvent('mouseenter'));

test('popup labels share the compact menu typography and mapped font icons', t => {
  const app = createApp(t);
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  const bar = app.document.querySelector('[data-main-menu]'), popup = app.document.querySelector('#main-menu-popup');
  assert.equal(app.window.getComputedStyle(popup).fontSize, app.window.getComputedStyle(bar).fontSize);
  assert.equal(app.window.getComputedStyle(popup).fontFamily, app.window.getComputedStyle(bar).fontFamily);
  const popupRule = [...style.sheet.cssRules].find(rule => rule.selectorText?.includes('.main-menu [role="menu"], .menu-surface'));
  assert.match(popupRule.style.minWidth, /100vw/);
  const search = popup.querySelector('[data-menu-action="search"]');
  assert.ok(search.querySelector('[data-menu-icon].codicon-search'));
  assert.equal(search.querySelector('[data-menu-icon]').getAttribute('aria-hidden'), 'true');
  assert.ok(search.querySelector('.menu-shortcuts'));
});

test('popup placement opens upward at the bottom and constrains oversized menus', t => {
  const app = createApp(t); app.click(app.document.querySelector('[data-favorites]'));
  const popup = app.document.querySelector('[data-favorite-menu]');
  Object.defineProperty(app.window, 'innerWidth', { value: 300 }); Object.defineProperty(app.window, 'innerHeight', { value: 180 });
  popup.getBoundingClientRect = () => ({ width: 180, height: 120 });
  app.window.CommanderMenus.place(popup, { x: 290, y: 170 });
  assert.equal(popup.style.left, '116px'); assert.equal(popup.style.top, '50px'); assert.equal(popup.dataset.vertical, 'up');
  popup.getBoundingClientRect = () => ({ width: 800, height: 700 });
  app.window.CommanderMenus.place(popup, { x: 290, y: 170 });
  assert.equal(popup.style.left, '4px'); assert.equal(popup.style.top, '4px'); assert.equal(popup.style.maxHeight, '172px'); assert.equal(popup.style.maxWidth, '292px');
});

test('Lister menus use the same hover switching and font icons without changing the preview', t => {
  const app = createApp(t); app.click(app.row('README.md')); app.action('view');
  const bar = app.document.querySelector('[data-main-menu][data-lister]'), heads = [...bar.querySelectorAll(':scope > button')];
  const popup = bar.querySelector('[role="menu"]'), focused = app.document.activeElement;
  hover(app, heads[1]); assert.equal(popup.hidden, true); assert.equal(app.document.activeElement, focused);
  app.click(heads[0]); hover(app, heads[1]); assert.equal(heads[1].getAttribute('aria-expanded'), 'true');
  const wrap = popup.querySelector('[data-lister-command="wrap"]'), checked = wrap.getAttribute('aria-checked');
  hover(app, wrap); assert.equal(wrap.getAttribute('aria-checked'), checked); assert.ok(wrap.querySelector('[data-menu-icon].codicon-word-wrap'));
});

test('hover switches only an open menu and highlights leaves without executing them', t => {
  const app = createApp(t);
  const popup = app.document.querySelector('#main-menu-popup'), heads = [...app.document.querySelectorAll('[data-main-menu] > button')];
  const focused = app.document.activeElement;
  hover(app, heads[1]); assert.equal(popup.hidden, true);
  assert.equal(app.document.activeElement, focused);
  app.click(heads[0]); hover(app, heads[1]);
  assert.equal(heads[0].getAttribute('aria-expanded'), 'false');
  assert.equal(heads[1].getAttribute('aria-expanded'), 'true');
  const before = JSON.stringify(app.state().panes);
  const select = popup.querySelector('[data-menu-action="select-all"]'); hover(app, select);
  assert.equal(app.document.activeElement, select);
  assert.equal(JSON.stringify(app.state().panes), before);
});

test('favorite children cascade on hover, flip at the right edge and keep their parent menu', t => {
  const app = createApp(t);
  const destination = app.state().panes[0].tabs[0];
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'favorite-settings', settings: { entries: { item: destination }, items: [
    { id: 'group', type: 'group', name: 'Projects', parent: null },
    { id: 'nested', type: 'group', name: 'Nested', parent: 'group' },
    { id: 'item', type: 'favorite', name: 'Work', path: destination, parent: 'nested' }
  ] } } }));
  app.click(app.document.querySelector('[data-favorites]'));
  const root = app.document.querySelector('[data-favorite-menu]'), group = root.querySelector('[data-favorite-group]');
  assert.ok(group.querySelector('[data-submenu-arrow]'));
  Object.defineProperty(app.window, 'innerWidth', { value: 300, configurable: true });
  Object.defineProperty(app.window, 'innerHeight', { value: 180, configurable: true });
  const original = app.window.HTMLElement.prototype.getBoundingClientRect;
  app.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.getAttribute('role') === 'menu' ? { width: 180, height: 100, left: 0, top: 0, right: 180, bottom: 100 } : original.call(this);
  };
  group.getBoundingClientRect = () => ({ left: 190, right: 280, top: 140, bottom: 162, width: 90, height: 22 });
  hover(app, group);
  const child = root.querySelector('[data-menu-submenu]'); assert.ok(child);
  assert.equal(group.getAttribute('aria-expanded'), 'true');
  assert.equal(child.dataset.direction, 'left');
  assert.equal(child.style.left, '11px');
  assert.ok(Number.parseFloat(child.style.top) + 100 <= 180);
  assert.ok(root.querySelector('[data-favorite-configure]'));
  const nested = child.querySelector('[data-favorite-group]');
  app.key('ArrowRight', {}, nested);
  assert.equal(app.document.activeElement.textContent.trim(), 'Work');
  app.key('ArrowLeft'); assert.equal(app.document.activeElement, nested);
  assert.equal(app.document.querySelector('[data-favorite-back]'), null);
});

test('context menu child actions have arrows and keep their captured selection', t => {
  const p = () => ({ tabs: ['/repo'], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'menus', active: 0, panes: [p(), p()], folders: { '/repo': [{ id: 'a', name: 'a.txt', type: 'text' }] } });
  const request = app.messages.find(message => message.type === 'git-status');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/repo': { ok: true, repository: true, branch: 'main', statuses: { 'a.txt': 'modified' } } } } }));
  app.row('a.txt').dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const group = app.document.querySelector('[data-context-action="git"]'); assert.ok(group);
  hover(app, group);
  const diff = app.document.querySelector('[data-context-action="git-diff"]'); assert.ok(diff);
  assert.ok(diff.querySelector('[data-menu-icon]'));
  app.click(diff);
  assert.equal(app.messages.filter(message => message.type === 'git-diff').at(-1).ids[0], 'a');
  assert.equal(app.document.querySelector('[data-context-menu]'), null);
});
