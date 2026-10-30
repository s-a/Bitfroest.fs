const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const pane = () => ({ tabs: ['/repo'], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'one', active: 0, panes: [pane(), pane()], folders: { '/repo': [{ id: 'a', name: 'a.txt', type: 'text' }, { id: 'b', name: 'folder', type: 'folder' }], '/repo/folder': [] } };
}
function reply(app, request, extra = {}) {
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/repo': { ok: true, repository: true, branch: 'feature/<one>', statuses: { 'a.txt': 'modified', folder: 'conflict' } } }, ...extra } }));
}

test('both panels share a status request and async badges preserve path editing, selection and scroll', t => {
  const app = createApp(t, fixture());
  const requests = app.messages.filter(m => m.type === 'git-status'); assert.equal(requests.length, 1);
  assert.deepEqual(Array.from(requests[0].directories), ['/repo']);
  const input = app.document.querySelector('.path-input'); input.focus(); input.value = '/unfinished'; input.setSelectionRange(2, 5);
  const row = app.row('a.txt'), list = app.document.querySelector('.list'); list.scrollTop = 123;
  reply(app, requests[0]);
  assert.equal(app.document.activeElement, input); assert.equal(input.value, '/unfinished'); assert.equal(input.selectionStart, 2);
  assert.equal(app.row('a.txt'), row); assert.equal(list.scrollTop, 123); assert.deepEqual(app.state().panes[0].selected, ['a']);
  assert.equal(app.document.querySelectorAll('[data-git-branch]').length, 2);
  assert.equal(app.document.querySelector('[data-git-branch]').textContent, '(feature/<one>)');
  assert.equal(row.querySelector('[data-git-status]').dataset.gitStatus, 'modified');
  assert.equal(app.row('folder').querySelector('[data-git-status]').dataset.gitStatus, 'conflict');
  app.key('ArrowDown', {}, list);
  assert.equal(app.messages.filter(m => m.type === 'git-status').length, 1);
  assert.equal(JSON.stringify(app.state()).includes('statuses'), false);
});

test('branch button requests local count without changing directory or triggering a file operation', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status'); assert.ok(request);
  reply(app, request); app.click(app.document.querySelector('[data-git-branch]'));
  const branches = app.messages.find(m => m.type === 'git-branches'); assert.ok(branches); assert.equal(branches.path, '/repo');
  assert.equal(app.state().panes[0].tabs[0], '/repo'); assert.equal(app.messages.some(m => m.type === 'filesystem-apply'), false);
});

test('late status from before restore is rejected and native icon responses retain overlays', t => {
  const app = createApp(t, fixture()), old = app.messages.find(m => m.type === 'git-status'); assert.ok(old);
  const fresh = fixture(); fresh.snapshotId = 'two';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: fresh } }));
  reply(app, old); assert.equal(app.document.querySelector('[data-git-branch]'), null);
  const next = app.messages.filter(m => m.type === 'git-status').at(-1); reply(app, next);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { '/repo/a.txt': 'data:image/png;base64,iVBORw0KGgo=' } } }));
  assert.ok(app.row('a.txt').querySelector('img.fileicon')); assert.ok(app.row('a.txt').querySelector('[data-git-status]'));
});

test('unavailable and non-repository status never create a clean badge or branch', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status'); assert.ok(request);
  reply(app, request, { directories: { '/repo': { ok: false, error: 'Unsupported index', statuses: {} } } });
  assert.equal(app.document.querySelector('[data-git-branch]'), null); assert.equal(app.document.querySelector('[data-git-status="clean"]'), null);
  assert.match(app.document.querySelector('.path-input').title, /Unsupported index/);
});

test('settings invalidation clears badges and requests a new read without stealing branch focus', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
  reply(app, request);
  const branch = app.document.querySelector('[data-git-branch]'); branch.focus();
  reply(app, request);
  assert.equal(app.document.activeElement, branch);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-settings-changed' } }));
  assert.equal(app.document.querySelector('[data-git-status]'), null);
  assert.equal(app.messages.filter(m => m.type === 'git-status').length, 2);
});

test('navigation finishes while status is pending and old directory results cannot decorate the destination', t => {
  const app = createApp(t, fixture()), first = app.messages.find(m => m.type === 'git-status');
  app.click(app.row('folder').querySelector('[data-filename]')); app.key('Enter', {}, app.document.querySelector('.pane.active .list'));
  assert.equal(app.state().panes[0].tabs[0], '/repo/folder');
  assert.equal(app.document.querySelector('.pane.active .path-input').value, '/repo/folder');
  const next = app.messages.filter(m => m.type === 'git-status').at(-1); assert.notEqual(next.requestId, first.requestId);
  reply(app, first); assert.equal(app.document.querySelector('.pane.active [data-git-branch]'), null);
});

test('identical background status keeps existing icon elements and branch focus', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
  reply(app, request);
  const icon = app.row('a.txt').querySelector('.fileicon'), badge = app.row('a.txt').querySelector('[data-git-status]');
  const branch = app.document.querySelector('[data-git-branch]'); branch.focus();
  reply(app, request);
  assert.equal(app.row('a.txt').querySelector('.fileicon'), icon); assert.equal(app.row('a.txt').querySelector('[data-git-status]'), badge);
  assert.equal(app.document.activeElement, branch);
});
