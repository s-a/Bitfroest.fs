const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('Git read errors use readable red row context and an error badge while selection remains theme controlled', t => {
  const p = () => ({ tabs: ['/repo'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'error-colors', active: 0, panes: [p(), p()], folders: { '/repo': [{ id: 'folder', name: 'folder', type: 'folder' }] } });
  app.document.body.style.setProperty('--vscode-sideBar-background', '#252526');
  app.document.body.style.setProperty('--vscode-foreground', '#cccccc');
  app.document.body.style.setProperty('--vscode-errorForeground', '#ff4040');
  const request = app.messages.find(message => message.type === 'git-status');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/repo': { ok: true, repository: false, statuses: {}, repositoryErrors: { folder: 'Access denied' } } } } }));
  const row = app.row('folder'), color = row.style.getPropertyValue('--git-text-color'), colors = app.window.CommanderFileColors;
  assert.ok(color); assert.ok(colors.ratio(color, '#252526') >= 4.5);
  const [red, green, blue] = colors.parse(color); assert.ok(red > green && red > blue);
  assert.ok(row.querySelector('[data-git-status="error"]'));
});

function fixture() {
  const pane = () => ({ tabs: ['/repo'], tab: 0, selected: [], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'colors', active: 0, panes: [pane(), pane()], folders: { '/repo': [{ id: 'a', name: 'test.js', type: 'code' }, { id: 'b', name: 'plain.txt', type: 'text' }], '/': [] } };
}
const settings = { colors: { enabled: true, git: true, rules: { '*.js': '#ffffff' } } };

test('Git badges use seven distinct semantic colors with theme values and fallbacks', t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  const style = app.document.documentElement.style;
  style.setProperty('--vscode-foreground', '#222222');
  const palette = { added: '#008000', untracked: '#008000', modified: '#806000', ignored: '#666666', deleted: '#aa0000', conflicting: '#800080' };
  for (const [name, color] of Object.entries(palette)) style.setProperty(`--vscode-gitDecoration-${name}ResourceForeground`, color);
  style.setProperty('--vscode-charts-blue', '#005bbb');
  style.setProperty('--vscode-terminal-ansiCyan', '#007b83');
  style.setProperty('--vscode-terminal-ansiMagenta', '#9b008a');
  const request = app.messages.find(message => message.type === 'git-status');
  const send = status => {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, statuses: { 'test.js': status } } } } }));
    return app.row('test.js').querySelector('[data-git-status]').style.getPropertyValue('--git-badge-color');
  };
  const expected = { clean: '#008000', added: '#005bbb', untracked: '#007b83', modified: '#806000', ignored: '#666666', deleted: '#aa0000', conflict: '#9b008a' };
  for (const [status, color] of Object.entries(expected)) assert.equal(send(status), color, status);
  for (const name of Object.keys(palette)) style.removeProperty(`--vscode-gitDecoration-${name}ResourceForeground`);
  for (const name of ['charts-blue', 'terminal-ansiCyan', 'terminal-ansiMagenta']) style.removeProperty(`--vscode-${name}`);
  const fallbackColors = Object.keys(expected).map(send);
  assert.equal(new Set(fallbackColors).size, 7);
  for (const color of fallbackColors) {
    assert.ok(require('../media/commander-file-colors').ratio(color, '#ffffff') >= 4.5);
  }
});

test('Git-colored folder names and metadata share the badge palette', async t => {
  const state = fixture();
  state.folders['/repo'].push({ id: 'folder', name: 'folder', type: 'folder' });
  const app = createApp(t, state, { fileSettings: settings });
  await theme(app, '#ffffff');
  app.document.body.style.setProperty('--vscode-gitDecoration-modifiedResourceForeground', '#806000');
  const request = app.messages.find(message => message.type === 'git-status');
  for (const status of ['clean', 'modified', 'added', 'deleted', 'untracked', 'ignored', 'conflict']) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, statuses: { folder: status, 'test.js': status } } } } }));
    const folder = app.row('folder'), badge = folder.querySelector('[data-git-status]');
    const expected = badge.style.getPropertyValue('--git-badge-color');
    assert.equal(folder.style.getPropertyValue('--git-text-color'), expected, status);
    assert.equal(folder.querySelector('[data-filename]').style.getPropertyValue('--file-type-color'), expected, status);
    if (['modified', 'added', 'deleted', 'conflict'].includes(status)) assert.equal(app.row('test.js').style.getPropertyValue('--git-text-color'), expected, status);
  }
});

test('Git palette follows live light dark and high contrast theme changes', async t => {
  const state = fixture();
  state.folders['/repo'].push({ id: 'folder', name: 'folder', type: 'folder' });
  const app = createApp(t, state, { fileSettings: settings });
  const request = app.messages.find(message => message.type === 'git-status');
  const tokens = { clean: 'gitDecoration-addedResourceForeground', modified: 'gitDecoration-modifiedResourceForeground', added: 'charts-blue', deleted: 'gitDecoration-deletedResourceForeground', untracked: 'terminal-ansiCyan', ignored: 'gitDecoration-ignoredResourceForeground', conflict: 'terminal-ansiMagenta' };
  const colors = app.window.CommanderFileColors;
  for (const [status, token] of Object.entries(tokens)) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, statuses: { folder: status } } } } }));
    const folder = app.row('folder'), badge = folder.querySelector('[data-git-status]');
    for (const [background, desired] of [['#ffffff', '#123456'], ['#181818', '#abcdef']]) {
      app.document.body.style.setProperty('--vscode-sideBar-background', background);
      app.document.body.style.setProperty('--vscode-foreground', '#777777');
      app.document.body.style.setProperty(`--vscode-${token}`, desired);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(app.row('folder'), folder);
      assert.equal(folder.querySelector('[data-git-status]'), badge);
      assert.equal(folder.style.getPropertyValue('--git-text-color'), colors.readable(desired, background, '#777777'), status);
      assert.equal(badge.style.getPropertyValue('--git-badge-color'), colors.readable(desired, '#ffffff', '#777777'), status);
      assert.ok(colors.ratio(folder.style.getPropertyValue('--git-text-color'), background) >= 4.5);
    }
    for (const mode of ['vscode-high-contrast', 'vscode-high-contrast-light']) {
      app.document.body.classList.add(mode);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(folder.style.getPropertyValue('--git-text-color'), '');
      assert.equal(folder.querySelector('[data-filename]').style.getPropertyValue('--file-type-color'), '');
      app.document.body.classList.remove(mode);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
});

test('text matching pane backgrounds is corrected even when the body has a different background', async t => {
  const state = fixture();
  state.folders['/repo'].push({ id: 'folder', name: 'folder', type: 'folder' });
  const app = createApp(t, state, { fileSettings: settings });
  const body = app.document.body.style, colors = app.window.CommanderFileColors;
  const request = app.messages.find(message => message.type === 'git-status');
  for (const [background, outer] of [['#181818', '#ffffff'], ['#ffffff', '#181818']]) {
    body.setProperty('background-color', outer);
    body.setProperty('--vscode-sideBar-background', background);
    body.setProperty('--vscode-list-hoverBackground', background);
    body.setProperty('--vscode-foreground', background);
    body.setProperty('--vscode-gitDecoration-modifiedResourceForeground', background);
    for (const selection of ['active', 'inactive']) {
      body.setProperty(`--vscode-list-${selection}SelectionBackground`, background);
      body.setProperty(`--vscode-list-${selection}SelectionForeground`, background);
    }
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { colors: { enabled: true, git: true, rules: { '*.js': background } } } } }));
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: 'colors', directories: { '/repo': { ok: true, repository: true, statuses: { folder: 'modified' } } } } }));
    await new Promise(resolve => setImmediate(resolve));
    for (const filename of ['test.js', 'folder']) {
      const row = app.row(filename), name = row.querySelector('[data-filename]');
      for (const property of ['--git-text-color', '--git-hover-color']) assert.ok(colors.ratio(row.style.getPropertyValue(property), background) >= 4.5, `${filename}: ${property}`);
      for (const property of ['--file-type-color', '--file-type-hover']) assert.ok(colors.ratio(name.style.getPropertyValue(property), background) >= 4.5, `${filename}: ${property}`);
    }
    const table = app.document.querySelector('.file-table');
    for (const selection of ['active', 'inactive']) assert.ok(colors.ratio(table.style.getPropertyValue(`--${selection}-selection-text`), background) >= 4.5);
  }
});

test('filename and metadata text colors transition for 200ms and respect reduced motion', t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  const style = app.document.createElement('style');
  style.textContent = css;
  app.document.head.append(style);
  const row = app.row('test.js');
  for (const element of [row.querySelector('[data-filename]'), row.querySelector('td:last-child')]) {
    assert.equal(app.window.getComputedStyle(element).transition, 'color 200ms ease');
  }
  const reduced = [...style.sheet.cssRules].find(rule => rule.conditionText === '(prefers-reduced-motion: reduce)' && [...rule.cssRules].some(child => child.style?.transition === 'none' && child.selectorText.includes('[data-filename]')));
  assert.ok(reduced, 'reduced motion disables text color transitions');
});

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

test('parent entry uses a labelled ellipsis and keeps existing navigation', t => {
  const app = createApp(t, fixture());
  const parent = app.document.querySelector('.pane.active [data-parent]');
  assert.equal(parent.querySelector('.fileicon.folder'), null);
  assert.equal(parent.querySelector('[data-parent-icon]'), null);
  assert.equal(parent.querySelector('.filename').textContent, '…');
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

test('rule changes update names in place and missing theme backgrounds use the stylesheet fallback', async t => {
  const app = createApp(t, fixture(), { fileSettings: settings });
  const name = app.row('test.js').querySelector('[data-filename]');
  assert.equal(name.style.getPropertyValue('--file-type-color'), '#ffffff');
  assert.ok(app.window.CommanderFileColors.ratio(name.style.getPropertyValue('--file-type-color'), '#252526') >= 4.5);
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
