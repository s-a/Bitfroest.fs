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
test('late native folder icons never replace the initial folder appearance', t => {
  const app = createApp(t, fixture()), first = app.row('folder').querySelector('.fileicon');
  const html = first.outerHTML;
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { '/repo/folder': 'data:image/png;base64,Zm9sZGVy' } } }));
  assert.equal(app.row('folder').querySelector('.fileicon'), first);
  assert.equal(first.outerHTML, html);
  assert.ok(first.querySelector('svg.bi-folder-fill'));
  assert.equal(app.messages.filter(message => message.type === 'icons').flatMap(message => message.requests).some(request => request.type === 'folder'), false);
});
test('status uses the chosen filled Bootstrap check directly and resizes without a font transition', t => {
  const app = createApp(t, fixture()); let loads = 0;
  Object.defineProperty(app.document, 'fonts', { value: { load: () => { loads++; return Promise.resolve([{}]); } } });
  reply(app);
  const badge = app.row('file.txt').querySelector('[data-git-status]'), svg = badge.querySelector('svg');
  assert.ok(svg.classList.contains('bi-check-circle-fill'));
  assert.equal(svg.getAttribute('fill'), 'currentColor');
  assert.equal(badge.style.width, '66%'); assert.equal(badge.style.height, '66%');
  assert.equal(badge.querySelector('[data-git-glyph]'), null); assert.equal(loads, 0);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { gitStatus: { iconSizePercent: 80 } } } }));
  assert.equal(badge.style.width, '80%'); assert.equal(badge.style.height, '80%');
  reply(app);
  assert.equal(app.row('file.txt').querySelector('[data-git-status]'), badge);
});

test('overlay sizes validate bounds and Bootstrap license is packaged', t => {
  const app = createApp(t, fixture()); reply(app);
  const badge = app.row('file.txt').querySelector('[data-git-status]');
  for (const [value, expected] of [[0, '25%'], [101, '100%'], [NaN, '66%'], ['80', '66%']]) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { gitStatus: { iconSizePercent: value } } } }));
    assert.equal(badge.style.width, expected);
  }
  const manifest = require('../package.json'), properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
  const setting = properties['bitfroest.gitStatus.iconSizePercent'];
  assert.equal(setting.type, 'integer'); assert.equal(setting.default, 66);
  assert.equal(setting.minimum, 25); assert.equal(setting.maximum, 100); assert.equal(setting.scope, 'window');
  for (const file of ['../package.nls.json', '../package.nls.de.json']) assert.ok(require(file)[setting.description.replaceAll('%', '')]);
  const component = require('../licenses/components.json').find(component => component.name === 'Bootstrap Icons');
  assert.equal(component.license, 'MIT');
  const fs = require('node:fs'), path = require('node:path');
  assert.ok(component.files.every(file => fs.existsSync(path.join(__dirname, '..', file))));
});
