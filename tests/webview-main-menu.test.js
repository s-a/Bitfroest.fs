const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('Help opens license acknowledgements by mouse and keyboard without changing the file lists', t => {
  for (const language of ['de', 'en']) for (const key of [null, 'Enter', ' ']) {
    const app = createApp(t, undefined, { language });
    const menu = app.document.querySelector('[data-main-menu]');
    const help = [...menu.querySelectorAll(':scope > button')].at(-1);
    app.click(help);
    const entry = menu.querySelector('[data-menu-action="licenses"]');
    assert.ok(entry, 'Help contains the active license entry');
    assert.equal(entry.hidden, false);
    assert.notEqual(entry.getAttribute('aria-disabled'), 'true');
    assert.equal(entry.textContent.trim(), language === 'de' ? 'Lizenzen und Danksagungen' : 'Licenses and acknowledgements');
    const before = JSON.stringify(app.state());
    const messages = app.messages.length;
    if (key) { entry.focus(); app.key(key, {}, entry); } else app.click(entry);
    assert.equal(menu.querySelector('[role="menu"]').hidden, true);
    assert.equal(app.document.activeElement, help);
    assert.deepEqual(JSON.parse(JSON.stringify(app.messages.slice(messages).filter(message => message.type !== 'inputFocus'))), [{ type: 'show-licenses' }]);
    assert.equal(JSON.stringify(app.state()), before);
  }
});

test('mock application menu opens, navigates with arrows, and closes without dispatching actions', t => {
  const app = createApp(t);
  const menu = app.document.querySelector('[data-main-menu]');
  assert.ok(menu);
  assert.equal(menu.getAttribute('role'), 'menubar');
  const trigger = menu.querySelector('[role="menuitem"]');
  app.click(trigger);
  const popup = app.document.querySelector('[role="menu"]');
  assert.equal(popup.hidden, false);
  assert.equal(popup.getAttribute('aria-label'), 'Dateien (Mock)');
  assert.match(popup.textContent, /Mock/);
  assert.equal(app.document.activeElement, popup.querySelector('[role="menuitem"]'));
  app.key('ArrowDown', {}, app.document.activeElement);
  assert.equal(app.document.activeElement, popup.querySelectorAll('[role="menuitem"]')[1]);
  const copy = [...popup.querySelectorAll('[role="menuitem"]')].find(item => !item.hidden && item.textContent.includes('Kopieren'));
  assert.equal(copy.getAttribute('aria-disabled'), 'true');
  app.click(copy);
  assert.equal(app.document.activeElement, copy);
  app.key('Escape', {}, app.document.activeElement);
  assert.equal(popup.hidden, true);
  assert.equal(app.document.activeElement, trigger);
  assert.equal(app.messages.some(message => ['copy', 'move', 'delete', 'rename'].includes(message.type)), false);
  app.click(menu.querySelectorAll('[aria-haspopup="true"]')[menu.querySelectorAll('[aria-haspopup="true"]').length - 1]);
  assert.equal(popup.querySelector('[data-group="Hilfe"]').hidden, false);
  assert.equal(popup.querySelector('[data-group="Konfigurieren"]').hidden, true);
});

test('menu focus contains file shortcuts and shows only the active category rows', t => {
  const app = createApp(t);
  const trigger = app.document.querySelector('[data-main-menu] [aria-haspopup="true"]');
  trigger.focus();
  const open = new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  trigger.dispatchEvent(open);
  assert.equal(open.defaultPrevented, true);
  const popup = app.document.querySelector('[role="menu"]');
  assert.equal(popup.hidden, false);
  assert.equal(app.document.activeElement, popup.querySelector('[data-group="Dateien"]'));
  assert.equal(app.window.getComputedStyle(popup.querySelector('[data-group="Hilfe"]')).display, 'none');
  const initialState = JSON.stringify(app.state());
  const initialMessages = app.messages.length;
  for (const key of ['F5', 'Delete', 'Insert', 'ContextMenu']) {
    let bubbled = false;
    const observe = () => { bubbled = true; };
    app.document.addEventListener('keydown', observe, { once: true });
    const event = new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    app.document.activeElement.dispatchEvent(event);
    assert.equal(bubbled, false, `${key} stays inside the menu`);
    assert.equal(event.defaultPrevented, true, `${key} is consumed`);
  }
  assert.equal(app.document.querySelector('dialog').open, false);
  assert.equal(JSON.stringify(app.state()), initialState);
  assert.equal(app.messages.length, initialMessages);
  for (const key of ['ArrowUp', 'Enter', ' ']) {
    trigger.focus();
    const event = new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(app.document.activeElement, popup.querySelector('[data-group="Dateien"]'));
    app.key('Escape', {}, app.document.activeElement);
  }
  trigger.focus();
  app.key('ArrowDown', {}, trigger);
  let tabBubbled = false;
  app.document.addEventListener('keydown', () => { tabBubbled = true; }, { once: true });
  const tab = new app.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  app.document.activeElement.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(tabBubbled, false);
  assert.equal(popup.hidden, true);
});
