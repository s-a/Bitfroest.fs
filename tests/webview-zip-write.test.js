const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function state(inside = false) {
  const root = 'zip:C%3A%2Ftmp%2Ftest.zip!';
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  return { version: 1, realFilesystem: true, snapshotId: 'write', active: 0, panes: [pane(inside ? root : 'C:/tmp'), pane('C:/temp')],
    folders: { 'C:/tmp': [{ id: 'source', name: 'file.txt', type: 'text', fsSource: 'C:/tmp/file.txt' }], 'C:/temp': [], [root]: [{ id: 'entry', name: 'file.txt', type: 'text', fsSource: root + '/file.txt', archive: 'C:/tmp/test.zip', archiveEntry: 'file.txt', size: 5 }] },
    archiveLocations: { [root]: { archive: 'C:/tmp/test.zip', parent: 'C:/tmp' } } };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
test('ZIP-F17/F18/F27 pack dialog is immediately usable and sends options without passwords', t => {
  const app = createApp(t, state()); app.click(app.row('file.txt')); app.action('pack');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.some(message => /zip-write|filesystem-prepare/.test(message.type)), false);
  app.document.querySelector('#value').value = 'C:/temp/result.zip';
  app.document.querySelector('#zip-encryption').value = 'aes256'; submit(app);
  const message = app.messages.find(message => message.type === 'zip-write');
  assert.ok(message); assert.equal(message.archive, 'C:/temp/result.zip'); assert.equal(message.encryption, 'aes256');
  assert.deepEqual([...message.ids], ['source']); assert.equal(Object.hasOwn(message, 'password'), false);
});
test('ZIP-F23 delete needs confirmation and does not optimistically remove the row', t => {
  const app = createApp(t, state(true)); app.click(app.row('file.txt')); app.action('delete');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.some(message => message.type === 'zip-write'), false); submit(app);
  const message = app.messages.find(message => message.type === 'zip-write');
  assert.equal(message?.action, 'remove'); assert.ok(app.row('file.txt'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
test('ZIP-F24 Shift F6 keeps inline editing and commits through the archive host operation', t => {
  const app = createApp(t, state(true)); app.click(app.row('file.txt')); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input); input.value = 'renamed.txt'; app.key('Enter', {}, input);
  const message = app.messages.find(message => message.type === 'zip-write');
  assert.equal(message?.action, 'rename'); assert.equal(message.name, 'renamed.txt');
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
test('ZIP-F10 unpack dialog exposes mask, paths and separate archive folders before running', t => {
  const saved = state(); saved.folders['C:/tmp'][0] = { id: 'archive', name: 'sample.zip', fsSource: 'C:/tmp/sample.zip', type: 'archive' };
  const app = createApp(t, saved); app.click(app.row('sample.zip')); app.action('unpack');
  assert.equal(app.document.querySelector('#modal').open, true);
  app.document.querySelector('#zip-filter').value = '*.txt'; app.document.querySelector('#zip-paths').checked = false;
  app.document.querySelector('#zip-separate').checked = true; submit(app);
  const request = app.messages.find(message => message.type === 'zip-unpack');
  assert.ok(request); assert.equal(request.filter, '*.txt'); assert.equal(request.paths, false); assert.equal(request.separate, true);
});
test('ZIP-F03 entry activation shows metadata without requesting content; F3 opens the selected entry', t => {
  const saved = state(true); saved.folders[saved.panes[0].tabs[0]][0].compressedSize = 2;
  const app = createApp(t, saved); app.click(app.row('file.txt')); app.key('Enter');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.match(app.document.querySelector('#modal-body').textContent, /file.txt/);
  assert.match(app.document.querySelector('#modal-body').textContent, /40 %/);
  assert.equal(app.messages.some(message => message.type === 'lister-open'), false);
  app.document.querySelector('#modal-cancel').click(); app.action('view');
  assert.ok(app.messages.find(message => message.type === 'lister-open'));
});
test('ZIP pack options use native configuration defaults and scoped pack-move command', t => {
  const app = createApp(t, state(), { fileSettings: { zip: { level: 0, paths: false, recursive: false } } });
  app.click(app.row('file.txt')); app.action('pack-move');
  assert.equal(app.document.querySelector('#zip-level')?.value, '0');
  assert.equal(app.document.querySelector('#zip-paths').checked, false);
  assert.equal(app.document.querySelector('#zip-move').checked, true);
  const manifest = require('../package.json');
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.pack-move');
  assert.equal(binding?.key, 'alt+shift+f5'); assert.match(binding.when, /listFocus.*!bitfroest.textInput/);
  const props = Object.assign({}, ...manifest.contributes.configuration.map(group => group.properties));
  assert.equal(props['bitfroest.zip.compressionLevel']?.type, 'integer');
});

test('ZIP-F17 edited pack destination takes effect when the opposite pane is inside an archive', t => {
  const saved = state(); saved.panes[1].tabs = [Object.keys(saved.archiveLocations)[0]];
  const app = createApp(t, saved); app.click(app.row('file.txt', 0)); app.action('copy');
  app.document.querySelector('#value').value = 'C:/temp/other.zip'; submit(app);
  const request = app.messages.find(message => message.type === 'zip-write');
  assert.equal(request.archive, 'C:/temp/other.zip'); assert.equal(request.path, undefined);
});

test('ZIP pack and extraction controls use the selected English interface language', t => {
  const app = createApp(t, state(), { language: 'en' }); app.click(app.row('file.txt')); app.action('pack');
  assert.match(app.document.querySelector('#modal-body').textContent, /Compression level/);
  assert.match(app.document.querySelector('#modal-body').textContent, /Encryption/);
  assert.doesNotMatch(app.document.querySelector('#modal-body').textContent, /Unterverzeichnisse|Quellen entfernen/);
});

test('ZIP-F25 F5 between archive panes starts a pack operation into the destination ZIP', t => {
  const saved = state(true), source = saved.panes[0].tabs[0], target = 'zip:C%3A%2Ftemp%2Ftarget.zip!';
  saved.panes[1].tabs = [target]; saved.folders[target] = []; saved.archiveLocations[target] = { archive: 'C:/temp/target.zip', parent: 'C:/temp' };
  const app = createApp(t, saved); app.click(app.row('file.txt', 0)); app.action('copy'); submit(app);
  const request = app.messages.find(message => message.type === 'zip-write');
  assert.equal(request?.path, target); assert.equal(request?.sourcePath, source); assert.equal(app.messages.some(message => message.type === 'zip-copy'), false);
});

test('ZIP post-pack cancellation displays that the archive was saved and releases the file list', t => {
  const saved = state(), app = createApp(t, saved); app.click(app.row('file.txt')); app.action('pack'); submit(app);
  const request = app.messages.find(message => message.type === 'zip-write'), notice = 'ZIP wurde gespeichert; Nachprüfung oder Quellentfernung wurde nicht abgeschlossen.';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, state: saved, ok: true, cancelled: true, archiveCommitted: true, notice } }));
  assert.equal(app.document.querySelector('#status-message').textContent, notice);
  assert.equal(app.document.querySelector('#panes').inert, false); assert.equal(app.document.querySelector('#status-cancel').hidden, true);
});

test('ZIP-F43 new text file opens its confirmed archive entry in the native editor', t => {
  const saved = state(true), source = saved.panes[0].tabs[0], app = createApp(t, saved); app.action('new-file');
  app.document.querySelector('#value').value = 'new.txt'; submit(app);
  const request = app.messages.find(message => message.type === 'zip-write'); assert.equal(app.messages.some(message => message.type === 'edit'), false);
  saved.folders[source].push({ id: 'new', name: 'new.txt', archive: 'C:/tmp/test.zip', archiveEntry: 'new.txt', fsSource: source + '/new.txt' });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, operationId: request.operationId, state: saved } }));
  assert.equal(app.messages.find(message => message.type === 'edit')?.path, source + '/new.txt');
});
