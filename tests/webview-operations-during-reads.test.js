const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const folders = {};
  for (const path of ['C:/left', 'C:/right']) {
    folders[path] = [
      { id: `${path}/file`, name: path === 'C:/left' ? 'file.txt' : 'other.txt', type: 'text', fsSource: `${path}/file.txt`, size: 4 },
      { id: `${path}/archive`, name: 'archive.zip', type: 'archive', fsSource: `${path}/archive.zip`, size: 4 },
      { id: `${path}/folder`, name: 'folder', type: 'folder', fsSource: `${path}/folder` }
    ];
    folders[`${path}/folder`] = [];
  }
  return { version: 1, realFilesystem: true, snapshotId: 'confirmed', active: 0, panes: ['C:/left', 'C:/right'].map(pane), folders, unloadedFolders: ['C:/left/folder', 'C:/right/folder'] };
}
for (const command of ['delete-permanently', 'rename']) test(`${command} opens for an unread folder before preparing its selected subtree`, t => {
  const app = createApp(t, fixture());
  app.click(app.document.querySelector('[data-pane="1"] [data-file-row][data-id="C:/right/folder"] [data-filename]')); app.key('Enter');
  app.click(app.document.querySelector('[data-pane="0"] [data-file-row][data-id="C:/left/folder"] [data-filename]')); app.action(command);
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  if (command === 'rename') app.document.querySelector('#mask').value = 'chosen';
  submit(app);
  const preparation = app.messages.find(message => message.type === 'filesystem-prepare'); assert.ok(preparation);
  assert.deepEqual([...preparation.paths], ['C:/left/folder']);
  const fresh = app.state(); fresh.snapshotId = 'prepared'; fresh.unloadedFolders = ['C:/right/folder'];
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh, resumeAction: command } }));
  const operation = app.messages.find(message => message.type === (command === 'rename' ? 'filesystem-apply' : 'filesystem-delete'));
  assert.ok(operation, 'only the selected subtree is prepared before performing the confirmed operation');
  if (command === 'rename') assert.ok(operation.state.folders['C:/left'].some(row => row.name === 'chosen'));
});
for (const reading of ['left', 'right', 'both', 'refresh']) for (const command of ['copy', 'move', 'pack', 'unpack', 'delete-permanently', 'mkdir', 'new-file', 'rename']) {
  test(`${command} starts before ${reading} directory reads finish`, async t => {
    const app = createApp(t, fixture());
    if (reading === 'refresh') app.action('refresh');
    else for (const side of reading === 'both' ? [0, 1] : [reading === 'left' ? 0 : 1]) {
      app.click(app.document.querySelector(`[data-pane="${side}"] [data-file-row][data-id="C:/${side ? 'right' : 'left'}/folder"] [data-filename]`));
      app.action('open-dir-tab'); app.action('previous-tab');
    }
    const requests = app.messages.filter(message => ['filesystem-navigate', 'filesystem-refresh'].includes(message.type));
    assert.ok(requests.length);
    app.click(app.document.querySelector(`[data-pane="0"] [data-file-row][data-id="C:/left/${command === 'unpack' ? 'archive' : 'file'}"] [data-filename]`));
    app.action(command);
    assert.equal(app.document.querySelector('#modal').open, true, 'the operation dialog opens without a directory response');
    if (['mkdir', 'new-file'].includes(command)) app.document.querySelector('#value').value = command === 'mkdir' ? 'created' : 'created.txt';
    if (command === 'rename') app.document.querySelector('#mask').value = 'renamed';
    submit(app); await tick();
    const expected = command === 'pack' ? 'zip-write' : command === 'unpack' ? 'zip-unpack' : command === 'delete-permanently' ? 'filesystem-delete' : 'filesystem-apply';
    const operation = app.messages.find(message => message.type === expected);
    assert.ok(operation, 'the confirmed operation reaches the host before either directory response');
    const state = app.state();
    for (const request of requests) app.window.dispatchEvent(new app.window.MessageEvent('message', { data: {
      type: 'filesystem-result', ok: true, state: { ...fixture(), snapshotId: 'obsolete' },
      ...(request.navigationRequestId ? { navigationRequestId: request.navigationRequestId } : { refreshRequestId: request.refreshRequestId })
    } }));
    assert.equal(app.state().snapshotId, state.snapshotId, 'superseded reads cannot replace the operation state');
  });
}
test('refresh permits keyboard marking and inline rename before its response', t => {
  const app = createApp(t, fixture()); app.action('refresh');
  app.click(app.document.querySelector('[data-pane="0"] [data-file-row][data-id="C:/left/file"] [data-filename]'));
  app.key(' ');
  assert.ok(app.state().panes[0].spaceMarked?.includes('C:/left/file'));
  app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input);
  input.value = 'changed.txt'; app.key('Enter', {}, input);
  assert.ok(app.messages.some(message => message.type === 'filesystem-apply'));
});
test('refresh permits dragging a visible selection to the opposite pane', t => {
  const app = createApp(t, fixture()); app.action('refresh');
  const source = app.document.querySelector('[data-pane="0"] [data-file-row][data-id="C:/left/file"] [data-filename]'); app.click(source);
  const values = new Map(), data = { setData: (key, value) => values.set(key, value), getData: key => values.get(key) || '' };
  const drag = (type, target) => { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: data }); target.dispatchEvent(event); };
  drag('dragstart', source); drag('drop', app.document.querySelector('[data-pane="1"] .list'));
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.match(app.document.querySelector('#modal-title').textContent, /Kopieren/);
});
test('paste reads the clipboard and starts its transfer while refresh is pending', async t => {
  const app = createApp(t, fixture()); app.action('refresh');
  app.click(app.document.querySelector('[data-pane="1"] .list'));
  app.document.querySelector('[data-pane="1"] .list').focus();
  app.action('clipboard-paste');
  const request = app.messages.find(message => message.type === 'clipboard-read'); assert.ok(request);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true,
    selection: { paths: ['C:/left/file.txt'], mode: 'copy', source: 'internal' } } }));
  await tick();
  assert.ok(app.messages.some(message => message.type === 'filesystem-apply'));
});
test('packing remains available while the opposite archive view is opening', t => {
  const app = createApp(t, fixture());
  app.click(app.document.querySelector('[data-pane="1"] [data-file-row][data-id="C:/right/archive"] [data-filename]')); app.key('Enter');
  const opening = app.messages.find(message => message.type === 'zip-open'); assert.ok(opening);
  app.click(app.document.querySelector('[data-pane="0"] [data-file-row][data-id="C:/left/file"] [data-filename]')); app.action('pack');
  assert.equal(app.document.querySelector('#modal').open, true); submit(app);
  assert.ok(app.messages.some(message => message.type === 'zip-write'));
});
test('an interrupted directory read resumes only after the confirmed copy completes', async t => {
  const app = createApp(t, fixture());
  app.click(app.document.querySelector('[data-pane="0"] [data-file-row][data-id="C:/left/folder"] [data-filename]')); app.action('open-dir-tab'); app.action('previous-tab');
  const first = app.messages.find(message => message.type === 'filesystem-navigate');
  app.click(app.document.querySelector('[data-pane="1"] [data-file-row][data-id="C:/right/file"] [data-filename]')); app.action('copy');
  assert.equal(app.messages.some(message => message.type === 'filesystem-read-cancel'), false, 'opening a dialog does not interrupt a read');
  submit(app); await tick();
  const copy = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(copy);
  assert.equal(app.messages.filter(message => message.type === 'filesystem-navigate').length, 2);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: copy.operationId, ok: true, state: { ...copy.state, snapshotId: 'copied' } } }));
  const next = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.notEqual(next.navigationRequestId, first.navigationRequestId); assert.equal(next.path, 'C:/left'); assert.equal(next.side, first.side);
});
