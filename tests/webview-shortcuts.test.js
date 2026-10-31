const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const { catalog } = require('../shortcut-settings');
const copy = catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
test('custom shortcut replaces the old DOM binding and preserves text input', t => {
  const app = createApp(t);
  app.click(app.row('README.md').querySelector('[data-filename]'));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'shortcut-settings', catalog, bindings: { [copy.id]: 'ctrl+shift+k' } } }));
  app.document.querySelector('.list').focus();
  app.key('F5'); assert.equal(app.document.querySelector('#modal').open, false);
  app.key('k', { ctrlKey: true, shiftKey: true });
  assert.equal(app.messages.filter(message => message.type === 'shortcut-execute').length, 1);
  assert.equal(app.messages.at(-1).id, copy.id);
  app.document.querySelector('.path-input').focus(); app.key('k', { ctrlKey: true, shiftKey: true });
  assert.equal(app.messages.filter(message => message.type === 'shortcut-execute').length, 1);
});
test('restoring defaults restores key behavior and removes custom menu hints', t => {
  const app = createApp(t);
  app.click(app.row('README.md').querySelector('[data-filename]'));
  const rename = catalog.find(item => item.command === 'bitfroest.rename');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'shortcut-settings', catalog, bindings: { [rename.id]: 'ctrl+shift+k' } } }));
  const menu = app.document.querySelector('[data-menu-action="rename"]');
  assert.match(menu.getAttribute('aria-keyshortcuts'), /Control\+Shift\+K/);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'shortcut-settings', catalog, bindings: {} } }));
  assert.match(menu.getAttribute('aria-keyshortcuts'), /Control\+M/);
  app.document.querySelector('.list').focus(); app.key('F5');
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('local pane switching is remapped once without forwarding a host command', t => {
  const app = createApp(t), pane = catalog.find(item => item.id === 'localpane');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'shortcut-settings', catalog, bindings: { [pane.id]: 'ctrl+shift+k' } } }));
  app.document.querySelector('.list').focus();
  const before = app.state().active;
  app.key('Tab'); assert.equal(app.state().active, before);
  app.key('k', { ctrlKey: true, shiftKey: true }); assert.equal(app.state().active, 1 - before);
  assert.equal(app.messages.some(message => message.type === 'shortcut-execute'), false);
});
