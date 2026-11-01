const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function initial() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  return { version: 1, realFilesystem: true, snapshotId: 'zip', active: 0, panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'zip', name: 'sample.zip', type: 'archive', size: 300, fsSource: 'C:/tmp/sample.zip' }], 'C:/temp': [] } };
}

for (const [name, type, expected] of [
  ['report.txt', 'text', 'report.zip'],
  ['report.final.txt', 'text', 'report.final.zip'],
  ['Documents', 'folder', 'Documents.zip'],
  ['Release.2026', 'folder', 'Release.2026.zip'],
  ['LICENSE', 'text', 'LICENSE.zip'],
  ['.config', 'text', '.config.zip'],
]) {
  test(`pack dialog suggests the selected entry name for ${name}`, t => {
    const state = initial();
    state.folders['C:/tmp'] = [{ id: 'chosen', name, type }, { id: 'other', name: 'other.txt', type: 'text' }];
    state.panes[0].selected = ['chosen'];
    state.panes[0].cursor = 'other';
    const app = createApp(t, state, { platform: 'win32' });
    app.action('pack');
    assert.equal(app.document.querySelector('#value').value, `C:\\temp\\${expected}`);
    assert.equal(app.messages.some(message => message.type === 'zip-write'), false);
    app.document.querySelector('#value').value = 'C:\\temp\\Custom.zip';
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    const request = app.messages.find(message => message.type === 'zip-write');
    assert.equal(request.archive, 'C:/temp/Custom.zip');
    assert.deepEqual([...request.ids], ['chosen']);
  });
}

test('pack dialog uses the cursor without marks and the source folder for multiple marks', t => {
  for (const multiple of [false, true]) {
    const state = initial();
    state.folders['C:/tmp'] = [{ id: 'one', name: 'One.txt', type: 'text' }, { id: 'two', name: 'Two.txt', type: 'text' }];
    state.panes[0].cursor = 'two';
    state.panes[0].selected = multiple ? ['one', 'two'] : [];
    const app = createApp(t, state, { platform: 'win32' });
    app.action('pack');
    assert.equal(app.document.querySelector('#value').value, `C:\\temp\\${multiple ? 'tmp' : 'Two'}.zip`);
  }
});
test('real ZIP activation requests metadata, enters only after host response, and leaves archive root', t => {
  const app = createApp(t, initial());
  app.click(app.row('sample.zip')); app.key('Enter');
  const request = app.messages.find(message => message.type === 'zip-open');
  assert.ok(request); assert.equal(request.path, 'C:/tmp/sample.zip');
  assert.equal(app.messages.some(message => message.type === 'open'), false);
  assert.equal(app.state().panes[0].tabs[0], 'C:/tmp');
  const state = initial(), root = 'zip:C%3A%2Ftmp%2Fsample.zip!';
  state.folders[root] = [{ id: 'folder', name: 'docs', type: 'folder', archive: 'C:/tmp/sample.zip' }];
  state.folders[`${root}/docs`] = [];
  state.archiveLocations = { [root]: { archive: 'C:/tmp/sample.zip', parent: 'C:/tmp' }, [`${root}/docs`]: { archive: 'C:/tmp/sample.zip', parent: root } };
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state, resumeNavigation: { side: 0, path: root } } }));
  assert.equal(app.state().panes[0].tabs[0], root);
  assert.equal(app.document.querySelector('.pane.active .path-input').value, 'C:\\tmp\\sample.zip!');
  assert.match(app.document.querySelector('#status-message').textContent, /Verzeichnis geöffnet: C:\\tmp\\sample\.zip!/);
  app.click(app.row('docs')); app.key('Enter'); assert.equal(app.state().panes[0].tabs[0], `${root}/docs`);
  assert.match(app.document.querySelector('#status-message').textContent, /Verzeichnis geöffnet: C:\\tmp\\sample\.zip!\\docs/);
  app.key('Backspace'); app.key('Backspace'); assert.equal(app.state().panes[0].tabs[0], 'C:/tmp');
});
test('ZIP F5 waits for confirmation and sends selected IDs; writes and moves stay unavailable', t => {
  const state = initial(), root = 'zip:C%3A%2Ftmp%2Fsample.zip!';
  state.panes[0].tabs = [root];
  state.folders[root] = [{ id: 'inside', name: 'file.txt', type: 'text', archive: 'C:/tmp/sample.zip', size: 5 }];
  state.archiveLocations = { [root]: { archive: 'C:/tmp/sample.zip', parent: 'C:/tmp' } };
  const app = createApp(t, state);
  app.click(app.row('file.txt')); app.action('move');
  assert.equal(app.document.querySelector('#modal').open, false);
  app.action('copy'); assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#value').value, 'C:\\temp');
  assert.equal(app.messages.some(message => message.type === 'zip-copy'), false);
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = app.messages.find(message => message.type === 'zip-copy');
  assert.ok(request); assert.deepEqual([...request.ids], ['inside']); assert.equal(request.target, 'C:/temp');
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, error: 'broken', state, operationId: request.operationId } }));
  assert.equal(app.document.querySelector('#functionbar').inert, false);
});
