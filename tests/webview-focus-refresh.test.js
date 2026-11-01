const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['file'], cursor: 'file', filter: '', sort: 'size', descending: true });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', panes: [pane('C:/tmp'), { ...pane('C:/temp'), selected: [], cursor: null }], folders: { 'C:/tmp': [{ id: 'file', name: 'keep.txt', fsSource: 'C:/tmp/keep.txt', type: 'text', size: 4 }], 'C:/temp': [] } };
}
function focus(app) { app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'window-focus' } })); }
function refreshes(app) { return app.messages.filter(message => message.type === 'filesystem-refresh'); }

function result(app, state, ok = true) {
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok, state } }));
}

test('DOM focus changes do not duplicate the refresh requested by the host window transition', t => {
  const app = createApp(t, fixture());
  app.window.dispatchEvent(new app.window.Event('blur'));
  app.window.dispatchEvent(new app.window.Event('focus'));
  assert.equal(refreshes(app).length, 0);
  focus(app);
  assert.equal(refreshes(app).length, 1);
});

test('refresh patches changed cells and keyed rows without replacing the list or unchanged icons', t => {
  const original = fixture(); original.folders['C:/tmp'].push({ id: 'second', name: 'second.txt', type: 'text', size: 2, fsSource: 'C:/tmp/second.txt' });
  const app = createApp(t, original), list = app.document.querySelector('[data-pane="0"] .list');
  const keep = app.row('keep.txt'), icon = keep.querySelector('.fileicon'), second = app.row('second.txt');
  list.scrollTop = 81;
  focus(app);
  const next = structuredClone(refreshes(app).at(-1).state); next.snapshotId = 'rows-two';
  next.folders['C:/tmp'][1].size = 20;
  next.folders['C:/tmp'].push({ id: 'new', name: 'new.txt', type: 'text', size: 1, fsSource: 'C:/tmp/new.txt' });
  result(app, next);
  assert.equal(app.document.querySelector('[data-pane="0"] .list'), list);
  assert.equal(app.row('keep.txt'), keep); assert.equal(keep.querySelector('.fileicon'), icon);
  assert.equal(app.row('second.txt'), second);
  assert.match(second.textContent, /20/);
  assert.ok(app.row('new.txt'));
  assert.equal(list.scrollTop, 81);
  focus(app);
  const removed = structuredClone(refreshes(app).at(-1).state); removed.snapshotId = 'rows-three';
  removed.folders['C:/tmp'] = removed.folders['C:/tmp'].filter(file => file.id !== 'second'); result(app, removed);
  assert.equal(app.row('second.txt'), undefined);
  assert.equal(app.row('keep.txt'), keep);
});

test('returning window focus requests Git status once after the refreshed snapshot arrives', t => {
  const app = createApp(t, fixture());
  assert.equal(app.messages.filter(message => message.type === 'git-status').length, 1);
  focus(app);
  assert.equal(refreshes(app).length, 1);
  assert.equal(app.messages.filter(message => message.type === 'git-status').length, 1);
  const next = structuredClone(refreshes(app)[0].state); next.snapshotId = 'focus-snapshot';
  result(app, next);
  const git = app.messages.filter(message => message.type === 'git-status');
  assert.equal(git.length, 2);
  assert.equal(git[1].snapshotId, 'focus-snapshot');
  assert.deepEqual(Array.from(git[1].directories), ['C:/tmp', 'C:/temp']);
  assert.equal(refreshes(app).length, 1);
});

test('returning from an unconfirmed favorite keeps unchanged lists, rows, icons and scroll position', t => {
  const app = createApp(t, fixture());
  const lists = [...app.document.querySelectorAll('.list')];
  const row = app.row('keep.txt');
  const request = app.messages.find(message => message.type === 'icons');
  const key = request.requests[0].key;
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { [key]: 'data:image/png;base64,AAAA' } } }));
  const icon = row.querySelector('img.native-icon');
  assert.ok(icon);
  const iconRequests = app.messages.filter(message => message.type === 'icons').length;
  lists[0].scrollTop = 135;
  app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-favorite-toggle]'));
  app.window.dispatchEvent(new app.window.Event('blur'));
  app.click(row);
  focus(app);
  const next = structuredClone(refreshes(app).at(-1).state);
  next.snapshotId = 'two';
  result(app, next);
  lists.forEach((list, side) => assert.equal(app.document.querySelectorAll('.list')[side], list));
  assert.equal(app.row('keep.txt'), row);
  assert.equal(row.querySelector('img.native-icon'), icon);
  assert.equal(lists[0].scrollTop, 135);
  assert.equal(app.document.activeElement, lists[0]);
  assert.equal(app.messages.filter(message => message.type === 'icons').length, iconRequests);
  assert.equal(app.document.querySelector('#panes').inert, false);
  assert.equal(app.state().snapshotId, 'two');
});

test('focus refresh updates a changed directory while preserving the opposite list', t => {
  const app = createApp(t, fixture());
  const lists = [...app.document.querySelectorAll('.list')];
  focus(app);
  const next = structuredClone(refreshes(app).at(-1).state);
  next.folders['C:/tmp'].push({ id: 'new', name: 'new.txt', type: 'text', size: 9 });
  next.snapshotId = 'two';
  result(app, next);
  assert.ok(app.row('new.txt'));
  assert.equal(app.document.querySelectorAll('.list')[0], lists[0]);
  assert.equal(app.document.querySelectorAll('.list')[1], lists[1]);
  assert.equal(app.row('keep.txt').getAttribute('aria-selected'), 'true');
});

test('explicit refresh renews native icons even when directory contents are unchanged', t => {
  const app = createApp(t, fixture());
  const iconRequests = app.messages.filter(message => message.type === 'icons').length;
  app.action('refresh');
  result(app, structuredClone(refreshes(app).at(-1).state));
  assert.equal(app.messages.filter(message => message.type === 'icons').length, iconRequests + 1);
});

test('focus refresh renews the icon of a changed file without clearing unchanged file icons', t => {
  const saved = fixture();
  saved.folders['C:/tmp'].push({ id: 'other', name: 'other.txt', fsSource: 'C:/tmp/other.txt', type: 'text', size: 1 });
  const app = createApp(t, saved);
  const count = app.messages.filter(message => message.type === 'icons').length;
  focus(app);
  const next = structuredClone(refreshes(app).at(-1).state);
  next.folders['C:/tmp'][0].size++;
  result(app, next);
  const requests = app.messages.filter(message => message.type === 'icons');
  assert.equal(requests.length, count + 1);
  assert.deepEqual(Array.from(requests.at(-1).requests, item => item.path), ['C:/tmp/keep.txt']);
});

test('refresh with a lister on the opposite side preserves the visible list scroll and viewer', t => {
  const app = createApp(t, fixture());
  app.action('view');
  const viewer = app.document.querySelector('.pane [data-lister]');
  assert.ok(viewer);
  const list = app.document.querySelector('[data-pane="1"] .list');
  app.click(list);
  list.scrollTop = 73;
  focus(app);
  result(app, structuredClone(refreshes(app).at(-1).state));
  assert.equal(app.document.querySelector('.pane [data-lister]'), viewer);
  assert.equal(app.document.querySelector('[data-pane="1"] .list'), list);
  assert.equal(list.scrollTop, 73);
  assert.equal(app.document.activeElement, list);
});
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
