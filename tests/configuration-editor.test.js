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
  const editor = createConfigurationEditor(vscode, context, { read: () => values, write: async (value, scope) => { await overrides.beforeWrite?.(); if (overrides.error) throw new Error(overrides.error); saved.push({ value, scope }); values = value; }, browse: overrides.browse || (async () => 'C:/chosen'), language: () => 'en', t: text => text, workspace: () => true });
  editor.open('favorites'); const panel = panels[0];
  const dom = new JSDOM(panel.webview.html, { url: 'https://configuration.invalid/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const messages = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  for (const name of ['commander-i18n', 'commander-column-settings', 'configuration-model', 'configuration-view']) new vm.Script(fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', `${name}.js`), 'utf8')).runInContext(dom.getInternalVMContext());
  const flush = async () => { while (messages.length) await panel.receive(messages.shift()); while (panel.messages.length) dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: panel.messages.shift() })); };
  await flush();
  return { editor, panels, panel, window: dom.window, document: dom.window.document, saved, flush, external: value => { values = value; }, click: selector => { const element = dom.window.document.querySelector(selector); assert.ok(element, selector); element.click(); }, input: (selector, value) => { const element = dom.window.document.querySelector(selector); element.value = value; element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); } };
}

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

test('a new favorite can change its parent before a path is entered and use the native directory picker', async t => {
  const app = await setup(t);
  app.click('[data-add-group]'); app.input('#favorite-name', 'Projects'); app.click('[data-add-favorite]');
  const parent = app.document.querySelector('#favorite-parent'); parent.value = ''; parent.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(parent.value, '');
  app.click('[data-browse="path"]'); await app.flush();
  assert.equal(app.document.querySelector('#favorite-path').value, 'C:/chosen');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[0].value.favorites.find(item => item.type === 'favorite').parent, null);
});

test('reopening configuration uses a new panel and current persisted values', async t => {
  const app = await setup(t);
  app.panel.dispose(); app.editor.open('columns');
  assert.equal(app.panels.length, 2);
  await app.panels[1].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[1].messages.at(-1).section, 'columns');
  assert.equal(app.panels[1].messages.at(-1).data.columns.length, 13);
});

test('column table shows the complete catalog, edits presentation and saves only on demand', async t => {
  const app = await setup(t); app.click('[data-section="columns"]');
  assert.equal(app.document.querySelectorAll('[data-column-row]').length, 13);
  const row = app.document.querySelector('[data-column-row="path"]');
  row.querySelector('[data-visible]').click();
  app.input('[data-column-row="path"] [data-title]', 'My path');
  const width = row.querySelector('[data-width]'); width.value = '320'; width.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.saved.length, 0); app.click('[data-save]'); await app.flush();
  const column = app.saved[0].value.columns.find(item => item.id === 'path');
  assert.equal(column.visible, true); assert.equal(column.title, 'My path'); assert.equal(column.width, 320);
  app.input('[data-column-row="path"] [data-title]', 'Second title');
  app.click('[data-save]'); await app.flush();
  assert.equal(app.saved[1].value.columns.find(item => item.id === 'path').title, 'Second title');
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
  app.click('[data-section="columns"]'); app.input('[data-column-row="name"] [data-title]', 'Before save');
  app.click('[data-save]'); const saving = app.flush();
  assert.equal(app.document.querySelector('main').inert, true);
  assert.equal(app.document.querySelector('#scope').disabled, true);
  app.input('[data-column-row="name"] [data-title]', 'Blocked input');
  release(); await saving;
  assert.equal(app.saved[0].value.columns.find(item => item.id === 'name').title, 'Before save');
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
  app.click('[data-section="columns"]'); app.input('[data-column-row="name"] [data-title]', 'Saved name');
  app.click('[data-save]'); const saving = app.flush();
  app.panel.dispose(); app.editor.open('columns');
  const replacement = app.panels[1]; await replacement.receive({ type: 'configuration-ready' });
  release(); await saving;
  assert.equal(replacement.messages.at(-1)?.type, 'configuration-state');
  assert.equal(replacement.messages.at(-1).data.columns.find(item => item.id === 'name').title, 'Saved name');
});
