const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function reply(app, request, result) {
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'lister-result', requestId: request.requestId, ok: true, ...result } }));
}
const view = { text: 'first\nneedle\nlast\n', map: Array.from({ length: 19 }, (_, i) => i), offset: 0, next: 18, previous: 0, size: 18, mode: 'text', encoding: 'utf-8' };
function realApp(t, size = 100000) {
  const pane = path => ({ tabs: [path], tab: 0, filter: '', sort: 'name', descending: false, cursor: 'a', selected: ['a'] });
  const state = { version: 1, realFilesystem: true, active: 0, snapshotId: 'one', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'file.txt', type: 'text', fsSource: 'C:/tmp/file.txt', size }], 'C:/temp': [] } };
  const app = createApp(t, state); app.key('F3');
  const request = app.messages.find(message => message.type === 'lister-open');
  reply(app, request, { id: 'session', size, view: { text: 'abc', map: [0, 1, 2, 3], ends: [1, 2, 3], lines: [0], offset: 0, next: 3, previous: 0, size, mode: 'text', encoding: 'utf-8' } });
  return app;
}

test('F3 replaces only the initiating list, changes menus by focus, and Escape restores selection and scroll', t => {
  const app = createApp(t);
  const original = app.row('README.md'); app.click(original);
  const state = JSON.stringify(app.state().panes);
  const list = app.document.querySelector('.pane.active .list'); list.scrollTop = 125;
  app.key('F3');
  assert.ok(app.document.querySelector('.pane.active [data-lister]'));
  assert.equal(app.document.querySelectorAll('.pane .list').length, 1);
  assert.equal(app.messages.some(message => message.type === 'preview'), false);
  assert.match(app.document.querySelector('[data-main-menu]').textContent, /Bearbeiten/);
  app.document.querySelector('.pane:not(.active) .list').focus();
  assert.match(app.document.querySelector('[data-main-menu]').textContent, /Dateien/);
  app.document.querySelector('[data-lister] textarea').focus();
  app.key('Escape');
  assert.equal(app.document.querySelector('[data-lister]'), null);
  assert.equal(app.document.querySelector('.pane.active .list').scrollTop, 125);
  const restored = app.state().panes;
  const before = JSON.parse(state);
  assert.deepEqual(restored.map(p => p.selected), before.map(p => p.selected));
  assert.ok(app.document.activeElement.matches('.list'));
});

test('real lister ignores late replies after Escape and never sends content to a text editor', t => {
  const state = { version: 1, realFilesystem: true, active: 0, snapshotId: 'one', panes: [{ tabs: ['C:/tmp'], tab: 0, cursor: 'a', selected: ['a'] }, { tabs: ['C:/temp'], tab: 0 }], folders: { 'C:/tmp': [{ id: 'a', name: 'huge.bin', type: 'text', fsSource: 'C:/tmp/huge.bin', size: 8 * 2 ** 30 }], 'C:/temp': [] } };
  for (const pane of state.panes) Object.assign(pane, { filter: '', sort: 'name', descending: false });
  const app = createApp(t, state);
  app.key('F3');
  const request = app.messages.find(message => message.type === 'lister-open');
  assert.equal(request.path, 'C:/tmp/huge.bin');
  app.key('Escape');
  reply(app, request, { id: 'session-1', size: 18, view });
  assert.equal(app.document.querySelector('[data-lister]'), null);
  assert.ok(app.messages.some(message => message.type === 'lister-close' && message.id === 'session-1'));
  assert.equal(app.messages.some(message => message.type === 'preview' || message.type === 'edit'), false);
});

test('lister modes, search, whole-file selection and copying use lister actions instead of file operations', t => {
  const app = createApp(t);
  app.click(app.row('README.md')); app.key('F3');
  const surface = app.document.querySelector('[data-lister] textarea');
  assert.ok(surface.readOnly);
  app.key('3', {}, surface);
  assert.match(surface.value, /[0-9A-F]{8} {2}/);
  app.key('1', {}, surface);
  app.key('F6', {}, surface);
  assert.equal(surface.dataset.cursor, 'true');
  app.key('f', { ctrlKey: true }, surface);
  assert.ok(app.document.querySelector('dialog').open);
  assert.ok(app.document.querySelector('[data-lister-search]'));
  app.document.querySelector('#modal-cancel').click();
  surface.focus(); app.key('a', { ctrlKey: true }, surface);
  app.key('c', { ctrlKey: true }, surface);
  assert.equal(app.document.querySelector('dialog').open, false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare' || message.type === 'clipboard-write'), false);
  const menu = app.document.querySelector('[data-main-menu]');
  assert.doesNotMatch(menu.textContent, /Multimedia|Explorer|Plugins|Position speichern|Konfigurieren/);
});

test('selecting exactly one hex byte copies that byte and lister reports its native focus context', t => {
  const app = createApp(t);
  app.click(app.row('README.md')); app.key('F3');
  const area = app.document.querySelector('[data-lister] textarea');
  assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).lister, true);
  app.key('3', {}, area);
  const index = area.value.indexOf('  ') + 2;
  area.setSelectionRange(index, index + 2);
  area.dispatchEvent(new app.window.MouseEvent('mouseup', { bubbles: true }));
  app.key('c', { ctrlKey: true }, area);
  assert.equal(app.messages.filter(message => message.type === 'lister-demo-copy').at(-1)?.text, '#');
});

test('a collapsed mouse selection clears the logical range and native lister actions keep file operations isolated', t => {
  const app = createApp(t); app.click(app.row('README.md')); app.key('F3');
  const area = app.document.querySelector('[data-lister] textarea');
  app.key('a', { ctrlKey: true }, area);
  area.setSelectionRange(1, 1); area.dispatchEvent(new app.window.MouseEvent('mouseup', { bubbles: true }));
  app.key('c', { ctrlKey: true }, area);
  assert.equal(app.messages.some(message => message.type === 'lister-demo-copy'), false);
  app.action('lister:mode:hex');
  assert.match(area.value, /[0-9A-F]{8} {2}/);
  app.action('lister:escape');
  assert.equal(app.document.querySelector('[data-lister]'), null);
});

test('scope restoration discards lister sessions while ordinary panel focus preserves the view', t => {
  const app = createApp(t); app.click(app.row('README.md')); app.key('F3');
  const area = app.document.querySelector('[data-lister] textarea');
  app.key('3', {}, area); const text = area.value;
  app.window.dispatchEvent(new app.window.Event('focus'));
  assert.equal(area.value, text);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', resetViews: true, state: app.state() } }));
  assert.equal(app.document.querySelector('[data-lister]'), null);
});

test('native lister keybindings are limited to its focus and saved codepages use a native settings table', () => {
  const manifest = require('../package.json');
  const keys = manifest.contributes.keybindings.filter(item => item.command === 'bitfroest.lister-action');
  assert.ok(keys.some(item => item.key === 'escape'));
  assert.ok(keys.some(item => item.key === 'ctrl+shift+c'));
  assert.ok(keys.every(item => item.when.includes('bitfroest.listerFocus') && item.when.includes('webviewFocus') && item.when.includes('!bitfroest.textInput')));
  const settings = Object.assign({}, ...manifest.contributes.configuration.map(item => item.properties));
  assert.equal(settings['bitfroest.lister.codepages'].additionalProperties.type, 'integer');
});

test('whole file selection survives keyup with text cursor enabled and buttons retain normal keyboard behavior', t => {
  const app = realApp(t), area = app.document.querySelector('.lister textarea');
  app.key('F6', {}, area); app.key('a', { ctrlKey: true }, area);
  area.dispatchEvent(new app.window.KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }));
  app.key('c', { ctrlKey: true }, area);
  assert.equal(app.messages.filter(message => message.type === 'lister-copy').at(-1).settings.end, 100000);
  const button = app.document.querySelector('[data-lister-close]'); button.focus();
  const space = new app.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }); button.dispatchEvent(space);
  assert.equal(space.defaultPrevented, false);
});

test('jumping to the file end reveals the last loaded line rather than the start of the final window', t => {
  const app = realApp(t), area = app.document.querySelector('.lister textarea');
  Object.defineProperty(area, 'scrollHeight', { value: 2000, configurable: true });
  app.key('End', { ctrlKey: true }, area);
  const request = app.messages.filter(message => message.type === 'lister-read').at(-1);
  reply(app, request, { view: { ...view, offset: 99982, next: 100000, size: 100000 } });
  assert.equal(area.scrollTop, 2000);
});

test('cursor selection extends across loaded windows without losing its original byte anchor', t => {
  const app = realApp(t), area = app.document.querySelector('.lister textarea');
  app.key('F6', {}, area);
  area.setSelectionRange(0, 3); area.dispatchEvent(new app.window.MouseEvent('mouseup', { bubbles: true }));
  app.key('ArrowRight', { shiftKey: true }, area);
  const request = app.messages.filter(message => message.type === 'lister-read').at(-1);
  assert.equal(request?.settings.position, 3);
  reply(app, request, { view: { text: 'def', map: [3, 4, 5, 6], ends: [4, 5, 6], lines: [3], offset: 3, next: 6, previous: 0, size: 100000, mode: 'text', encoding: 'utf-8' } });
  area.dispatchEvent(new app.window.KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  app.key('c', { ctrlKey: true }, area);
  const copy = app.messages.filter(message => message.type === 'lister-copy').at(-1);
  assert.equal(copy.settings.start, 0); assert.equal(copy.settings.end, 4);
});

test('Escape returns to the file list immediately even while a search is running', t => {
  const app = realApp(t), area = app.document.querySelector('.lister textarea');
  app.key('F7', {}, area);
  app.document.querySelector('#lister-query').value = 'missing';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(app.messages.some(message => message.type === 'lister-search'));
  app.key('Escape', {}, area);
  assert.equal(app.document.querySelector('.lister'), null);
  assert.ok(app.messages.some(message => message.type === 'lister-cancel' && message.id === 'session'));
  assert.ok(app.document.activeElement.matches('.list'));
});
