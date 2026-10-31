const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = () => ({ tabs: ['/repo', '/repo/demo.zip!/nested'], tab: 1, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, panes: [pane(), pane()], active: 0, folders: { '/repo': [], '/repo/demo.zip!/nested': [] }, archiveLocations: { '/repo/demo.zip!/nested': { archive: '/repo/demo.zip', parent: '/repo/demo.zip!' } } };
}

test('encoded archive roots and nested folders have readable tab labels while retaining internal paths', t => {
  const archive = 'C:/temp/A & 100%.zip', root = 'zip:' + encodeURIComponent(archive) + '!', nested = root + '/inner folder';
  const saved = fixture(); saved.panes[0].tabs = [root, nested]; saved.panes[0].tab = 0;
  saved.archiveLocations[root] = { archive, parent: 'C:/temp' }; saved.archiveLocations[nested] = { archive, parent: root };
  saved.folders[root] = []; saved.folders[nested] = [];
  const app = createApp(t, saved);
  const labels = () => [...app.document.querySelectorAll('.pane.active [data-tab-label]')].map(node => node.textContent);
  assert.deepEqual(labels(), ['A & 100%.zip', 'inner folder']);
  assert.ok(app.document.querySelector('.pane.active [data-tab="0"]').title.startsWith('C:\\temp\\A & 100%.zip!'));
  app.click(app.document.querySelector('.pane.active [data-tab="1"]'));
  assert.deepEqual(labels(), ['A & 100%.zip', 'inner folder']);
  assert.equal(app.state().panes[0].tabs[1], nested);
});
test('tabs have no icons, selected labels are bold and archive labels use contrast-safe archive colors', async t => {
  const app = createApp(t, fixture(), { fileSettings: { colors: { enabled: true, rules: { '*.zip': '#ff0000' } } } });
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); app.document.head.appendChild(style);
  app.document.body.style.setProperty('--vscode-tab-activeBackground', '#ffffff');
  app.document.body.style.setProperty('--vscode-tab-inactiveBackground', '#181818');
  app.document.body.style.setProperty('--vscode-sideBar-background', '#ffffff');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelector('.tabs .fileicon,.tabs .git-icon'), null);
  const tab = app.document.querySelector('.pane.active [data-tab="1"]');
  assert.equal(app.window.getComputedStyle(tab).fontWeight, '700');
  const color = tab.style.getPropertyValue('--archive-tab-color');
  assert.ok(app.window.CommanderFileColors.ratio(color, '#ffffff') >= 4.5);
  assert.ok(color !== '#000000');
  assert.equal(app.document.querySelector('.pane.active [data-tab="0"]').style.getPropertyValue('--archive-tab-color'), '');
  assert.equal(app.messages.filter(message => message.type === 'icons').flatMap(message => message.requests).length, 0);
  app.click(app.document.querySelector('.pane.active [data-tab="0"]'));
  const inactive = app.document.querySelector('.pane.active [data-tab="1"]');
  assert.ok(app.window.CommanderFileColors.ratio(inactive.style.getPropertyValue('--archive-tab-color'), '#181818') >= 4.5);
  assert.equal(app.document.querySelector('.tabs .fileicon,.tabs .git-icon'), null);
  app.document.body.classList.add('vscode-high-contrast');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inactive.style.getPropertyValue('--archive-tab-color'), '');
});

test('archive tab contrast uses the tab surface fallback when header theme colors are absent', async t => {
  const state = fixture(); state.panes.forEach(pane => { pane.tab = 0; });
  const app = createApp(t, state, { fileSettings: { colors: { enabled: true, rules: { '*.zip': '#ffffff' } } } });
  app.document.body.style.setProperty('--vscode-editor-background', '#ffffff');
  await new Promise(resolve => setImmediate(resolve));
  const color = app.document.querySelector('.pane.active [data-tab="1"]').style.getPropertyValue('--archive-tab-color');
  assert.ok(app.window.CommanderFileColors.ratio(color, '#252526') >= 4.5);
});

test('status badges use the default two-thirds size and filled Bootstrap geometry', t => {
  const state = fixture(); state.panes.forEach(pane => { pane.tab = 0; }); state.folders['/repo'] = [{ id: 'a', name: 'a.txt', type: 'text' }];
  const app = createApp(t, state);
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); app.document.head.appendChild(style);
  const request = app.messages.find(message => message.type === 'git-status');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/repo': { ok: true, repository: true, statuses: { 'a.txt': 'clean' } } } } }));
  const badge = app.row('a.txt').querySelector('[data-git-status]'), computed = app.window.getComputedStyle(badge);
  assert.equal(computed.width, '66%'); assert.equal(computed.height, '66%');
  assert.equal(computed.left, '0px'); assert.equal(computed.bottom, '0px');
  assert.ok(badge.querySelector('svg.bi-check-circle-fill'));
  assert.equal(badge.querySelector('[data-git-glyph]'), null);
  assert.ok(badge.querySelector('svg path'));
});
