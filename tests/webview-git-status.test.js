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

test('pending status uses a quiet placeholder and resolves without replacing native icons', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
  const row = app.row('a.txt'), original = row.querySelector('.fileicon');
  assert.equal(row.querySelector('[data-git-placeholder]'), null);
  reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: false, loading: true, statuses: {} } } });
  assert.equal(row.querySelector('[data-git-placeholder]'), null);
  reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: true, loading: true, statuses: {} } } });
  const placeholder = row.querySelector('[data-git-placeholder]');
  assert.ok(placeholder?.querySelector('svg.bi-question-circle-fill'));
  assert.equal(placeholder.getAttribute('aria-label'), 'Git-Status wird geladen');
  reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: true, loading: true, statuses: {} } } });
  assert.equal(row.querySelector('[data-git-placeholder]'), placeholder);
  reply(app, request);
  assert.equal(app.row('a.txt'), row);
  assert.equal(row.querySelector('.fileicon'), original);
  assert.equal(row.querySelector('[data-git-placeholder]'), placeholder);
  assert.ok(placeholder.classList.contains('git-placeholder-leave'));
  assert.ok(row.querySelector('[data-git-status]').classList.contains('git-status-enter'));
  const badge = row.querySelector('[data-git-status]');
  reply(app, request);
  assert.equal(row.querySelector('[data-git-status]'), badge);
});

test('incremental loading preserves known statuses while unresolved entries keep placeholders', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
  reply(app, request);
  const original = app.row('a.txt').querySelector('.fileicon'), badge = app.row('a.txt').querySelector('[data-git-status]');
  reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: true, loading: true, statuses: {} } } });
  assert.equal(app.row('a.txt').querySelector('[data-git-status]'), badge);
  assert.equal(app.row('a.txt').querySelector('.fileicon'), original);
});

test('placeholder size follows status size and transitions respect reduced motion', t => {
  const app = createApp(t, fixture(), { fileSettings: { gitStatus: { iconSizePercent: 80 } } });
  reply(app, app.messages.find(m => m.type === 'git-status'), { partial: true, directories: { '/repo': { ok: true, repository: true, loading: true, statuses: {} } } });
  const placeholder = app.row('a.txt').querySelector('[data-git-placeholder]');
  assert.equal(placeholder.style.width, '80%'); assert.equal(placeholder.style.height, '80%');
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /\[data-git-placeholder\]\s*\{[^}]*animation:\s*git-placeholder-in 200ms ease-out/);
  assert.match(css, /\.git-status-enter\s*\{\s*animation:\s*git-status-in 400ms cubic-bezier\(0\.42,\s*0,\s*1,\s*1\)/);
  assert.match(css, /\.git-placeholder-leave\s*\{\s*animation:\s*git-placeholder-out 400ms cubic-bezier\(0\.42,\s*0,\s*1,\s*1\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\[data-git-placeholder\][^{]*\{\s*animation:\s*none/);
  assert.match(css, /\[data-git-placeholder\]\.git-placeholder-leave\s*\{\s*animation:\s*none;\s*opacity:\s*0;\s*\}\s*\.git-status-enter\s*\{\s*animation:\s*none/);
});

test('completion without a status or with an error removes loading placeholders', t => {
  for (const info of [{ ok: true, repository: false, statuses: {} }, { ok: false, error: 'Unavailable' }]) {
    const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
    const original = app.row('a.txt').querySelector('.fileicon');
    assert.equal(app.row('a.txt').querySelector('[data-git-placeholder]'), null);
    reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: true, loading: true, statuses: {} } } });
    assert.ok(app.row('a.txt').querySelector('[data-git-placeholder]'));
    reply(app, request, { directories: { '/repo': info } });
    assert.equal(app.document.querySelector('[data-git-placeholder]'), null);
    assert.equal(app.row('a.txt').querySelector('.fileicon'), original);
  }
});

test('a confirmed child repository gets a placeholder without decorating its siblings', t => {
  const app = createApp(t, fixture()), request = app.messages.find(m => m.type === 'git-status');
  const folder = app.row('folder'), original = folder.querySelector('.fileicon');
  assert.equal(app.document.querySelector('[data-git-placeholder]'), null);
  reply(app, request, { partial: true, directories: { '/repo': { ok: true, repository: false, loading: true, loadingRepositories: ['folder'], statuses: {} } } });
  assert.ok(folder.querySelector('[data-git-placeholder]'));
  assert.equal(app.row('a.txt').querySelector('[data-git-placeholder]'), null);
  assert.equal(app.document.querySelector('[data-git-branch]'), null);
  reply(app, request, { directories: { '/repo': { ok: true, repository: false, statuses: { folder: 'modified' } } } });
  assert.equal(folder.querySelector('.fileicon'), original);
  assert.ok(folder.querySelector('[data-git-status="modified"].git-status-enter'));
});

function separatePanes() {
  const state = fixture();
  state.panes[1] = { ...state.panes[1], tabs: ['/other'], selected: ['right-file'], cursor: 'right-file' };
  state.folders['/other'] = [{ id: 'right-file', name: 'right.txt', type: 'text' }];
  return state;
}

for (const activation of ['click', 'keyboard']) test(`inactive tabs refresh only on ${activation} activation and leave the opposite pane alone`, t => {
  const state = separatePanes(); state.panes[0].tabs.push('/cached', '/sleeping');
  state.folders['/cached'] = [{ id: 'cached', name: 'cached.txt', type: 'text' }]; state.folders['/sleeping'] = [];
  const app = createApp(t, state), right = app.document.querySelector('[data-pane="1"]');
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate'), false);
  if (activation === 'click') app.click(app.document.querySelector('[data-pane="0"] [data-tab="1"]'));
  else app.action('next-tab');
  const requests = app.messages.filter(message => message.type === 'filesystem-navigate');
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/cached'); assert.equal(requests[0].side, 0);
  assert.equal(app.messages.some(message => message.type === 'git-status' && message.directories.includes('/sleeping')), false);
  const fresh = JSON.parse(JSON.stringify(requests[0].state)); fresh.snapshotId = 'activated';
  fresh.folders['/cached'].push({ id: 'new-cached', name: 'arrived.txt', type: 'text' });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh, resumeNavigation: { side: 0, path: '/cached' } } }));
  assert.ok(app.row('arrived.txt')); assert.equal(app.document.querySelector('[data-pane="1"]'), right);
  assert.equal(app.state().panes[0].tabs.length, 3);
  assert.deepEqual(Array.from(app.messages.filter(message => message.type === 'git-status').at(-1).directories), ['/cached']);
});

test('left navigation requests Git only for its destination and retains the right branch', t => {
  const app = createApp(t, separatePanes()), first = app.messages.find(message => message.type === 'git-status');
  reply(app, first, { directories: { '/repo': { ok: true, repository: true, branch: 'left', statuses: {} }, '/other': { ok: true, repository: true, branch: 'right', statuses: { 'right.txt': 'clean' } } } });
  app.click(app.row('folder').querySelector('[data-filename]')); app.key('Enter', {}, app.document.querySelector('.pane.active .list'));
  const requests = app.messages.filter(message => message.type === 'git-status');
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(requests[1].directories), ['/repo/folder']);
  assert.equal(app.document.querySelector('[data-pane="1"] [data-git-branch]').textContent, '(right)');
  assert.equal(app.document.querySelector('[data-pane="1"] [role="progressbar"]'), null);
});

test('left navigation preserves right pane nodes, selection and scroll', t => {
  const app = createApp(t, separatePanes());
  const right = app.document.querySelector('[data-pane="1"]'), list = right.querySelector('.list'), icon = right.querySelector('.fileicon');
  list.scrollTop = 145;
  app.click(app.row('folder').querySelector('[data-filename]')); app.key('Enter', {}, app.document.querySelector('.pane.active .list'));
  assert.equal(app.document.querySelector('[data-pane="1"]'), right);
  assert.equal(right.querySelector('.list'), list); assert.equal(right.querySelector('.fileicon'), icon);
  assert.equal(list.scrollTop, 145);
  assert.deepEqual(app.state().panes[1].selected, ['right-file']);
  assert.equal(app.state().panes[1].cursor, 'right-file');
});

for (const outcome of ['success', 'partial-error', 'partial-cancel']) test(`${outcome} mutation response refreshes changed visible Git paths and preserves the untouched side`, t => {
  const state = separatePanes(), app = createApp(t, state), first = app.messages.find(message => message.type === 'git-status');
  reply(app, first, { directories: { '/repo': { ok: true, repository: true, branch: 'left', statuses: {} }, '/other': { ok: true, repository: true, branch: 'right', statuses: { 'right.txt': 'clean' } } } });
  const right = app.document.querySelector('[data-pane="1"]'), branch = right.querySelector('[data-git-branch]');
  const fresh = JSON.parse(JSON.stringify(app.state())); fresh.snapshotId = 'mutation';
  fresh.folders['/repo'].push({ id: 'created', name: 'created.zip', type: 'archive' });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: outcome !== 'partial-error', cancelled: outcome === 'partial-cancel', state: fresh, ...(outcome === 'partial-error' ? { error: 'Partial operation' } : {}) } }));
  const requests = app.messages.filter(message => message.type === 'git-status');
  assert.deepEqual(Array.from(requests.at(-1).directories), ['/repo']);
  assert.equal(right, app.document.querySelector('[data-pane="1"]'));
  assert.equal(right.querySelector('[data-git-branch]'), branch);
  assert.equal(branch.textContent, '(right)');
  assert.ok(app.row('created.zip'));
});

test('system-menu reconciliation refreshes its explicit directory without restarting the opposite Git status', t => {
  const app = createApp(t, separatePanes()), first = app.messages.find(message => message.type === 'git-status');
  reply(app, first, { directories: { '/repo': { ok: true, repository: true, branch: 'left', statuses: {} }, '/other': { ok: true, repository: true, branch: 'right', statuses: {} } } });
  const right = app.document.querySelector('[data-pane="1"]'), list = right.querySelector('.list'); list.scrollTop = 147;
  const fresh = JSON.parse(JSON.stringify(app.state())); fresh.snapshotId = 'shell';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: fresh, preserveUnchanged: true, refreshGitDirectories: ['/repo'] } }));
  assert.deepEqual(Array.from(app.messages.filter(message => message.type === 'git-status').at(-1).directories), ['/repo']);
  assert.equal(app.document.querySelector('[data-pane="1"]'), right); assert.equal(list.scrollTop, 147);
  assert.equal(right.querySelector('[data-git-branch]').textContent, '(right)');
});

test('committed writes refresh their declared Git scope even when visible metadata is identical', t => {
  const app = createApp(t, separatePanes()), first = app.messages.find(message => message.type === 'git-status');
  reply(app, first, { directories: { '/repo': { ok: true, repository: true, branch: 'left', statuses: {} }, '/other': { ok: true, repository: true, branch: 'right', statuses: {} } } });
  const fresh = JSON.parse(JSON.stringify(app.state())); fresh.snapshotId = 'same-metadata';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh, refreshGitDirectories: ['/other'] } }));
  assert.deepEqual(Array.from(app.messages.filter(message => message.type === 'git-status').at(-1).directories), ['/other']);
});

test('unloaded left navigation preserves the opposite pending status across a new filesystem snapshot', t => {
  const state = separatePanes(); state.unloadedFolders = ['/repo/folder'];
  const app = createApp(t, state), first = app.messages.find(message => message.type === 'git-status');
  reply(app, first, { partial: true, directories: { '/other': { ok: true, repository: true, branch: 'right', loading: true, statuses: {} } } });
  const right = app.document.querySelector('[data-pane="1"]'), list = right.querySelector('.list'); list.scrollTop = 99;
  app.click(app.row('folder').querySelector('[data-filename]')); app.key('Enter', {}, app.document.querySelector('.pane.active .list'));
  const navigation = app.messages.find(message => message.type === 'filesystem-navigate'); assert.ok(navigation);
  const fresh = JSON.parse(JSON.stringify(navigation.state)); fresh.snapshotId = 'two'; fresh.unloadedFolders = [];
  fresh.panes[1].selected = []; fresh.panes[1].cursor = null;
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh, resumeNavigation: { side: 0, path: '/repo/folder' } } }));
  const requests = app.messages.filter(message => message.type === 'git-status');
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(requests[1].directories), ['/repo/folder']);
  reply(app, first, { directories: { '/other': { ok: true, repository: true, branch: 'right-complete', statuses: { 'right.txt': 'modified' } }, '/repo': { ok: true, repository: true, branch: 'old-left', statuses: {} } } });
  assert.equal(app.document.querySelector('[data-pane="1"]'), right);
  assert.equal(list.scrollTop, 99);
  assert.deepEqual(app.state().panes[1].selected, ['right-file']);
  assert.equal(right.querySelector('[data-git-branch]').textContent, '(right-complete)');
  assert.equal(right.querySelector('[role="progressbar"]'), null);
  assert.equal(app.document.querySelector('[data-pane="0"] [data-git-branch]'), null);
});

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
