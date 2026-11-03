const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'delete', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', fsSource: 'C:/tmp/a.txt', content: 'keep' }], 'C:/temp': [] } };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
test('F8 defaults to trash and preserves its snapshot while awaiting the host', t => {
  const app = createApp(t, fixture(), { language: 'en' });
  app.key('F8');
  assert.match(app.document.querySelector('#modal-title').textContent, /Recycle Bin|Trash/);
  submit(app);
  const request = app.messages.find(message => message.type === 'filesystem-delete');
  assert.ok(request); assert.equal(request.useTrash, true); assert.deepEqual(request.paths, ['C:/tmp/a.txt']);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'keep');
});
test('Shift F8 and Shift Delete confirm permanent deletion', t => {
  for (const key of ['F8', 'Delete']) {
    const app = createApp(t, fixture(), { language: 'en' });
    app.key(key, { shiftKey: true });
    assert.match(app.document.querySelector('#modal-title').textContent, /permanently/i);
    submit(app);
    assert.equal(app.messages.find(message => message.type === 'filesystem-delete').useTrash, false);
  }
});
test('obsolete delete preferences cannot change normal deletion to permanent deletion', t => {
  const app = createApp(t, fixture());
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { deleteToTrash: false } } }));
  app.key('F8'); submit(app);
  assert.equal(app.messages.find(message => message.type === 'filesystem-delete').useTrash, true);
});

test('the extension exposes no configurable trash deletion mode', () => {
  const manifest = require('../package.json');
  const sections = [].concat(manifest.contributes.configuration);
  assert.equal(sections.some(section => Object.hasOwn(section.properties, 'bitfroest.files.deleteToTrash')), false);
});

test('Shift Delete always bypasses trash with an explicit cancellable warning', t => {
  for (const language of ['de', 'en']) for (const deleteToTrash of [true, false]) {
    const app = createApp(t, fixture(), { language, fileSettings: { deleteToTrash } });
    app.key('Delete', { shiftKey: true });
    const warning = app.document.querySelector('#modal-description');
    assert.ok(warning);
    assert.match(warning.textContent, language === 'de' ? /nicht in den Papierkorb/ : /without.*Recycle Bin/);
    assert.equal(app.document.activeElement, app.document.querySelector('#modal-cancel'));
    assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
    app.key('Escape');
    assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
    app.key('Delete', { shiftKey: true }); submit(app);
    assert.equal(app.messages.find(message => message.type === 'filesystem-delete').useTrash, false);
  }
});
test('network deletion announces permanent deletion before deleting an unloaded folder', t => {
  const saved = fixture(); saved.networkDirectories = ['c:/TMP'];
  saved.folders['C:/tmp'][0] = { id: 'a', name: 'folder', type: 'folder', fsSource: 'C:/tmp/folder' };
  saved.folders['C:/tmp/folder'] = []; saved.unloadedFolders = ['C:/tmp/folder'];
  const app = createApp(t, saved, { language: 'en' }); app.key('Delete');
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Delete permanently?');
  assert.equal(app.document.querySelector('#modal-confirm').textContent, 'Delete permanently');
  assert.match(app.document.querySelector('#modal-body').textContent, /network/i);
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
});

test('a network file is deleted permanently only after explicit confirmation', t => {
  const saved = fixture(); saved.networkDirectories = ['C:/tmp'];
  const app = createApp(t, saved); app.key('Delete'); submit(app);
  const request = app.messages.find(message => message.type === 'filesystem-delete');
  assert.equal(request.useTrash, false);
});

test('mixed search results keep trash for local files and explicitly confirm network targets', t => {
  const saved = fixture(); saved.networkDirectories = ['C:/tmp/network'];
  const network = { id: 'network', name: 'remote.txt', type: 'text', fsSource: 'C:/tmp/network/remote.txt' };
  saved.folders['C:/tmp/network'] = [network];
  saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { id: 'mixed', source: 'C:/tmp', paths: ['C:/tmp/a.txt', network.fsSource] } }];
  saved.panes[0].selected = ['a', 'network'];
  const app = createApp(t, saved, { language: 'en' }); app.key('Delete');
  const body = app.document.querySelector('#modal-body').textContent;
  assert.match(body, /Local entries.*Recycle Bin/); assert.match(body, /Network paths.*permanently/); assert.match(body, /remote\.txt/);
  submit(app);
  const request = app.messages.find(message => message.type === 'filesystem-delete');
  assert.equal(request.useTrash, true);
  assert.deepEqual(Array.from(request.confirmedNetworkPaths), [network.fsSource]);
});

test('delete cancellation sends no native delete request', t => {
  const app = createApp(t, fixture()); app.key('F8'); app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'keep');
});
