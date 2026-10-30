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
test('Shift F8 and Shift Delete invert the configured default rather than silently reusing F8', t => {
  for (const key of ['F8', 'Delete']) {
    const app = createApp(t, fixture(), { language: 'en' });
    app.key(key, { shiftKey: true });
    assert.match(app.document.querySelector('#modal-title').textContent, /permanently/i);
    submit(app);
    assert.equal(app.messages.find(message => message.type === 'filesystem-delete').useTrash, false);
  }
});
test('the native delete preference reverses the base and Shift modes', t => {
  const app = createApp(t, fixture());
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { deleteToTrash: false } } }));
  app.key('F8', { shiftKey: true }); submit(app);
  assert.equal(app.messages.find(message => message.type === 'filesystem-delete').useTrash, true);
});
test('delete cancellation sends no native delete request', t => {
  const app = createApp(t, fixture()); app.key('F8'); app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'keep');
});
