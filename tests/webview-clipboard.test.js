const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(real = false) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: real, snapshotId: 'clip-one', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', size: 3, content: 'new', fsSource: 'C:/tmp/a.txt' }], 'C:/temp': [] } };
}
function respond(app, request, extra = {}) {
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, ...extra } }));
}
function submit(app) { app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); }
function select(app) { app.click(app.row('a.txt').querySelector('[data-filename]')); }
test('internal copy/paste opens the regular transfer dialog and preserves source bytes', async t => {
  const app = createApp(t, fixture()); select(app);
  app.key('c', { ctrlKey: true }); app.key('Tab'); app.key('v', { ctrlKey: true });
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.match(app.document.querySelector('#modal-title').textContent, /Kopieren/);
  submit(app); await tick();
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
  assert.equal(app.state().folders['C:/temp'][0].content, 'new');
  assert.equal(app.state().panes[0].tabs[0], 'C:/tmp');
});
test('real cut never acknowledges the system clipboard before host transfer confirmation', async t => {
  const saved = fixture(true), app = createApp(t, saved); select(app);
  app.key('x', { ctrlKey: true });
  const write = app.messages.find(message => message.type === 'clipboard-write'); assert.ok(write);
  const selection = { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'native-clip', source: 'system' };
  respond(app, write, { selection }); app.key('Tab'); app.key('v', { ctrlKey: true });
  const read = app.messages.find(message => message.type === 'clipboard-read'); assert.ok(read);
  respond(app, read, { selection }); submit(app); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  assert.equal(app.messages.some(message => message.type === 'clipboard-ack'), false);
  const confirmed = structuredClone(apply.state); confirmed.snapshotId = 'clip-two'; confirmed.folders['C:/temp'][0].fsSource = 'C:/temp/a.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: confirmed } })); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), []);
});
test('failed host commit keeps the cut source available and does not acknowledge clipboard', async t => {
  const saved = fixture(true), original = structuredClone(saved), app = createApp(t, saved); select(app); app.key('x', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'failed', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection }); app.key('Tab'); app.key('v', { ctrlKey: true });
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection }); submit(app); await tick();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: original } })); await tick();
  assert.equal(app.messages.some(message => message.type === 'clipboard-ack'), false);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
});
test('copy/cut shortcuts leave text fields and unrelated modifiers alone', t => {
  const app = createApp(t, fixture(true)); select(app);
  app.key('x', { ctrlKey: true, shiftKey: true });
  app.key('c', { ctrlKey: true }, app.document.querySelector('.path-input'));
  assert.equal(app.messages.some(message => message.type === 'clipboard-write'), false);
});

test('native multi-directory cut preserves uncompleted groups when the next confirmation is cancelled', async t => {
  const saved = fixture(true); saved.folders['C:/tmp/nested'] = [{ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'two', fsSource: 'C:/tmp/nested/b.txt' }];
  const app = createApp(t, saved); app.key('Tab'); app.key('v', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/nested/b.txt', 'C:/tmp/a.txt'], mode: 'move', token: 'multiple', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection });
  assert.equal(app.document.querySelector('[data-transfer-source]').textContent, 'C:/tmp/nested');
  submit(app); await tick();
  const applied = app.messages.find(message => message.type === 'filesystem-apply');
  const confirmed = structuredClone(applied.state); confirmed.snapshotId = 'multi-two'; confirmed.folders['C:/temp'][0].fsSource = 'C:/temp/b.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: confirmed } })); await tick();
  assert.equal(app.document.querySelector('[data-transfer-source]').textContent, 'C:/tmp');
  assert.equal(app.state().panes[1].tabs[0], 'C:/temp');
  app.click(app.document.querySelector('#modal-cancel')); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), ['C:/tmp/a.txt']);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
});

test('failed preparation of a later cut group still acknowledges only earlier confirmed moves', async t => {
  const saved = fixture(true); saved.folders['C:/tmp'] = [{ id: 'folder', name: 'docs', type: 'folder', size: 0, fsSource: 'C:/tmp/docs' }];
  saved.folders['C:/tmp/docs'] = []; saved.unloadedFolders = ['C:/tmp/docs'];
  saved.folders['C:/tmp/nested'] = [{ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'two', fsSource: 'C:/tmp/nested/b.txt' }];
  const app = createApp(t, saved); app.key('Tab'); app.key('v', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/nested/b.txt', 'C:/tmp/docs'], mode: 'move', token: 'preparation', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection }); submit(app); await tick();
  const applied = app.messages.find(message => message.type === 'filesystem-apply'), confirmed = structuredClone(applied.state); confirmed.snapshotId = 'confirmed-first';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: confirmed } })); await tick();
  assert.equal(app.document.querySelector('[data-transfer-source]').textContent, 'C:/tmp');
  submit(app); await tick();
  assert.ok(app.messages.some(message => message.type === 'filesystem-prepare'));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: confirmed } })); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), ['C:/tmp/docs']);
});

test('partial native cut acknowledgement retains every source not actually moved', async t => {
  const saved = fixture(true); saved.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'two', fsSource: 'C:/tmp/b.txt' });
  const original = structuredClone(saved), app = createApp(t, saved);
  app.click(app.row('a.txt').querySelector('[data-filename]')); app.click(app.row('b.txt').querySelector('[data-filename]'), { ctrlKey: true }); app.key('x', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt'], mode: 'move', token: 'partial', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection }); app.key('Tab'); app.key('v', { ctrlKey: true });
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection }); submit(app); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-apply');
  original.folders['C:/temp'] = [{ ...original.folders['C:/tmp'][0], fsSource: 'C:/temp/a.txt' }]; original.folders['C:/tmp'] = original.folders['C:/tmp'].filter(file => file.id === 'b');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, ok: true, state: original, operationOutcome: { cancelled: true, completedIds: ['a'] } } })); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), ['C:/tmp/b.txt']);
});
