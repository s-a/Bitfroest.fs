const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const pane = () => ({ tabs: ['/repo'], tab: 0, selected: [], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'colors', active: 0, panes: [pane(), pane()], folders: { '/repo': [{ id: 'a', name: 'test.js', type: 'code' }, { id: 'b', name: 'plain.txt', type: 'text' }], '/': [] } };
}
const settings = { colors: { enabled: true, git: true, rules: { '*.js': '#ffffff' } } };

test('files without tracked changes use their type color for every attribute including outside repositories', async t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  await theme(app, '#ffffff');
  const row = app.row('test.js'), name = row.querySelector('[data-filename]');
  const request = app.messages.find(message => message.type === 'git-status');
  const send = info => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': info } } }));
  for (const status of [undefined, 'untracked', 'ignored', 'clean']) {
    send({ ok: true, repository: Boolean(status), statuses: status ? { 'test.js': status } : {} });
    assert.equal(row.style.getPropertyValue('--git-text-color'), name.style.getPropertyValue('--file-type-color'), String(status));
    assert.equal(row.style.getPropertyValue('--git-hover-color'), name.style.getPropertyValue('--file-type-hover'), String(status));
    if (status === 'ignored') assert.ok(row.querySelector('svg.bi-slash-circle-fill'));
    if (status === 'untracked') assert.ok(row.querySelector('svg.bi-question-circle-fill'));
  }
});
async function theme(app, background) {
  app.document.body.style.setProperty('--vscode-editor-background', background);
  app.document.body.style.setProperty('--vscode-editor-foreground', '#777777');
  app.document.body.style.setProperty('--vscode-gitDecoration-modifiedResourceForeground', background);
  await new Promise(resolve => setImmediate(resolve));
}
test('file type and Git colors coexist and react to theme changes without replacing rows or focus', async t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  await theme(app, '#ffffff');
  const row = app.row('test.js'), name = row.querySelector('[data-filename]');
  assert.ok(name.style.getPropertyValue('--file-type-color'));
  const request = app.messages.find(message => message.type === 'git-status');
  const input = app.document.querySelector('.path-input'); input.focus(); input.value = '/editing';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, branch: 'main', statuses: { 'test.js': 'modified' } } } } }));
  assert.ok(row.style.getPropertyValue('--git-text-color'));
  assert.equal(app.document.activeElement, input);
  const before = name.style.getPropertyValue('--file-type-color');
  await theme(app, '#181818');
  assert.notEqual(name.style.getPropertyValue('--file-type-color'), before);
  assert.equal(app.row('test.js'), row); assert.equal(input.value, '/editing');
  app.document.body.classList.add('vscode-high-contrast');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(name.style.getPropertyValue('--file-type-color'), '');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { colors: { enabled: false, git: false } } } }));
  app.document.body.classList.remove('vscode-high-contrast');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(name.style.getPropertyValue('--file-type-color'), '');
  assert.equal(row.style.getPropertyValue('--git-text-color'), '');
});

test('parent entry uses a labelled upward arrow and keeps existing navigation', t => {
  const app = createApp(t, fixture());
  const parent = app.document.querySelector('.pane.active [data-parent]');
  assert.equal(parent.querySelector('.fileicon.folder'), null);
  assert.equal(parent.querySelector('[data-parent-icon]').textContent, '↑');
  assert.equal(parent.getAttribute('aria-label'), 'Übergeordnetes Verzeichnis');
  parent.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(app.state().panes[0].tabs[0], '/');
});

test('palette checks sidebar, transparent hover, both selections and white badge backgrounds', async t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  const colors = app.window.CommanderFileColors, style = app.document.body.style;
  style.setProperty('--vscode-sideBar-background', '#ffffff');
  style.setProperty('--vscode-list-hoverBackground', 'rgba(0,0,0,0.2)');
  for (const state of ['active', 'inactive']) {
    style.setProperty(`--vscode-list-${state}SelectionBackground`, '#333333');
    style.setProperty(`--vscode-list-${state}SelectionForeground`, '#333333');
  }
  await theme(app, '#000000');
  const name = app.row('test.js').querySelector('[data-filename]');
  assert.ok(colors.ratio(name.style.getPropertyValue('--file-type-color'), '#ffffff') >= 4.5);
  assert.ok(colors.ratio(name.style.getPropertyValue('--file-type-hover'), '#cccccc') >= 4.5);
  const table = app.document.querySelector('.file-table');
  for (const state of ['active', 'inactive']) assert.ok(colors.ratio(table.style.getPropertyValue(`--${state}-selection-text`), '#333333') >= 4.5);
  const request = app.messages.find(message => message.type === 'git-status');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, statuses: { 'test.js': 'modified' } } } } }));
  assert.ok(colors.ratio(app.row('test.js').querySelector('[data-git-status]').style.getPropertyValue('--git-badge-color'), '#ffffff') >= 4.5);
  app.click(app.document.querySelector('[data-sort="name"]'));
  assert.ok(app.row('test.js').querySelector('[data-filename]').style.getPropertyValue('--file-type-color'));
});

test('rule changes update names in place and unknown backgrounds retain native text', async t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  const name = app.row('test.js').querySelector('[data-filename]');
  assert.equal(name.style.getPropertyValue('--file-type-color'), '');
  await theme(app, '#ffffff');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { colors: { enabled: true, rules: { '*.js': '#123456' } } } } }));
  assert.equal(name.style.getPropertyValue('--file-type-color'), '#123456');
  assert.equal(app.row('plain.txt').querySelector('[data-filename]').style.getPropertyValue('--file-type-color'), '');
  assert.equal(app.row('test.js').querySelector('[data-filename]'), name);
});

test('missing hover theme color uses the same fallback background as the stylesheet', async t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  await theme(app, '#ffffff');
  const foreground = app.row('test.js').querySelector('[data-filename]').style.getPropertyValue('--file-type-hover');
  assert.ok(app.window.CommanderFileColors.ratio(foreground, '#2a2d2e') >= 4.5);
});

test('clean files use type colors throughout while clean folders use Git colors throughout', async t => {
  const state = fixture(); state.folders['/repo'].push({ id: 'folder', name: 'folder', type: 'folder' });
  const app = createApp(t, state, { fileSettings: settings });
  app.document.body.style.setProperty('--vscode-gitDecoration-addedResourceForeground', '#008000');
  await theme(app, '#ffffff');
  app.document.body.style.setProperty('--vscode-gitDecoration-modifiedResourceForeground', '#0000ff');
  const request = app.messages.find(message => message.type === 'git-status');
  const send = status => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, statuses: { 'test.js': status, folder: 'clean' } } } } }));
  send('clean');
  const file = app.row('test.js'), folder = app.row('folder');
  assert.equal(file.style.getPropertyValue('--git-text-color'), file.querySelector('[data-filename]').style.getPropertyValue('--file-type-color'));
  assert.equal(folder.querySelector('[data-filename]').style.getPropertyValue('--file-type-color'), '#008000');
  assert.equal(folder.style.getPropertyValue('--git-text-color'), '#008000');
  send('modified');
  assert.notEqual(file.style.getPropertyValue('--git-text-color'), file.querySelector('[data-filename]').style.getPropertyValue('--file-type-color'));
});

test('catalog rules are prepared once across both panes and reused on theme and status refresh', async t => {
  const app = createApp(t, fixture());
  const colors = app.window.CommanderFileColors, compile = colors.compile;
  let preparations = 0;
  colors.compile = rules => { preparations++; return compile(rules); };
  const rules = Object.assign({}, ...require('../package.json').contributes.configuration.map(section => section.properties))['bitfroest.colors.rules'].default;
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { colors: { enabled: true, git: true, rules } } } }));
  assert.equal(preparations, 1);
  await theme(app, '#ffffff');
  assert.equal(preparations, 1);
  assert.ok(app.row('test.js').querySelector('[data-filename]').style.getPropertyValue('--file-type-color'));
  const changed = { ...rules, '*.js': '#123456' };
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { colors: { enabled: true, rules: changed } } } }));
  assert.equal(preparations, 2);
  assert.equal(app.row('test.js').querySelector('[data-filename]').style.getPropertyValue('--file-type-color'), '#123456');
});
