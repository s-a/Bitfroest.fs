const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createConfigurationEditor } = require('../configuration-editor');
const { catalog } = require('../media/commander-column-settings');

async function setup(t, overrides = {}) {
  const saved = [], panels = [], context = { extensionUri: { fsPath: path.resolve(__dirname, '..') }, subscriptions: [] };
  let values = { favorites: [], columns: catalog.map(item => ({ ...item })) };
  const vscode = { ViewColumn: { Active: -1 }, Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }, window: {
    createWebviewPanel(type, title, column, options) {
      let handler, disposed;
      const panel = { type, title, options, messages: [], reveal() {}, onDidDispose(callback) { disposed = callback; }, dispose() { disposed?.(); }, webview: { cspSource: 'webview-resource:', asWebviewUri: uri => `webview-resource:${uri.fsPath}`, onDidReceiveMessage(callback) { handler = callback; }, async postMessage(message) { panel.messages.push(message); } }, receive: message => handler(message) };
      panels.push(panel); return panel;
    }
  } };
  const editor = createConfigurationEditor(vscode, context, { read: () => values, write: async (value, scope) => { await overrides.beforeWrite?.(); if (overrides.error) throw new Error(overrides.error); saved.push({ value, scope }); values = value; }, browse: overrides.browse || (async () => 'C:/chosen'), language: () => overrides.language || 'en', t: text => text, workspace: () => true });
  editor.open('favorites'); const panel = panels[0];
  const dom = new JSDOM(panel.webview.html, { url: 'https://configuration.invalid/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const messages = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  for (const name of ['commander-paths', 'commander-i18n', 'commander-column-settings', 'commander-shortcuts', 'shortcut-configuration', 'configuration-model', 'icon-font-metrics', 'commander-icons', 'configuration-view']) new vm.Script(fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', `${name}.js`), 'utf8')).runInContext(dom.getInternalVMContext());
  const flush = async () => { while (messages.length) await panel.receive(messages.shift()); while (panel.messages.length) { const message = panel.messages.shift(); if (overrides.platform) message.platform = overrides.platform; dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })); } };
  await flush();
  return { editor, panels, panel, window: dom.window, document: dom.window.document, saved, flush, external: value => { values = value; }, change: (selector, value) => { const element = dom.window.document.querySelector(selector); element.value = value; element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }, click: selector => { const element = dom.window.document.querySelector(selector); assert.ok(element, selector); element.click(); }, input: (selector, value) => { const element = dom.window.document.querySelector(selector); element.value = value; element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); } };
}

test('configuration tree icons use the central output and local font policy', async t => {
  const app = await setup(t);
  app.click('[data-add-group]'); app.click('[data-add-favorite]');
  for (const row of app.document.querySelectorAll('.tree-row')) assert.ok(row.querySelector('[data-icon-reviewed]'));
  assert.match(app.panel.webview.html, /font-src webview-resource:/);
});

test('unsupported content columns are disabled on Linux while portable metadata remains selectable', async t => {
  const app = await setup(t, { platform: 'linux' }); app.click('[data-section="columns"]');
  for (const id of ['archive', 'system', 'compressed', 'encrypted', 'sparse', 'offline', 'dosName']) {
    const input = app.document.querySelector(`[data-column-row="${id}"] [data-visible]`);
    assert.ok(input, id); assert.equal(input.disabled, true); assert.equal(input.checked, false);
    input.checked = true; input.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    assert.equal(input.checked, false);
  }
  for (const id of ['comment', 'versionString', 'readOnly', 'hidden', 'directory', 'fileType', 'attributeText']) assert.equal(app.document.querySelector(`[data-column-row="${id}"] [data-visible]`).disabled, false);
});

test('settings keep navigation and save actions outside the scrolling content', async t => {
  const app = await setup(t);
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.resolve(__dirname, '../media/configuration.css'), 'utf8'); app.document.head.append(style);
  const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
  assert.match(app.panel.webview.html, /default-src 'none'/);
  assert.match(app.document.querySelector('link[rel="stylesheet"]').href, /configuration\.css$/);
  assert.equal(computed('body').display, 'grid');
  assert.equal(computed('body').overflow, 'hidden');
  assert.equal(parseFloat(computed('.settings-layout').minHeight), 0);
  assert.equal(computed('main').overflow, 'auto');
  assert.equal(computed('.settings-sidebar').overflow, 'auto');
  assert.equal(computed('footer').position, 'sticky');
  assert.equal(computed('footer').bottom, '0px');
  assert.equal(app.document.querySelector('main footer'), null);
  app.click('[data-section="shortcuts"]');
  assert.equal(computed('#shortcuts-section .table-container').maxHeight, 'none');
  const content = app.document.querySelector('main'); content.scrollTop = 320;
  content.dispatchEvent(new app.window.Event('scroll'));
  assert.equal(app.document.querySelector('footer [data-save]').hidden, false);
  app.click('[data-section="favorites"]'); app.click('[data-add-group]'); app.input('#favorite-name', 'Compact settings');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[0].value.favorites[0].name, 'Compact settings');
});

test('settings use compact forms and hide empty messages without hiding actual errors', async t => {
  const app = await setup(t);
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.resolve(__dirname, '../media/configuration.css'), 'utf8'); app.document.head.append(style);
  const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
  assert.equal(computed('#configuration-error').display, 'none');
  app.click('[data-add-favorite]');
  assert.ok(parseFloat(computed('#favorite-details').gap) <= 10);
  assert.ok(parseFloat(computed('[data-directory-fields]').gap) <= 10);
  assert.equal(computed('#favorite-name').minHeight, computed('[data-browse="path"]').minHeight);
  app.document.querySelector('#configuration-error').textContent = 'Write failed';
  assert.notEqual(computed('#configuration-error').display, 'none');
  const responsive = [...style.sheet.cssRules].find(rule => rule.conditionText === '(max-width: 650px)');
  assert.ok(responsive);
  assert.ok([...responsive.cssRules].some(rule => rule.selectorText === '.settings-layout' && rule.style.getPropertyValue('grid-template-columns') === 'minmax(0, 1fr)'));
});

test('configuration editor creates nested favorites with fields and discards unsaved changes', async t => {
  const app = await setup(t);
  assert.match(app.panel.webview.html, /default-src 'none'/);
  assert.match(app.panel.webview.html, /script-src 'nonce-/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(app.panel.webview.html)[1];
  for (const script of app.document.querySelectorAll('script')) { assert.equal(script.getAttribute('nonce'), nonce); assert.match(script.src, /^webview-resource:/); }
  app.click('[data-add-group]'); app.input('#favorite-name', 'Projects');
  app.click('[data-add-group]'); app.input('#favorite-name', 'Archive');
  app.click('[data-add-favorite]'); app.input('#favorite-name', 'Work'); app.input('#favorite-path', 'C:/work');
  assert.equal(app.document.querySelectorAll('[role="treeitem"]').length, 3);
  app.click('[data-save]'); await app.flush();
  const nodes = app.saved[0].value.favorites;
  assert.equal(nodes[1].parent, nodes[0].id); assert.equal(nodes[2].parent, nodes[1].id);
  app.input('#favorite-name', 'Discard me'); app.click('[data-discard]'); await app.flush();
  assert.equal(app.document.querySelector('#favorite-name').value, 'Projects');
});

test('shortcut table omits the status column and retains its general verification notice', async t => {
  const app = await setup(t);
  app.editor.open('shortcuts'); await app.flush();
  const section = app.document.querySelector('#shortcuts-section');
  assert.deepEqual([...section.querySelectorAll('th')].map(cell => cell.textContent), ['Command', 'Keyboard shortcut', 'Context', 'Source', 'Actions']);
  for (const row of section.querySelectorAll('[data-shortcut-row]')) {
    assert.equal(row.cells.length, 5);
    assert.ok(row.cells[4].querySelector('[data-shortcut-edit]'));
    assert.doesNotMatch(row.textContent, /External bindings unverified/);
  }
  assert.match(section.querySelector('p').textContent, /External bindings and reserved system keys are unverified/);
});

test('shortcut capture reports conflicts immediately and clears them when the candidate changes', async t => {
  const app = await setup(t);
  app.editor.open('shortcuts'); await app.flush();
  const row = app.document.querySelector('[data-command="bitfroest.copy"][data-default-key="f5"]');
  row.querySelector('[data-shortcut-edit]').click();
  const capture = app.document.querySelector('#shortcut-capture');
  capture.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
  assert.match(app.document.querySelector('#shortcut-capture-error').textContent, /F6.*Move/);
  assert.equal(app.document.querySelector('#shortcut-dialog').open, true);
  assert.equal(app.saved.length, 0);
  assert.equal(row.cells[1].textContent, 'F5');
  capture.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(app.document.querySelector('#shortcut-capture-error').textContent, '');
  app.click('[data-shortcut-cancel]');
  assert.equal(app.saved.length, 0);
});

test('shortcut editor captures keys, reports collisions, saves and restores defaults', async t => {
  const app = await setup(t);
  app.editor.open('shortcuts'); await app.flush();
  const section = app.document.querySelector('#shortcuts-section');
  assert.equal(section.hidden, false);
  const row = [...section.querySelectorAll('[data-shortcut-row]')].find(row => row.dataset.command === 'bitfroest.copy' && row.dataset.defaultKey === 'f5');
  assert.ok(row);
  row.querySelector('[data-shortcut-edit]').click();
  const capture = app.document.querySelector('#shortcut-capture');
  capture.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
  app.click('[data-shortcut-accept]');
  assert.match(section.querySelector('[role="alert"]').textContent, /Verschieben|Move/);
  assert.equal(app.document.querySelector('[data-save]').disabled, true);
  section.querySelector(`[data-shortcut-row="${row.dataset.shortcutRow}"] [data-shortcut-edit]`).click();
  capture.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  app.click('[data-shortcut-accept]'); app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[0].value.shortcuts[row.dataset.shortcutRow], 'ctrl+shift+k');
  section.querySelector(`[data-shortcut-row="${row.dataset.shortcutRow}"] [data-shortcut-reset]`).click();
  app.click('[data-save]'); await app.flush();
  assert.deepEqual(Object.keys(app.saved[1].value.shortcuts), []);
});

test('settings search opens the integrated shortcuts section through common search terms', async t => {
  const app = await setup(t);
  app.editor.open('settings'); await app.flush();
  for (const query of ['keyboard', 'shortcut', 'Tastatur']) {
    app.input('#settings-search', query);
    assert.equal(app.document.querySelectorAll('#settings-results article').length, 1);
    assert.match(app.document.querySelector('#settings-results').textContent, /Tastatur|Keyboard/);
  }
  app.click('#settings-results button'); await app.flush();
  assert.equal(app.panels.length, 1);
  assert.equal(app.document.querySelector('#shortcuts-section').hidden, false);
  assert.equal(app.document.querySelector('[data-section="shortcuts"]').getAttribute('aria-selected'), 'true');
});

test('shortcuts share the settings navigation, preserve drafts and support arrow navigation', async t => {
  const app = await setup(t);
  app.click('[data-add-favorite]'); app.input('#favorite-name', 'Unsaved favorite'); app.input('#favorite-path', 'C:/work');
  const tab = app.document.querySelector('nav [data-section="shortcuts"]'); assert.ok(tab);
  assert.equal(tab.textContent, 'Keyboard shortcuts');
  assert.equal(app.document.querySelector('[data-open-shortcuts]'), null);
  tab.click();
  const section = app.document.querySelector('#shortcuts-section');
  assert.equal(section.hidden, false);
  assert.equal(tab.getAttribute('aria-controls'), section.id);
  assert.equal(section.getAttribute('role'), 'tabpanel');
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.resolve(__dirname, '../media/configuration.css'), 'utf8'); app.document.head.append(style);
  assert.notEqual(app.window.getComputedStyle(app.document.querySelector('.settings-sidebar')).display, 'none');
  tab.focus(); tab.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(app.document.activeElement.dataset.section, 'settings');
  app.click('[data-section="favorites"]');
  assert.equal(app.document.querySelector('#favorite-name').value, 'Unsaved favorite');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[0].value.favorites[0].name, 'Unsaved favorite');
});

test('German settings use the concise shortcut label in navigation and heading', async t => {
  const app = await setup(t, { language: 'de' });
  app.click('[data-section="shortcuts"]');
  assert.equal(app.document.querySelector('[data-section="shortcuts"]').textContent, 'Tastenkürzel');
  assert.equal(app.document.querySelector('#shortcuts-section h2').textContent, 'Tastenkürzel');
});


test('shortcut capture consumes save and cancel keys without saving or abandoning the draft', async t => {
  const app = await setup(t); app.editor.open('shortcuts'); await app.flush();
  const row = [...app.document.querySelectorAll('[data-shortcut-row]')].find(row => row.dataset.command === 'bitfroest.copy' && row.dataset.defaultKey === 'f5');
  row.querySelector('[data-shortcut-edit]').click();
  const input = app.document.querySelector('#shortcut-capture');
  for (const [key, extra] of [['s', { ctrlKey: true }], ['Escape', {}], ['Enter', {}]]) {
    const event = new app.window.KeyboardEvent('keydown', { key, ...extra, bubbles: true, cancelable: true }); input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(app.document.querySelector('#shortcut-dialog').open, true);
  }
  await app.flush(); assert.equal(app.saved.length, 0);
  app.click('[data-shortcut-cancel]'); assert.equal(app.document.querySelector('#shortcut-dialog').open, false);
});
test('invalid external shortcut values remain visible and can be reset without breaking the editor', async t => {
  const app = await setup(t);
  app.external({ favorites: [], columns: catalog.map(item => ({ ...item })), shortcuts: { missing: 'not a shortcut' } });
  app.editor.open('shortcuts'); app.click('[data-discard]'); await app.flush();
  assert.equal(app.document.querySelector('[data-save]').disabled, true);
  assert.ok(app.document.querySelector('#shortcut-conflicts').textContent);
  app.click('[data-shortcut-reset-all]'); app.click('[data-save]'); await app.flush();
  assert.deepEqual(Object.keys(app.saved[0].value.shortcuts), []);
});

test('a new favorite can change its parent before a path is entered and use the native directory picker', async t => {
  const app = await setup(t);
  app.click('[data-add-group]'); app.input('#favorite-name', 'Projects'); app.click('[data-add-favorite]');
  const parent = app.document.querySelector('#favorite-parent'); parent.value = ''; parent.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(parent.value, '');
  app.click('[data-browse="path"]'); await app.flush();
  assert.equal(app.document.querySelector('#favorite-path').value, 'C:\\chosen');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[0].value.favorites.find(item => item.type === 'favorite').parent, null);
});

test('reopening configuration uses a new panel and current persisted values', async t => {
  const app = await setup(t);
  app.panel.dispose(); app.editor.open('columns');
  assert.equal(app.panels.length, 2);
  await app.panels[1].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[1].messages.at(-1).section, 'columns');
  assert.equal(app.panels[1].messages.at(-1).data.columns.length, catalog.length);
});

function columnDrag(app, type, id, transfer, clientY = 0) {
  const row = app.document.querySelector(`[data-column-row="${id}"]`);
  row.getBoundingClientRect = () => ({ top: 0, height: 20 });
  const event = new app.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  row.dispatchEvent(event); return event;
}

test('column rows reorder by drop above and below, preserve presentation and save explicitly', async t => {
  const app = await setup(t); app.click('[data-section="columns"]');
  assert.equal(app.document.querySelector('#columns-section th[data-text="Reihenfolge"]'), null);
  assert.equal(app.document.querySelectorAll('#columns-section th').length, 3);
  const values = new Map(), transfer = { setData: (key, value) => values.set(key, value), getData: key => values.get(key) || '', get types() { return [...values.keys()]; } };
  const ids = () => [...app.document.querySelectorAll('[data-column-row]')].map(row => row.dataset.columnRow);
  app.change('[data-column-row="name"] [data-alignment]', 'right');
  assert.equal(app.document.querySelector('[data-column-row="name"]').draggable, true);
  columnDrag(app, 'dragstart', 'name', transfer);
  assert.equal(columnDrag(app, 'dragover', 'size', transfer, 19).defaultPrevented, true);
  assert.equal(app.document.querySelector('[data-column-row="size"]').dataset.dropPosition, 'after');
  columnDrag(app, 'drop', 'size', transfer, 19);
  assert.deepEqual(ids().slice(0, 3), ['type', 'size', 'name']);
  assert.equal(app.document.activeElement.dataset.columnRow, 'name');
  assert.equal(app.document.querySelector('[data-column-row="name"] [data-alignment]').value, 'right');
  assert.equal(app.saved.length, 0);
  columnDrag(app, 'dragstart', 'name', transfer);
  columnDrag(app, 'drop', 'type', transfer, 1);
  assert.deepEqual(ids().slice(0, 3), ['name', 'type', 'size']);
  columnDrag(app, 'dragstart', 'name', transfer);
  columnDrag(app, 'drop', 'size', transfer, 19);
  app.click('[data-save]'); await app.flush();
  assert.deepEqual(Array.from(app.saved[0].value.columns.slice(0, 3), item => item.id), ['type', 'size', 'name']);
  assert.equal(app.saved[0].value.columns[2].align, 'right');
  assert.equal(app.saved[0].value.columns[2].visible, true);
  app.click('[data-discard]'); await app.flush();
  assert.deepEqual(ids().slice(0, 3), ['type', 'size', 'name']);
});

test('column keyboard reordering and drag cancellation reject stale and foreign drops', async t => {
  const app = await setup(t); app.click('[data-section="columns"]');
  const ids = () => [...app.document.querySelectorAll('[data-column-row]')].map(row => row.dataset.columnRow);
  const original = ids();
  const row = () => app.document.querySelector('[data-column-row="name"]');
  row().dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(ids().slice(0, 3), ['type', 'name', 'size']);
  assert.equal(app.document.activeElement.dataset.columnRow, 'name');
  app.click('[data-discard]'); await app.flush(); assert.deepEqual(ids(), original);
  const values = new Map(), transfer = { setData: (key, value) => values.set(key, value), getData: key => values.get(key) || '', get types() { return [...values.keys()]; } };
  columnDrag(app, 'drop', 'size', transfer, 19); assert.deepEqual(ids(), original);
  columnDrag(app, 'dragstart', 'name', transfer);
  columnDrag(app, 'dragover', 'size', transfer, 19);
  columnDrag(app, 'dragend', 'name', transfer);
  assert.equal(app.document.querySelector('[data-drop-position]'), null);
  columnDrag(app, 'drop', 'size', transfer, 19); assert.deepEqual(ids(), original);
  columnDrag(app, 'dragstart', 'name', transfer);
  app.click('[data-discard]'); await app.flush();
  columnDrag(app, 'drop', 'size', transfer, 19); assert.deepEqual(ids(), original);
});

test('column settings have fixed labels and expose no title editors', async t => {
  const app = await setup(t); app.click('[data-section="columns"]');
  assert.equal(app.document.querySelector('[data-title]'), null);
  assert.equal(app.document.querySelector('#columns-section th[data-text="Überschrift"]'), null);
});

test('column table shows the complete catalog, edits presentation and saves only on demand', async t => {
  const app = await setup(t); app.click('[data-section="columns"]');
  assert.equal(app.document.querySelectorAll('[data-column-row]').length, catalog.length);
  const row = app.document.querySelector('[data-column-row="path"]');
  row.querySelector('[data-visible]').click();
  app.change('[data-column-row="path"] [data-alignment]', 'right');
  assert.equal(row.querySelector('[data-width]'), null);
  assert.equal(app.saved.length, 0); app.click('[data-save]'); await app.flush();
  const column = app.saved[0].value.columns.find(item => item.id === 'path');
  assert.equal(column.visible, true); assert.equal(column.align, 'right'); assert.equal(Object.hasOwn(column, 'width'), false);
  app.change('[data-column-row="path"] [data-alignment]', 'center');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[1].value.columns.find(item => item.id === 'path').align, 'center');
});

test('host rejects stale saves and write failures remain visible with the draft intact', async t => {
  const app = await setup(t, { error: 'Storage unavailable' });
  app.click('[data-add-favorite]'); app.input('#favorite-name', 'Work'); app.input('#favorite-path', 'C:/work');
  app.click('[data-save]'); await app.flush();
  assert.match(app.document.querySelector('[role="alert"]').textContent, /Storage unavailable/);
  assert.equal(app.document.querySelector('#favorite-name').value, 'Work');
  app.external({ favorites: [], columns: catalog.map(item => ({ ...item, title: 'External' })) });
  app.click('[data-save]'); await app.flush();
  assert.match(app.document.querySelector('[role="alert"]').textContent, /changed outside/);
  assert.equal(app.saved.length, 0);
});

test('the editor blocks edits during an in-flight save and restores normal editing afterward', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const app = await setup(t, { beforeWrite: () => waiting });
  app.click('[data-section="columns"]'); app.change('[data-column-row="name"] [data-alignment]', 'right');
  app.click('[data-save]'); const saving = app.flush();
  assert.equal(app.document.querySelector('main').inert, true);
  assert.equal(app.document.querySelector('#scope').disabled, true);
  app.change('[data-column-row="name"] [data-alignment]', 'center');
  const values = new Map(), transfer = { setData: (key, value) => values.set(key, value), getData: key => values.get(key) || '', get types() { return [...values.keys()]; } };
  columnDrag(app, 'dragstart', 'name', transfer);
  columnDrag(app, 'drop', 'size', transfer, 19);
  release(); await saving;
  assert.equal(app.saved[0].value.columns.find(item => item.id === 'name').align, 'right');
  assert.equal(app.saved[0].value.columns[0].id, 'name');
  assert.equal(app.document.querySelector('main').inert, false);
});

test('directory picker replies cannot cross a configuration scope change', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const app = await setup(t, { browse: () => waiting });
  const browsing = app.panel.receive({ type: 'configuration-browse', id: 'favorite-1', field: 'path', requestId: 'browse-1' });
  await app.panel.receive({ type: 'configuration-scope', scope: 'workspace' });
  release('C:/wrong-scope'); await browsing;
  assert.equal(app.panel.messages.some(item => item.type === 'configuration-browsed'), false);
});

test('closing and reopening during a save still initializes the replacement panel', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const app = await setup(t, { beforeWrite: () => waiting });
  app.click('[data-section="columns"]'); app.change('[data-column-row="name"] [data-alignment]', 'right');
  app.click('[data-save]'); const saving = app.flush();
  app.panel.dispose(); app.editor.open('columns');
  const replacement = app.panels[1]; await replacement.receive({ type: 'configuration-ready' });
  release(); await saving;
  assert.equal(replacement.messages.at(-1)?.type, 'configuration-state');
  assert.equal(replacement.messages.at(-1).data.columns.find(item => item.id === 'name').align, 'right');
});

test('favorite fields display native Windows paths and normalize mixed quoted input before save', async t => {
  const app = await setup(t);
  app.click('[data-add-favorite]'); app.input('#favorite-name', 'Work');
  app.input('#favorite-path', '"c:\\work/mixed"'); app.input('#favorite-target', '\\\\server\\share\\folder');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[0].value.favorites[0].path, 'c:/work/mixed');
  assert.equal(app.saved[0].value.favorites[0].target, '//server/share/folder');
  assert.equal(app.document.querySelector('#favorite-path').value, 'C:\\work\\mixed');
  assert.equal(app.document.querySelector('#favorite-target').value, '\\\\server\\share\\folder');
});
