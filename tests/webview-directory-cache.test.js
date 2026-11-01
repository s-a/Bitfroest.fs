const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  return { version: 1, realFilesystem: true, snapshotId: 'one', active: 0, panes: [pane('/root'), pane('/other')], folders: {
    '/root': [{ id: 'dir', name: 'child', type: 'folder', fsSource: '/root/child' }, { id: 'keep', name: 'keep.txt', type: 'text', size: 1 }],
    '/root/child': [{ id: 'nested', name: 'nested.txt', type: 'text' }], '/other': []
  } };
}

test('opening a child remains available while a parent directory is being revalidated', t => {
  const app = createApp(t, fixture());
  enter(app); app.key('Backspace');
  const pending = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.equal(pending.path, '/root');
  enter(app);
  const next = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.notEqual(next.navigationRequestId, pending.navigationRequestId);
  assert.equal(next.path, '/root/child');
  assert.equal(app.state().panes[0].tabs[0], '/root/child');
});
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const enter = app => { app.click(app.row('child').querySelector('[data-filename]')); app.key('Enter'); };

test('a pending read belongs to its tab and does not mark a newly opened tab as loading', t => {
  const state = fixture(); state.unloadedFolders = ['/root/child']; state.folders['/root/child'] = [];
  const app = createApp(t, state);
  for (const request of app.messages.filter(message => message.type === 'git-status')) send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: {} });
  enter(app);
  const first = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.equal(first.navigationTabId, app.state().panes[0].tabStates[0].id);
  assert.equal(app.document.querySelector('[data-pane="0"] [data-refresh]').getAttribute('aria-busy'), 'true');
  app.action('new-tab');
  const requests = app.messages.filter(message => message.type === 'filesystem-navigate');
  const current = requests.at(-1);
  if (current !== requests[0]) send(app, { type: 'filesystem-result', navigationRequestId: current.navigationRequestId, ok: true, state: fixture() });
  for (const request of app.messages.filter(message => message.type === 'git-status')) send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: {} });
  assert.equal(app.document.querySelector('[data-pane="0"] [data-refresh]').getAttribute('aria-busy'), 'false');
  assert.equal(app.document.querySelector('#status-activity').textContent.includes('Verzeichnis einlesen'), false);
});

test('directory return restores resized columns before revalidation and keeps them through metadata updates', t => {
  const app = createApp(t, fixture());
  const section = app.document.querySelector('[data-pane="0"]');
  const handle = section.querySelector('[data-resize="name"]');
  const original = Number(section.querySelector('[data-col="name"]').width);
  const pointer = (target, type, values) => { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value }); target.dispatchEvent(event); };
  pointer(handle, 'pointerdown', { button: 0, clientX: 100, pointerId: 1 });
  pointer(app.document, 'pointermove', { clientX: 170, pointerId: 1 });
  pointer(app.document, 'pointerup', { pointerId: 1 });
  const resized = original + 70;
  enter(app);
  assert.notEqual(Number(section.querySelector('[data-col="name"]').width), resized);
  app.key('Backspace');
  assert.equal(Number(section.querySelector('[data-col="name"]').width), resized);
  const automatic = Number(section.querySelector('[data-col="type"]').width);
  const opposite = app.document.querySelector('[data-pane="1"]').innerHTML;
  const request = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: '/root', rows: [{ id: 'keep', name: 'keep.txt', type: 'text', size: 123456 }, { id: 'long', name: 'another.verylongextensionforautosizing', type: 'text' }] });
  assert.equal(Number(section.querySelector('[data-col="name"]').width), resized);
  assert.ok(Number(section.querySelector('[data-col="type"]').width) > automatic);
  assert.equal(app.document.querySelector('[data-pane="1"]').innerHTML, opposite);
});

test('panels showing the same directory retain independent cached column widths', t => {
  const saved = fixture(); saved.panes[1].tabs = ['/root'];
  const app = createApp(t, saved), left = app.document.querySelector('[data-pane="0"]'), right = app.document.querySelector('[data-pane="1"]');
  const original = Number(left.querySelector('[data-col="name"]').width);
  const handle = left.querySelector('[data-resize="name"]');
  for (const [type, clientX] of [['pointerdown', 100], ['pointermove', 170], ['pointerup', 170]]) handle.dispatchEvent(new app.window.MouseEvent(type, { bubbles: true, button: 0, clientX }));
  enter(app); app.key('Backspace');
  assert.equal(Number(left.querySelector('[data-col="name"]').width), original + 70);
  assert.equal(Number(right.querySelector('[data-col="name"]').width), original);
});

test('cached rows paint immediately without transitions and restore transitions for subsequent live updates', t => {
  const app = createApp(t, fixture());
  const style = app.document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  const paints = [], original = app.window.HTMLElement.prototype.getBoundingClientRect;
  app.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.pane')) {
      const cell = this.querySelector('[data-filename]');
      if (cell) paints.push({ side: this.dataset.pane, transition: app.window.getComputedStyle(cell).transition, animation: app.window.getComputedStyle(cell).animation, opposite: app.window.getComputedStyle(app.document.querySelector('[data-pane="1"] [data-parent] td')).transition });
    }
    return original.call(this);
  };
  enter(app); app.key('Backspace');
  assert.ok(paints.length >= 2, 'cached colors are committed before transition suppression ends');
  assert.ok(paints.every(paint => paint.side === '0' && paint.transition === 'none' && paint.animation === 'none'));
  assert.ok(paints.every(paint => paint.opposite !== 'none'), 'opposite pane is unaffected');
  assert.equal(app.document.querySelector('#panes').hasAttribute('data-cache-paint'), false);
  assert.equal(app.window.getComputedStyle(app.row('keep.txt').querySelector('[data-filename]')).transition, 'color 200ms ease');
  const navigation = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-directory', navigationRequestId: navigation.navigationRequestId, path: '/root', rows: [{ id: 'keep', name: 'keep.txt', type: 'text', size: 7 }] });
  assert.equal(app.window.getComputedStyle(app.row('keep.txt').querySelector('[data-filename]')).transition, 'color 200ms ease');
});

test('cached navigation stays interactive and ignores late navigation while accepting current incremental rows', t => {
  const app = createApp(t, fixture());
  enter(app);
  const first = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  assert.ok(first, 'cached directories are revalidated');
  assert.equal(app.state().panes[0].tabs[0], '/root/child');
  assert.equal(Boolean(app.document.querySelector('#panes').inert), false);
  app.key('Backspace');
  const second = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  assert.equal(app.state().panes[0].tabs[0], '/root');
  assert.ok(app.row('keep.txt'));
  const retained = app.row('keep.txt'), icon = retained.querySelector('.fileicon'), list = retained.closest('.list'); list.scrollTop = 120;
  send(app, { type: 'filesystem-directory', navigationRequestId: first.navigationRequestId, path: first.path, names: [], rows: [] });
  assert.ok(app.row('keep.txt'));
  send(app, { type: 'filesystem-directory', navigationRequestId: second.navigationRequestId, path: second.path, names: ['keep.txt', 'new.txt'], rows: [] });
  assert.equal(app.row('child'), undefined);
  send(app, { type: 'filesystem-directory', navigationRequestId: second.navigationRequestId, path: second.path, rows: [{ id: 'keep', name: 'keep.txt', type: 'text', size: 8 }, { id: 'new', name: 'new.txt', type: 'text', size: 3 }] });
  assert.equal(app.row('keep.txt'), retained); assert.equal(retained.querySelector('.fileicon'), icon);
  assert.ok(app.row('new.txt')); assert.equal(list.scrollTop, 120);
  assert.equal(app.messages.some(m => m.type === 'filesystem-apply'), false);
  const fresh = fixture(); fresh.snapshotId = 'two';
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: first.navigationRequestId, state: fresh, resumeNavigation: { path: first.path, side: 0 } });
  assert.equal(app.state().panes[0].tabs[0], '/root'); assert.ok(app.row('new.txt'));
  fresh.snapshotId = 'three'; fresh.folders['/root'] = [{ id: 'keep', name: 'keep.txt', type: 'text', size: 8 }, { id: 'new', name: 'new.txt', type: 'text', size: 3 }];
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: second.navigationRequestId, state: fresh });
  assert.equal(app.row('keep.txt'), retained); assert.equal(list.scrollTop, 120);
});

test('navigation failure retains the cached list and reports the error in the statusbar', t => {
  const app = createApp(t, fixture()); enter(app);
  const request = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  assert.ok(request);
  send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: false, state: fixture(), error: 'Access denied' });
  assert.ok(app.row('nested.txt'));
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.match(app.document.body.textContent, /Access denied/);
});

test('refresh activity spans directory loading and Git completion without a separate branch progressbar', t => {
  const app = createApp(t, fixture());
  let request = app.messages.find(m => m.type === 'git-status');
  assert.equal(app.document.querySelector('.pane.active [data-refresh]').getAttribute('aria-busy'), 'true');
  send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, partial: true, directories: { '/root': { ok: true, repository: true, branch: 'main', loading: true, statuses: {} } } });
  assert.equal(app.document.querySelector('.pane.active [data-git-branch]').getAttribute('aria-busy'), 'true');
  assert.equal(app.document.querySelector('.git-progress'), null);
  assert.equal(app.document.querySelector('.pane.active [data-location-icon]').getAttribute('aria-busy'), 'true');
  send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/root': { ok: true, repository: true, branch: 'main', statuses: {} }, '/other': { ok: true, repository: false, statuses: {} } } });
  assert.equal(app.document.querySelector('.pane.active [data-refresh]').getAttribute('aria-busy'), 'false');
  enter(app);
  assert.equal(app.document.querySelector('.pane.active [data-refresh]').getAttribute('aria-busy'), 'true');
});

test('restore invalidates navigation replies and cached display overlays', t => {
  const app = createApp(t, fixture()); enter(app);
  const request = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  const restored = fixture(); restored.snapshotId = 'restored'; restored.folders['/root/child'] = [];
  send(app, { type: 'restore', state: restored });
  send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: fixture() });
  assert.equal(app.state().snapshotId, 'restored');
  assert.equal(app.state().panes[0].tabs[0], '/root');
});

test('manual refresh activates its button immediately', t => {
  const app = createApp(t, fixture()); app.action('refresh');
  assert.equal(app.document.querySelector('.pane.active [data-refresh]').getAttribute('aria-busy'), 'true');
});

test('cached return restores the directory scroll position immediately', t => {
  const app = createApp(t, fixture()); app.document.querySelector('.pane.active .list').scrollTop = 77;
  enter(app); app.document.querySelector('.pane.active .list').scrollTop = 12;
  app.key('Backspace');
  assert.equal(app.document.querySelector('.pane.active .list').scrollTop, 77);
});

test('a late first-visit response cannot steal the other panel or navigate a different tab', t => {
  const state = fixture(); state.unloadedFolders = ['/root/child']; state.folders['/root/child'] = [];
  const app = createApp(t, state); enter(app);
  const request = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  app.click(app.document.querySelector('[data-pane="1"] .list'));
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: request.navigationRequestId, state: fixture() });
  assert.equal(app.state().active, 1); assert.equal(app.state().panes[0].tabs[0], '/root');
});

test('only the refresh glyph rotates and Git text pulses with a reduced-motion override', t => {
  const app = createApp(t, fixture());
  const style = app.document.createElement('style');
  style.textContent = ['codicons.css', 'app.css'].map(name => require('node:fs').readFileSync(require('node:path').join(__dirname, '../media', name), 'utf8')).join('\n'); app.document.head.append(style);
  const button = app.document.querySelector('.pane.active [data-refresh]'), glyph = button.querySelector('[data-refresh-icon]');
  assert.ok(glyph); assert.ok(glyph.classList.contains('codicon-loading'));
  assert.equal(app.window.getComputedStyle(glyph).animation, 'codicon-spin 1s cubic-bezier(0.53, 0.21, 0.29, 0.67) infinite');
  assert.equal(app.window.getComputedStyle(button).animation, '');
  const reduced = [...style.sheet.cssRules].filter(rule => rule.conditionText === '(prefers-reduced-motion: reduce)').flatMap(rule => [...rule.cssRules]);
  assert.ok(reduced.some(rule => rule.selectorText.includes('[data-refresh-icon]') && rule.selectorText.includes('[data-git-branch]') && rule.style.animation === 'none'));
});

test('an unchanged focus refresh keeps earlier visited directory listings available', t => {
  const app = createApp(t, fixture()); enter(app);
  let request = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: app.state() });
  app.key('Backspace'); request = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  const state = fixture(); state.unloadedFolders = ['/root/child']; state.folders['/root/child'] = [];
  send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state });
  app.action('refresh'); send(app, { type: 'filesystem-result', ok: true, state });
  enter(app);
  assert.equal(app.state().panes[0].tabs[0], '/root/child'); assert.ok(app.row('nested.txt'));
});

test('keyboard marking remains available while a cached directory is being revalidated', t => {
  const app = createApp(t, fixture()); enter(app);
  app.click(app.row('nested.txt').querySelector('[data-filename]'));
  app.key(' '); app.key(' ');
  assert.deepEqual(Array.from(app.state().panes[0].selected), []);
  assert.equal(app.messages.some(m => m.type === 'filesystem-apply'), false);
});

test('cached Git branch, badges and colors survive leaving a directory and an early branch-only refresh', async t => {
  const app = createApp(t, fixture());
  app.document.body.style.setProperty('--vscode-sideBar-background', '#202020');
  app.document.body.style.setProperty('--vscode-foreground', '#eeeeee');
  app.document.body.style.setProperty('--vscode-gitDecoration-modifiedResourceForeground', '#ffcc00');
  await new Promise(resolve => setImmediate(resolve));
  const first = app.messages.find(m => m.type === 'git-status');
  const info = { ok: true, repository: true, branch: 'main', statuses: { 'keep.txt': 'modified' } };
  send(app, { type: 'git-status-result', requestId: first.requestId, snapshotId: first.snapshotId, directories: { '/root': info, '/other': { ok: true, repository: false, statuses: {} } } });
  const color = app.row('keep.txt').style.getPropertyValue('--git-text-color');
  assert.equal(color, '#ffcc00');
  enter(app);
  let navigation = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: navigation.navigationRequestId, state: app.state() });
  app.key('Backspace');
  const row = app.row('keep.txt'), badge = row.querySelector('[data-git-status="modified"]');
  assert.ok(badge); assert.equal(row.style.getPropertyValue('--git-text-color'), color);
  assert.equal(app.document.querySelector('.pane.active [data-git-branch]').textContent, '(main)');
  app.document.body.style.setProperty('--vscode-gitDecoration-modifiedResourceForeground', '#00ccff');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row.style.getPropertyValue('--git-text-color'), '#00ccff');
  navigation = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: navigation.navigationRequestId, state: app.state() });
  const next = app.messages.filter(m => m.type === 'git-status').at(-1);
  send(app, { type: 'git-status-result', requestId: next.requestId, snapshotId: next.snapshotId, partial: true, directories: { '/root': { ok: true, repository: true, loading: true, statuses: {} } } });
  assert.equal(app.row('keep.txt').querySelector('[data-git-status="modified"]'), badge);
  assert.equal(app.document.querySelector('.pane.active [data-git-branch]').textContent, '(main)');
  send(app, { type: 'git-status-result', requestId: next.requestId, snapshotId: next.snapshotId, directories: { '/root': { ok: false, error: 'Unavailable' } } });
  assert.ok(app.row('keep.txt').querySelector('[data-git-status="modified"]'));
  assert.match(app.document.querySelector('.pane.active .path-input').title, /Unavailable/);
  send(app, { type: 'git-status-result', requestId: next.requestId, snapshotId: next.snapshotId, directories: { '/root': { ...info, statuses: { 'keep.txt': 'clean' } } } });
  assert.ok(app.row('keep.txt').querySelector('[data-git-status="clean"]'));
});

test('restored sessions cache Git displays and settings changes invalidate cached decorations', t => {
  const app = createApp(t, fixture());
  send(app, { type: 'restore', state: fixture() });
  const request = app.messages.filter(m => m.type === 'git-status').at(-1);
  send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: { '/root': { ok: true, repository: true, branch: 'restored', statuses: { 'keep.txt': 'modified' } } } });
  enter(app); let navigation = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: navigation.navigationRequestId, state: app.state() });
  app.key('Backspace'); assert.ok(app.row('keep.txt').querySelector('[data-git-status="modified"]'));
  send(app, { type: 'git-settings-changed' });
  assert.equal(app.row('keep.txt').querySelector('[data-git-status]'), null);
});

test('refresh and favorites use the packaged icon font with a square centered rotation box', t => {
  const app = createApp(t, fixture());
  const refresh = app.document.querySelector('[data-refresh-icon]'), star = app.document.querySelector('[data-favorites] .codicon-star-full');
  assert.ok(refresh); assert.ok(star); assert.equal(refresh.textContent, ''); assert.equal(star.textContent, '');
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  const style = app.document.createElement('style'); style.textContent = css; app.document.head.append(style);
  const computed = app.window.getComputedStyle(refresh);
  assert.equal(computed.width, 'var(--icon-size)'); assert.equal(computed.height, 'var(--icon-size)'); assert.equal(computed.transformOrigin, '50% 50%');
  assert.equal(app.window.getComputedStyle(refresh.parentElement).display, 'inline-flex');
  const font = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/codicon.ttf'));
  assert.deepEqual([...font.subarray(0, 4)], [0, 1, 0, 0]);
});

test('decoration eviction also releases active-map entries whose old binding was invalidated', t => {
  const app = createApp(t, fixture()), first = app.messages.find(m => m.type === 'git-status');
  const statuses = (prefix, count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix.repeat(200)}-${i}`, 'modified']));
  send(app, { type: 'git-status-result', requestId: first.requestId, snapshotId: first.snapshotId, directories: { '/root': { ok: true, repository: true, branch: 'main', statuses: { ...statuses('r', 2500), 'keep.txt': 'modified' } } } });
  app.action('new-tab'); const obsolete = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  enter(app); const latest = app.messages.filter(m => m.type === 'filesystem-navigate').at(-1);
  send(app, { type: 'filesystem-result', ok: true, cancelled: true, navigationRequestId: obsolete.navigationRequestId, state: app.state() });
  send(app, { type: 'filesystem-result', ok: true, navigationRequestId: latest.navigationRequestId, state: app.state() });
  const git = app.messages.filter(m => m.type === 'git-status').at(-1);
  send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, directories: { '/root/child': { ok: true, repository: true, branch: 'child', statuses: statuses('c', 8000) } } });
  app.key('Backspace');
  assert.equal(app.row('keep.txt').querySelector('[data-git-status]'), null);
});

test('refresh reserves its full width beside long paths and swaps the loading glyph without moving the button', t => {
  const saved = fixture(), directory = '/' + 'nested/'.repeat(80) + 'leaf';
  saved.panes[1].tabs = [directory]; saved.folders[directory] = [];
  const app = createApp(t, saved);
  const style = app.document.createElement('style');
  style.textContent = ['codicons.css', 'app.css'].map(name => require('node:fs').readFileSync(require('node:path').join(__dirname, '../media', name), 'utf8')).join('\n');
  app.document.head.append(style);
  const button = app.document.querySelector('[data-pane="1"] [data-refresh]'), glyph = button.querySelector('[data-refresh-icon]');
  const box = app.window.getComputedStyle(button);
  assert.equal(box.flexShrink, '0'); assert.equal(box.flexBasis, 'var(--icon-control-size)');
  assert.equal(box.width, 'var(--icon-control-size)'); assert.equal(box.height, 'var(--icon-control-size)');
  assert.equal(box.boxSizing, 'border-box');
  assert.equal(parseFloat(app.window.getComputedStyle(button.previousElementSibling).minWidth), 0);
  assert.ok(glyph.classList.contains('codicon-loading')); assert.ok(glyph.classList.contains('codicon-modifier-spin'));
  assert.equal(glyph.classList.contains('codicon-refresh'), false);
  const mapping = [...style.sheet.cssRules].find(rule => rule.selectorText === '.codicon-loading::before');
  assert.ok(mapping); assert.ok(mapping.style.content.includes(String.fromCodePoint(0xeb19)));
  const request = app.messages.find(message => message.type === 'git-status');
  send(app, { ...request, type: 'git-status-result', directories: { '/root': { ok: true, repository: false }, [directory]: { ok: true, repository: false } } });
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.querySelector('[data-refresh-icon]'), glyph);
  assert.ok(glyph.classList.contains('codicon-refresh')); assert.equal(glyph.classList.contains('codicon-modifier-spin'), false);
  assert.equal(glyph.classList.contains('codicon-loading'), false);
  assert.equal(app.window.getComputedStyle(glyph).animation, '');
  assert.equal(app.window.getComputedStyle(button).width, 'var(--icon-control-size)');
  app.click(button);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.ok(glyph.classList.contains('codicon-loading'));
});
