const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = () => ({ tabs: ['/repo'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'icons', active: 0, panes: [pane(), pane()], folders: { '/repo': [{ id: 'd', name: 'folder', type: 'folder' }, { id: 'f', name: 'file.txt', type: 'text' }], '/repo/folder': [] } };
}
function reply(app, status = 'clean') {
  const request = app.messages.find(message => message.type === 'git-status');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/repo': { ok: true, repository: true, statuses: { folder: status, 'file.txt': status } } } } }));
}
test('native folder icons replace the fallback without changing selection or Git badges', t => {
  const app = createApp(t, fixture()), first = app.row('folder').querySelector('.fileicon');
  assert.ok(first.querySelector('svg.bi-folder-fill'));
  const requests = app.messages.filter(message => message.type === 'icons').flatMap(message => message.requests);
  assert.ok(requests.some(request => request.path === '/repo/folder' && request.type === 'folder'));
  reply(app, 'modified');
  const row = app.row('folder'), badge = row.querySelector('[data-git-status]');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { '/repo/folder': 'data:image/png;base64,Zm9sZGVy' } } }));
  assert.equal(app.row('folder'), row);
  assert.ok(row.querySelector('img.native-icon[data-icon-reviewed="native"]'));
  assert.equal(row.querySelector('[data-git-status]'), badge);
});

test('missing and unsolicited folder icons retain the fallback', t => {
  const app = createApp(t, fixture()), first = app.row('folder').querySelector('.fileicon');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { '/repo/folder': null, '/unrequested': 'data:image/png;base64,AAAA' } } }));
  assert.equal(app.row('folder').querySelector('.fileicon'), first);
  assert.ok(first.querySelector('svg.bi-folder-fill'));
});

test('folder icons for more than one batch are requested after the first response', t => {
  const state = fixture();
  state.folders['/repo'] = Array.from({ length: 140 }, (_, i) => ({ id: String(i), name: `folder-${i}`, type: 'folder' }));
  const app = createApp(t, state);
  const batch = app.messages.find(message => message.type === 'icons');
  assert.equal(batch.requests.length, 128);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: Object.fromEntries(batch.requests.map(request => [request.key, null])) } }));
  const requests = app.messages.filter(message => message.type === 'icons').flatMap(message => message.requests);
  assert.equal(new Set(requests.map(request => request.key)).size, 140);
});

test('a folder refresh rejects icons from the previous view generation', t => {
  const app = createApp(t, fixture());
  const previous = app.messages.find(message => message.type === 'icons');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'window-focus', focused: true } }));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', iconGeneration: previous.iconGeneration, icons: { '/repo/folder': 'data:image/png;base64,AAAA' } } }));
  assert.equal(app.row('folder').querySelector('img.native-icon'), null);
});
test('status uses the chosen filled Bootstrap check directly and resizes without a font transition', t => {
  const app = createApp(t, fixture()); let loads = 0;
  Object.defineProperty(app.document, 'fonts', { value: { load: () => { loads++; return Promise.resolve([{}]); } } });
  reply(app);
  const badge = app.row('file.txt').querySelector('[data-git-status]'), svg = badge.querySelector('svg');
  assert.ok(svg.classList.contains('bi-check-circle-fill'));
  assert.equal(svg.getAttribute('fill'), 'currentColor');
  assert.equal(badge.style.width, '50%'); assert.equal(badge.style.height, '50%');
  assert.equal(badge.querySelector('[data-git-glyph]'), null); assert.equal(loads, 0);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { gitStatus: { iconSizePercent: 80 } } } }));
  assert.equal(badge.style.width, '80%'); assert.equal(badge.style.height, '80%');
  reply(app);
  assert.equal(app.row('file.txt').querySelector('[data-git-status]'), badge);
});

test('overlay sizes validate bounds and Bootstrap license is packaged', t => {
  const app = createApp(t, fixture()); reply(app);
  const badge = app.row('file.txt').querySelector('[data-git-status]');
  for (const [value, expected] of [[0, '25%'], [101, '100%'], [66, '66%'], [NaN, '50%'], ['80', '50%']]) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { gitStatus: { iconSizePercent: value } } } }));
    assert.equal(badge.style.width, expected);
    assert.equal(badge.style.height, expected);
  }
  const manifest = require('../package.json'), properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
  const setting = properties['bitfroest.gitStatus.iconSizePercent'];
  assert.equal(setting.type, 'integer'); assert.equal(setting.default, 50);
  assert.equal(setting.minimum, 25); assert.equal(setting.maximum, 100); assert.equal(setting.scope, 'window');
  for (const file of ['../package.nls.json', '../package.nls.de.json']) assert.ok(require(file)[setting.description.replaceAll('%', '')]);
  const component = require('../licenses/components.json').find(component => component.name === 'Bootstrap Icons');
  assert.equal(component.license, 'MIT');
  const fs = require('node:fs'), path = require('node:path');
  assert.ok(component.files.every(file => fs.existsSync(path.join(__dirname, '..', file))));
});
