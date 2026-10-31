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

test('branch button requests available branches without changing directory or triggering a file operation', t => {
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

test('status badges use a circular white background at the bottom left', () => {
  const fs = require('node:fs'), path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  const rule = css.match(/\[data-git-status\]\s*\{([^}]+)\}/)[1];
  assert.match(rule, /left:\s*-?\d+px/);
  assert.match(rule, /border-radius:\s*50%/);
  assert.match(rule, /background:\s*(?:#fff(?:fff)?|white)\s*;/);
});

test('repository roots are decorated in a parent view without inventing its branch', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
  reply(app, request, { directories: { '/repo': { ok: true, repository: false, statuses: { folder: 'modified' } } } });
  assert.equal(app.row('folder').querySelector('[data-git-status]').dataset.gitStatus, 'modified');
  assert.equal(app.document.querySelector('[data-git-branch]'), null);
});

test('all Git states use fixed vector symbols and preserve status labels', t => {
  const state = fixture(), states = ['clean', 'modified', 'added', 'deleted', 'untracked', 'ignored', 'conflict'];
  state.folders['/repo'] = states.map((status, id) => ({ id: String(id), name: status + '.txt', type: 'text' }));
  const app = createApp(t, state), request = app.messages.find(message => message.type === 'git-status');
  reply(app, request, { directories: { '/repo': { ok: true, repository: true, statuses: Object.fromEntries(states.map(status => [status + '.txt', status])) } } });
  for (const status of states) {
    const badge = app.row(status + '.txt').querySelector('[data-git-status]');
    assert.ok(badge.querySelector('svg path'));
    assert.equal(badge.textContent.trim(), '');
    assert.ok(badge.getAttribute('aria-label'));
    assert.equal(badge.querySelector('svg').getAttribute('viewBox'), '0 0 16 16');
  }
});

test('status vector layout is centered independently of text baseline and font metrics', t => {
  const app = createApp(t, fixture());
  const style = app.document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.appendChild(style);
  reply(app, app.messages.find(message => message.type === 'git-status'));
  const badge = app.row('a.txt').querySelector('[data-git-status]'), computed = app.window.getComputedStyle(badge);
  assert.equal(computed.display, 'inline-flex');
  assert.equal(computed.alignItems, 'center');
  assert.equal(computed.justifyContent, 'center');
  assert.equal(computed.width, computed.height);
  const svg = app.window.getComputedStyle(badge.querySelector('svg'));
  assert.equal(svg.width, '100%'); assert.equal(svg.height, '100%');
  assert.equal(svg.display, 'block');
  assert.equal(Number(svg.strokeWidth), 0);
});

test('branch button uses theme accent text without a colored background', t => {
  const app = createApp(t, fixture());
  const style = app.document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.appendChild(style);
  reply(app, app.messages.find(message => message.type === 'git-status'));
  const rules = Array.from(style.sheet.cssRules);
  const rule = rules.find(rule => rule.selectorText === '[data-git-branch]').style;
  assert.equal(rule.getPropertyValue('background'), 'transparent');
  assert.equal(rule.getPropertyValue('color'), 'var(--vscode-textLink-foreground)');
  assert.equal(rule.getPropertyValue('border'), '1px solid transparent');
  assert.equal(rules.find(rule => rule.selectorText === '[data-git-branch]:hover').style.getPropertyValue('background'), 'transparent');
  const button = app.document.querySelector('[data-git-branch]');
  assert.equal(app.window.getComputedStyle(button).fontWeight, '600');
  button.focus();
  assert.equal(app.document.activeElement, button);
});

test('early branch progress preserves editing and completes without replacing the focused branch', t => {
  const app = createApp(t, fixture()), request = app.messages.find(message => message.type === 'git-status');
  const input = app.document.querySelector('.path-input'); input.focus(); input.value = '/editing';
  reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: true, branch: 'main', loading: true, statuses: {} } } });
  const branch = app.document.querySelector('[data-git-branch]');
  assert.ok(branch); assert.equal(branch.getAttribute('aria-busy'), 'true');
  assert.ok(branch.querySelector('[role="progressbar"]'));
  assert.equal(app.document.activeElement, input); assert.equal(input.value, '/editing');
  branch.focus(); reply(app, request, { directories: { '/repo': { ok: true, repository: true, branch: 'main', statuses: {} } } });
  assert.equal(app.document.activeElement.getAttribute('data-git-branch'), '');
  assert.equal(app.document.querySelector('[data-git-branch] [role="progressbar"]'), null);
  assert.equal(app.document.querySelector('[data-git-branch]').getAttribute('aria-busy'), 'false');
});

test('incremental status patches retain previous entries and finish the loading indicator', t => {
  const app = createApp(t, fixture()), request = app.messages.find(message => message.type === 'git-status');
  const info = { ok: true, repository: true, branch: 'main', loading: true };
  reply(app, request, { partial: true, directories: { '/repo': { ...info, statuses: {} } } });
  reply(app, request, { partial: true, directories: { '/repo': { ...info, incremental: true, statuses: { 'a.txt': 'modified' } } } });
  reply(app, request, { partial: true, directories: { '/repo': { ...info, incremental: true, statuses: { folder: 'conflict' } } } });
  assert.equal(app.row('a.txt').querySelector('[data-git-status]').dataset.gitStatus, 'modified');
  assert.equal(app.row('folder').querySelector('[data-git-status]').dataset.gitStatus, 'conflict');
  assert.ok(app.document.querySelector('[data-git-branch] [role="progressbar"]'));
  reply(app, request, { directories: { '/repo': { ok: false, error: 'Timed out', statuses: {} } } });
  assert.equal(app.document.querySelector('[data-git-branch] [role="progressbar"]'), null);
  assert.equal(app.document.querySelector('[data-git-status]'), null);
});
