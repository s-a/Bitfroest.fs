const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['file'], cursor: 'file', filter: '', sort: 'size', descending: true });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', panes: [pane('C:/tmp'), { ...pane('C:/temp'), selected: [], cursor: null }], folders: { 'C:/tmp': [{ id: 'file', name: 'keep.txt', fsSource: 'C:/tmp/keep.txt', type: 'text', size: 4 }], 'C:/temp': [] } };
}
function focus(app) { app.window.dispatchEvent(new app.window.Event('focus')); }
function refreshes(app) { return app.messages.filter(message => message.type === 'filesystem-refresh'); }
test('returning focus refreshes real directories with current tabs, selection and sort', t => {
  const app = createApp(t, fixture());
  focus(app);
  const request = refreshes(app).at(-1);
  assert.ok(request);
  assert.equal(request.state.panes[0].sort, 'size');
  assert.equal(request.state.panes[0].descending, true);
  assert.deepEqual(request.state.panes[0].selected, ['file']);
  assert.equal(request.state.panes[0].cursor, 'file');
  assert.deepEqual(request.state.panes[0].tabs, ['C:/tmp']);
});
test('focus refresh waits until a folder dialog closes', async t => {
  const app = createApp(t, fixture());
  app.action('mkdir'); focus(app);
  assert.equal(refreshes(app).length, 0);
  app.click(app.document.querySelector('#modal-cancel'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes(app).length, 1);
});
test('focus while a filesystem operation is pending schedules one refresh after its result', t => {
  const saved = fixture(), app = createApp(t, saved);
  app.action('refresh');
  focus(app); focus(app);
  assert.equal(refreshes(app).length, 1);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: saved } }));
  assert.equal(refreshes(app).length, 2);
});
test('browser sample mode does not request filesystem refresh on focus', t => {
  const app = createApp(t);
  focus(app); assert.equal(refreshes(app).length, 0);
});

test('returning focus during a copy conflict preserves the dialog until cancellation and coalesces refresh', async t => {
  const saved = fixture();
  saved.folders['C:/temp'].push({ id: 'target', name: 'keep.txt', fsSource: 'C:/temp/keep.txt', type: 'text', size: 3 });
  const app = createApp(t, saved);
  app.action('copy');
  app.document.querySelector('#modal-form').requestSubmit();
  await new Promise(resolve => setImmediate(resolve));
  const input = app.document.querySelector('#conflict-name');
  assert.ok(input); input.value = 'custom.txt';
  focus(app); focus(app);
  assert.equal(refreshes(app).length, 0);
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(input.value, 'custom.txt');
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.click(app.document.querySelector('[data-conflict-action="cancel"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes(app).length, 1);
  assert.deepEqual(Array.from(app.state().panes[0].selected), ['file']);
});
