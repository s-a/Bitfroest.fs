const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'extension.js');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const Progress = require('../media/commander-progress');

test('symbolic folder context reaches native menus and clipboard as the current directory', async t => {
  const initial = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html, platform: 'win32', fileSettings: { useSystemContextMenu: true } });
  const row = view.document.querySelector('.pane.active [data-parent]');
  row.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const request = view.messages.find(message => message.type === 'shell-context-menu'); assert.ok(request);
  await panel.receive({ ...request, paths: ['C:/private/unrelated'] });
  assert.deepEqual(Array.from(app.shellCalls.at(-1)?.paths || []), ['C:/tmp']);
  assert.equal(app.shellCalls.at(-1)?.settings.currentDirectory, true);
  await panel.receive({ ...request, requestId: 'shell-menu-2', ids: ['\u0000parent', 'a'] });
  assert.equal(app.shellCalls.length, 1);
  view.action('clipboard-copy');
  const copy = view.messages.findLast(message => message.type === 'clipboard-write'); assert.ok(copy);
  await panel.receive(copy);
  assert.ok(panel.messages.findLast(message => message.type === 'clipboard-result')?.ok);
  panel.dispose();
});

test('symbolic current-directory lock inspection validates its snapshot and opens the current path', async t => {
  const opened = [], app = harness(t, { filesystemLoad: async () => clipboardFixture(), lockInspectorOpen: folder => opened.push(folder) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = { type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['\u0000parent'], snapshotId: 'clipboard', inspectLocks: true };
  await panel.receive(request);
  assert.deepEqual(opened, ['C:/tmp']);
  assert.equal(panel.messages.findLast(message => message.type === 'shell-context-menu-result')?.ok, true);
  await panel.receive({ ...request, requestId: 'shell-menu-2', snapshotId: 'old' });
  await panel.receive({ ...request, requestId: 'shell-menu-3', directory: 'C:/not-visible' });
  assert.deepEqual(opened, ['C:/tmp']);
  panel.dispose();
});

test('native current-folder Git History uses the directory history path', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(),
    gitInspect: async directories => Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, statuses: {} }])),
    gitExtension: { enabled: true, getAPI: () => ({ getRepository: () => ({ rootUri: { fsPath: 'C:/tmp' }, state: {} }) }) },
    shellMenuShow: async (_paths, settings) => { assert.equal(settings.gitHistory, true); assert.equal(settings.gitDiff, false); return { ok: true, displayed: true, invoked: true, cancelled: false, action: 'git-history' }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'git-status', requestId: 'git-1', snapshotId: 'clipboard', directories: ['C:/tmp'] });
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['\u0000parent'], snapshotId: 'clipboard' });
  assert.ok(app.panels.find(p => p.viewType === 'bitfroestGitHistory'));
  assert.equal(panel.messages.at(-1).ok, true);
  assert.equal(panel.messages.at(-1).refreshed, false);
});

test('generated host HTML keeps the double-clicked folder visible while loading and preserves opposite focus', async t => {
  const initial = clipboardFixture(), reading = deferred(), started = deferred();
  t.after(() => reading.resolve());
  initial.panes.forEach(p => { p.filter = ''; p.selected = []; p.cursor = null; });
  initial.folders['C:/tmp'] = [{ id: 'docs', name: 'docs', type: 'folder', fsSource: 'C:/tmp/docs' }];
  initial.folders['C:/tmp/docs'] = [];
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), filesystemPrepare: async (before, options) => {
    await options.onDirectory({ path: 'C:/tmp/docs', names: ['loaded.txt'], rows: [{ id: 'loaded', name: 'loaded.txt', type: 'text' }] });
    started.resolve(); await reading.promise;
    return { ...before, folders: { ...before.folders, 'C:/tmp/docs': [{ id: 'loaded', name: 'loaded.txt', type: 'text' }] } };
  } });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  view.row('docs').querySelector('[data-filename]').dispatchEvent(new view.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  const request = view.messages.findLast(message => message.type === 'filesystem-navigate');
  const pending = panel.receive(request); await started.promise;
  for (const message of panel.messages.filter(message => message.type === 'filesystem-directory')) view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
  assert.ok(view.row('docs').querySelector('[data-directory-loading]'));
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp');
  assert.equal(view.document.querySelector('[data-location-icon] [data-directory-loading]'), null);
  const other = view.document.querySelector('[data-pane="1"] .list'); other.focus();
  const otherPath = view.state().panes[1].tabs[0];
  reading.resolve(); await pending;
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.findLast(message => message.type === 'filesystem-result') }));
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp/docs');
  assert.equal(view.state().panes[1].tabs[0], otherPath);
  assert.equal(view.state().active, 1); assert.equal(view.document.activeElement, other);
  assert.equal(view.document.querySelector('[data-directory-loading]'), null);
});

function progressSample(fields) {
  return Progress.event({ ...fields, phase: fields.phase || 'preparing',
    overall: Number.isSafeInteger(fields.totalBytes) ? Progress.known('bytes', fields.completedBytes || 0, fields.totalBytes) : Progress.unknown('items', 0, 'enumerating'),
    current: Number.isSafeInteger(fields.total) ? Progress.known('bytes', fields.transferred || 0, fields.total) : Progress.unknown('items', 0, 'enumerating') });
}

test('generated host HTML keeps rename text editing and confirms outside clicks through the host', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let writes = 0;
  const app = harness(t, { filesystemLoad: async () => initial, filesystemApply: async (_before, after) => { writes++; return after; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], html = panel.webview.html;
  assert.match(html, /Content-Security-Policy/); assert.match(html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html });
  assert.equal(JSON.parse(view.document.body.dataset.vscodeContext).preventDefaultContextMenuItems, true);
  view.click(view.row('a.txt')); view.action('rename-one'); const input = view.document.querySelector('.inline-rename');
  assert.equal(input.closest('[data-file-row]').draggable, false);
  input.value = 'edited.txt'; input.setSelectionRange(0, 6);
  const menu = new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  input.dispatchEvent(menu); input.blur();
  assert.equal(menu.defaultPrevented, false);
  assert.equal(JSON.parse(input.dataset.vscodeContext).webviewSection, 'textInput');
  assert.equal(view.document.querySelector('.inline-rename'), input);
  input.focus();
  assert.equal(input.selectionEnd, 6);
  const focus = view.messages.filter(message => message.type === 'inputFocus').at(-1);
  assert.equal(focus.inlineRename, true); assert.equal(focus.value, true); assert.equal(focus.list, false);
  await panel.receive(focus);
  view.document.querySelector('[data-pane="1"] .list').dispatchEvent(new view.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  const request = view.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
  assert.equal(request.state.folders['C:/tmp'].find(file => file.id === 'a').name, 'edited.txt');
  assert.equal(view.messages.some(message => message.type === 'shell-context-menu'), false);
  await panel.receive(request);
  assert.equal(writes, 1);
  const reply = panel.messages.filter(message => message.type === 'filesystem-result').at(-1); assert.equal(reply.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
  assert.equal(view.document.querySelector('.inline-rename'), null);
  assert.equal(view.state().folders['C:/tmp'].find(file => file.id === 'a').name, 'edited.txt');
  assert.equal(view.document.querySelector('[data-pane="0"] [data-file-row][data-id="a"]').draggable, true);
});

test('generated host HTML sorts the configured date column chronologically through header clicks', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; pane.descending = false; pane.selected = []; });
  initial.folders['C:/tmp'] = [
    { id: 'aug', name: 'August', type: 'folder', date: '31.08.2026 19:09:55' },
    { id: 'oct', name: 'October', type: 'folder', date: '30.10.2026 16:33:26' },
    { id: 'nov', name: 'November', type: 'folder', date: '02.11.2026 16:15:40' }
  ];
  for (const file of initial.folders['C:/tmp']) initial.folders[`C:/tmp/${file.name}`] = [];
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const section = view.document.querySelector('[data-pane="0"]');
  assert.equal(view.state().panes[0].columns.find(column => column.key === 'date').field, '[=file.writedate] [=file.writetime.h:m]');
  const order = () => [...section.querySelectorAll('[data-file-grid] [data-file-row][data-id]')].map(row => row.dataset.id);
  view.click(section.querySelector('[data-sort="date"]'));
  assert.deepEqual(order(), ['aug', 'oct', 'nov']);
  view.click(section.querySelector('[data-sort="date"]'));
  assert.deepEqual(order(), ['nov', 'oct', 'aug']);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('generated host HTML searches complete names without changing marks or requesting directory work', async t => {
  const initial = clipboardFixture(); initial.realFilesystem = false;
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const rows = initial.folders['C:/tmp'];
  rows[0].name = 'Terror.txt';
  rows.push({ ...rows[0], id: 'search-match', name: 'Another Terror.txt' });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], html = panel.webview.html;
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html });
  const selection = [...view.state().panes[0].selected];
  let now = Date.now(); view.window.Date.now = () => (now += 2000);
  let scrolled;
  view.window.HTMLElement.prototype.scrollIntoView = function () { scrolled = this.dataset.id; };
  view.messages.length = 0;
  for (const key of 'Terror') view.key(key);
  assert.equal(view.state().panes[0].filter, 'Terror');
  assert.deepEqual(view.state().panes[0].selected, selection);
  for (const name of ['Terror.txt', 'Another Terror.txt']) assert.equal(view.row(name).querySelector('[data-filename] mark').textContent, 'Terror');
  assert.equal(scrolled, view.state().panes[0].cursor);
  assert.equal(view.document.activeElement, view.document.querySelector('.pane.active .list'));
  assert.equal(view.messages.some(message => /icon|git-status|filesystem/.test(message.type)), false);
  for (const message of view.messages) if (message.type === 'state') await panel.receive(message);
  assert.equal(view.state().panes[0].filter, 'Terror');
  await app.command('bitfroest.select-search-matches');
  const action = panel.messages.findLast(message => message.type === 'action' && message.action === 'select-search-matches');
  assert.ok(action);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: action }));
  const expected = rows.filter(row => row.name.includes('Terror')).map(row => row.id);
  assert.deepEqual([...view.state().panes[0].selected].sort(), [...new Set([...selection, ...expected])].sort());
  await app.command('bitfroest.filter-search-matches');
  const filterAction = panel.messages.findLast(message => message.type === 'action' && message.action === 'filter-search-matches');
  assert.ok(filterAction);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: filterAction }));
  assert.deepEqual([...view.document.querySelectorAll('.pane.active [data-file-row][data-id]')].map(row => row.dataset.id).sort(), expected.sort());
  view.key('Escape');
  assert.equal(view.document.querySelectorAll('.pane.active [data-file-row][data-id]').length, rows.length);
  assert.equal(view.document.querySelector('.pane.active mark'), null);
});

test('generated host HTML separates left dragging, right selection and held right dragging through its host protocol', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; pane.selected = []; });
  initial.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', fsSource: 'C:/tmp/b.txt' });
  let writes = 0;
  const app = harness(t, { filesystemLoad: async () => initial, filesystemApply: async (_before, after) => { writes++; return after; } });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], html = panel.webview.html;
  assert.match(html, /Content-Security-Policy/); assert.match(html, /script-src 'nonce-[^']+'/);
  let now = 0, sequence = 0;
  const timers = new Map();
  const view = require('./support/webview.cjs').createApp(t, initial, { html, beforeApp({ window }) {
    window.setTimeout = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { fn, due: now + delay }); return id; };
    window.clearTimeout = id => timers.delete(id);
  } });
  const list = view.document.querySelector('[data-pane="0"] .list'), row = view.row('a.txt');
  const destination = view.document.querySelector('[data-pane="1"] .list');
  list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 300 });
  [...list.querySelectorAll('[data-file-row][data-id]')].forEach((entry, index) => { entry.getBoundingClientRect = () => ({ left: 0, top: 30 + index * 22, right: 600, bottom: 50 + index * 22 }); });
  const pointer = (type, target, clientY, button = 0) => {
    const event = new view.window.MouseEvent(type, { bubbles: true, cancelable: true, button, buttons: type === 'pointerup' ? 0 : button === 2 ? 2 : 1, clientX: clientY, clientY });
    Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event);
  };
  pointer('pointerdown', row, 40, 2);
  assert.ok(row.querySelector('.drag-pending'));
  pointer('pointermove', list, 75, 2);
  assert.ok(list.querySelector('.selection-marquee'));
  assert.equal(row.querySelector('.drag-pending'), null);
  pointer('pointerup', list, 75, 2);
  assert.deepEqual(view.state().panes[0].selected, ['a', 'b']);
  pointer('pointerdown', row, 40);
  pointer('pointermove', destination, 200);
  assert.equal(list.querySelector('.selection-marquee'), null);
  assert.equal(view.document.querySelector('.file-drag-feedback').dataset.mode, 'copy');
  assert.equal(view.document.querySelector('.file-drag-feedback').dataset.count, '2');
  pointer('pointerup', destination, 200);
  assert.match(view.document.querySelector('#modal-title').textContent, /kopieren/i);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
  view.document.querySelector('#modal-cancel').click();
  assert.equal(view.document.querySelector('#modal').open, false);
  pointer('pointerdown', row, 40, 2);
  now += 500; for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.fn();
  assert.equal(row.querySelector('.drag-pending'), null);
  assert.equal(view.document.body.dataset.fileDragCursor, 'ready');
  pointer('pointermove', destination, 200, 2);
  assert.equal(view.document.querySelector('.file-drag-feedback').dataset.mode, 'move');
  pointer('pointerup', destination, 200, 2);
  assert.match(view.document.querySelector('#modal-title').textContent, /verschieben/i);
  assert.equal(view.messages.some(message => message.type === 'choose-drop-action'), false);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
  view.document.querySelector('#modal-cancel').click();
  pointer('pointerdown', row, 40); pointer('pointermove', destination, 200); pointer('pointerup', destination, 200);
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = view.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
  assert.deepEqual([...request.transfer.ids], ['a', 'b']); assert.equal(request.transfer.mode, 'copy');
  await panel.receive(request);
  assert.equal(writes, 1);
  const reply = panel.messages.findLast(message => message.type === 'filesystem-result'); assert.equal(reply.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
  assert.equal(view.state().folders['C:/tmp'].length, 2);
  assert.equal(view.state().folders['C:/temp'].length, 2);
  assert.equal(view.document.querySelector('#modal').open, false);
  const nextRow = view.row('a.txt'), nextDestination = view.document.querySelector('[data-pane="1"] .list');
  pointer('pointerdown', nextRow, 40); pointer('pointermove', nextDestination, 200);
  const chord = new view.window.MouseEvent('pointermove', { bubbles: true, cancelable: true, button: 2, buttons: 3, clientX: 210, clientY: 210 });
  Object.defineProperty(chord, 'pointerId', { value: 1 }); nextDestination.dispatchEvent(chord);
  pointer('pointerup', nextDestination, 210, 2);
  assert.equal(view.document.querySelectorAll('.file-drag-preview,.drag-pending').length, 0);
  assert.equal(view.document.querySelector('#modal').open, false);
  assert.equal(view.messages.filter(message => message.type === 'filesystem-apply').length, 1);
});

test('generated host HTML delays name editing and shows both drag operations with its CSP', async t => {
  const initial = clipboardFixture(); initial.realFilesystem = false;
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const html = app.panels[0].webview.html;
  assert.match(html, /Content-Security-Policy/); assert.match(html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html });
  let now = 1000; view.window.Date.now = () => now;
  const name = () => view.row('a.txt').querySelector('[data-filename]');
  view.click(name()); now += 1000; view.click(name());
  assert.equal(view.document.querySelector('.inline-rename'), null);
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(view.document.querySelector('.inline-rename').value, 'a.txt');
  view.key('Escape', {}, view.document.querySelector('.inline-rename'));
  const drag = (type, target, shiftKey = false) => {
    const event = new view.window.MouseEvent(type, { bubbles: true, cancelable: true, shiftKey });
    Object.defineProperty(event, 'dataTransfer', { value: { setData() {} } }); target.dispatchEvent(event);
  };
  drag('dragstart', view.row('a.txt'));
  const target = view.document.querySelector('[data-pane="1"] .list');
  for (const shiftKey of [false, true]) {
    drag('dragover', target, shiftKey);
    assert.equal(view.document.querySelector('.file-drag-feedback').dataset.mode, shiftKey ? 'move' : 'copy');
    assert.equal(view.document.querySelector('.file-drag-feedback > svg'), null);
    assert.ok(view.document.querySelector('.file-drag-feedback .file-drag-row'));
  }
  drag('dragend', target); assert.equal(view.document.querySelector('.file-drag-feedback'), null);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('generated host HTML compares conflict metadata and keeps explicit decisions in the footer', async t => {
  const initial = clipboardFixture(); initial.realFilesystem = false;
  Object.assign(initial.folders['C:/tmp'][0], { size: 1024, date: '29.10.2026 14:32', attributes: '-a--', content: 'source' });
  initial.folders['C:/temp'] = [{ ...initial.folders['C:/tmp'][0], id: 'target', fsSource: 'C:/temp/a.txt', content: 'target' }];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/); assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt').querySelector('[data-filename]')); view.action('copy');
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(view.document.querySelectorAll('.comparison-name').length, 1);
  assert.equal(view.document.querySelector('[data-property="size"]').dataset.comparisonState, 'equal');
  assert.equal(view.document.activeElement.id, 'conflict-name');
  view.click(view.document.querySelector('.modal-actions [data-conflict-action="skip"]')); await tick();
  assert.equal(view.document.querySelector('#modal').open, false);
  assert.equal(view.state().folders['C:/temp'][0].content, 'target');
});

test('generated host HTML supports destination filename editing with its original extension', async t => {
  const initial = clipboardFixture(); initial.realFilesystem = false;
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt').querySelector('[data-filename]')); view.action('copy');
  view.document.querySelector('#transfer-individual').checked = true;
  const submit = () => view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await tick();
  const input = view.document.querySelector('#value'); input.value = 'renamed';
  input.dispatchEvent(new view.window.Event('input', { bubbles: true }));
  assert.equal(view.document.querySelector('[data-rename-preview]').textContent, 'renamed.txt');
  assert.ok(view.document.querySelector('.modal-actions #transfer-skip'));
  submit(); await tick();
  assert.ok(view.state().folders['C:/temp'].some(file => file.name === 'renamed.txt'));
  assert.equal(view.document.querySelector('#modal').open, false);
});

test('generated host HTML suppresses file-action context menus while retaining native text editing', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
  for (const button of view.document.querySelectorAll('#functionbar button')) {
    const event = new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    button.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(JSON.parse(button.closest('[data-vscode-context]').dataset.vscodeContext), { webviewSection: 'fileActions', preventDefaultContextMenuItems: true });
    assert.equal(view.document.querySelector('[data-context-menu]'), null);
  }
  const input = view.document.querySelector('.path-input');
  const edit = new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  input.dispatchEvent(edit);
  assert.equal(edit.defaultPrevented, false);
  assert.equal(JSON.parse(input.dataset.vscodeContext).preventDefaultContextMenuItems, false);
  const address = view.document.querySelector('[data-pane="1"] [data-breadcrumb]');
  address.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const copy = view.messages.filter(message => message.type === 'selection-io').at(-1);
  assert.ok(copy);
  assert.notEqual(view.document.querySelector('#status-message').dataset.outcome, 'success');
  await panel.receive(copy);
  assert.deepEqual(app.clipboardCalls.at(-1), { action: 'writeText', text: copy.text });
  const confirmation = panel.messages.find(message => message.type === 'selection-io-result' && message.requestId === copy.requestId);
  assert.equal(confirmation.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: confirmation }));
  assert.match(view.document.querySelector('#status-message').textContent, /Pfad in Zwischenablage kopiert/);
  for (const pane of view.document.querySelectorAll('.pane')) {
    assert.equal(pane.querySelector('[data-parent] .filename').textContent, '..');
    assert.equal(pane.querySelector('[data-parent] [data-icon-reviewed]'), null);
  }
  panel.dispose();
});

test('Git location menu accepts a trusted ordinary folder containing an exclamation mark', async t => {
  const directory = 'C:/tmp/release!old', initial = clipboardFixture();
  initial.panes[0].tabs[0] = directory; initial.folders[directory] = [];
  const inspected = [];
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: async directories => { inspected.push(...directories); return Object.fromEntries(directories.map(path => [path, { ok: true, repository: true, branch: 'main', statuses: {} }])); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  await panel.receive(view.messages.find(message => message.type === 'git-status'));
  assert.ok(inspected.includes(directory));
  const result = panel.messages.find(message => message.type === 'git-status-result');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.ok(view.document.querySelector('[data-favorites] svg.bi-git'));
  panel.dispose();
});

test('generated host HTML supplies compact hover menus and cascading favorites with its CSP', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /<script[^>]*nonce="[^"]+"[^>]*src="[^"]*commander-menu\.js"|<script[^>]*src="[^"]*commander-menu\.js"[^>]*nonce="[^"]+"/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const heads = view.document.querySelectorAll('[data-main-menu] > button'); view.click(heads[0]);
  heads[1].dispatchEvent(new view.window.MouseEvent('mouseenter'));
  assert.equal(heads[1].getAttribute('aria-expanded'), 'true');
  assert.ok(view.document.querySelector('[data-menu-action="select-all"] [data-menu-icon]'));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'favorite-settings', settings: { entries: { work: 'C:/tmp' }, groups: { work: 'Projects' } } } }));
  view.click(view.document.querySelector('[data-favorites]'));
  const group = view.document.querySelector('[data-favorite-group]'); group.dispatchEvent(new view.window.MouseEvent('mouseenter'));
  const child = view.document.getElementById(group.getAttribute('aria-controls')); assert.ok(child);
  assert.equal(child.getAttribute('aria-label'), 'Projects');
  view.click(child.querySelector('[data-favorite-entry]'));
  assert.equal(view.messages.filter(message => message.type === 'filesystem-navigate').at(-1).path, 'C:/tmp');
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('generated host HTML preserves complete column captions and accessible sorting', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; pane.descending = false; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  for (const pane of view.document.querySelectorAll('.pane')) {
    const arrow = pane.querySelector('[data-column="name"] [data-history="back"]');
    assert.ok(arrow.querySelector('[data-icon-reviewed="status:forward"]'));
    assert.ok(arrow.querySelector('[data-icon-reviewed="status:forward-fill"]'));
    arrow.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    assert.ok(view.document.querySelector('[data-history-index][aria-current="location"]'));
    view.key('Escape');
    assert.equal(view.document.querySelector('[data-context-menu]'), null);
    assert.equal(view.document.activeElement, arrow);
  }
  for (const pane of view.document.querySelectorAll('.pane')) {
    const tab = pane.querySelector('.tab');
    assert.equal(tab.firstElementChild.getAttribute('data-icon-reviewed'), 'font:folder');
    assert.equal(tab.firstElementChild.getAttribute('aria-hidden'), 'true');
    assert.ok(tab.querySelector('[data-tab-label]').textContent);
    const button = pane.querySelector('[data-sort="name"]');
    const header = button.closest('[role="columnheader"]');
    assert.equal(header.getAttribute('role'), 'columnheader');
    header.focus();
    assert.equal(view.document.activeElement, header);
    view.click(button.querySelector('.column-caption'));
    assert.equal(pane.querySelector('[data-column="name"]').getAttribute('aria-sort'), 'descending');
    assert.ok(pane.querySelector('.ag-sort-indicator-container'));
  }
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('Escape in generated host HTML resets the native clipboard selection without a file operation', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt')); view.action('clipboard-cut');
  const write = view.messages.find(message => message.type === 'clipboard-write'); await panel.receive(write);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.find(message => message.requestId === write.requestId) }));
  assert.ok(view.row('a.txt').classList.contains('is-cut'));
  view.key('Escape');
  const reset = view.messages.find(message => message.type === 'clipboard-reset'); assert.ok(reset);
  await panel.receive(reset);
  assert.equal(view.document.querySelectorAll('.is-cut,.is-copied').length, 0);
  assert.equal(app.clipboardCalls.filter(call => call.action === 'reset').length, 1);
  assert.equal(app.clipboardCalls.some(call => call.action === 'ack'), false);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('a pending read cannot authorize clearing a newer identical foreign clipboard selection', async t => {
  const calls = [], paths = ['C:/tmp/a.txt'];
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), clipboardFactory: () => ({
    write: async () => ({ paths, mode: 'move', token: 'own', source: 'system' }),
    read: async () => ({ paths, mode: 'move', token: 'foreign', source: 'system' }),
    reset: async selection => { calls.push(selection); return true; }, dispose() {}
  }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'write-own', paths, mode: 'move' });
  await panel.receive({ type: 'clipboard-read', requestId: 'read-new' });
  await panel.receive({ type: 'clipboard-reset', requestId: 'reset-stale', sourceRequestId: 'read-new', paths, mode: 'move' });
  assert.equal(calls.length, 0);
});

test('a queued own write stays cancellable after reading the same native clipboard identity', async t => {
  const calls = [], paths = ['C:/tmp/a.txt'];
  const selection = { paths, mode: 'move', token: 'same-identity', source: 'system' };
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), clipboardFactory: () => ({
    write: async () => selection, read: async () => selection,
    reset: async value => { calls.push(value); return true; }, dispose() {}
  }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'write-own', paths, mode: 'move' });
  await panel.receive({ type: 'clipboard-read', requestId: 'read-same' });
  await panel.receive({ type: 'clipboard-reset', requestId: 'cancel-own', sourceRequestId: 'write-own', paths, mode: 'move' });
  assert.equal(calls.length, 1); assert.equal(calls[0].token, 'same-identity');
});

test('Escape reset is bound to its issued clipboard request and never acknowledges file deletion', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  for (const mode of ['copy', 'move']) {
    await panel.receive({ type: 'clipboard-write', requestId: `write-${mode}`, paths: ['C:/tmp/a.txt'], mode });
    await panel.receive({ type: 'clipboard-reset', requestId: `stale-${mode}`, sourceRequestId: 'stale-write', paths: ['C:/tmp/a.txt'], mode });
    assert.equal(app.clipboardCalls.filter(call => call.action === 'reset').length, mode === 'copy' ? 0 : 1);
    await panel.receive({ type: 'clipboard-reset', requestId: `reset-${mode}`, sourceRequestId: `write-${mode}`, paths: ['C:/tmp/a.txt'], mode });
    const result = panel.messages.find(message => message.requestId === `reset-${mode}`);
    assert.equal(result.ok, true); assert.equal(result.matched, true);
  }
  assert.equal(app.clipboardCalls.filter(call => call.action === 'reset').length, 2);
  assert.equal(app.clipboardCalls.some(call => call.action === 'ack'), false);
});

test('generated host HTML displays optional executable versions in both panels and reads older layouts', async t => {
  const { catalog } = require('../media/commander-column-settings');
  const initial = clipboardFixture();
  initial.folders['C:/tmp'] = [{ id: 'dll', name: 'library.dll', type: 'binary', fsSource: 'C:/tmp/library.dll', fileVersion: [4, 3, 2, 1], fileVersionString: '4.3 beta', comment: '<notes>', attributeFlags: { system: true } }];
  initial.folders['C:/temp'] = [{ id: 'exe', name: 'program.exe', type: 'binary', fsSource: 'C:/temp/program.exe', fileVersion: [0, 0, 0, 0] }];
  for (const legacy of [false, true]) {
    const layout = (legacy ? catalog.slice(0, 13) : catalog).map(column => ({ id: column.id, align: column.align, visible: ['name', 'version', 'versionString', 'comment', 'system'].includes(column.id) }));
    const configuration = { 'columns.layout': layout };
    const app = harness(t, { configuration, filesystemLoad: async () => initial });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    assert.match(panel.webview.html, /Content-Security-Policy/);
    const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
    const panes = view.document.querySelectorAll('.pane');
    for (const [index, expected] of ['4.3.2.1', '0.0.0.0'].entries()) {
      const heading = panes[index].querySelector('[data-column="version"]');
      if (legacy) assert.equal(heading, null);
      else { assert.equal(heading.textContent.trim(), 'Version'); assert.ok(panes[index].textContent.includes(expected)); }
    }
    assert.equal(configuration['columns.layout'].length, legacy ? 13 : catalog.length);
    if (!legacy) {
      assert.ok(panes[0].textContent.includes('4.3 beta'));
      assert.ok(panes[0].textContent.includes('<notes>'));
      assert.equal(panes[0].querySelector('notes'), null);
    }
    panel.dispose();
  }
});

test('status log copy adds runtime metadata and confirms the clipboard write', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'status-log-copy', requestId: 'status-log-1', text: JSON.stringify({ formatVersion: 1, currentMessage: 'Read directory', operations: [] }) });
  const report = JSON.parse(app.clipboardCalls.at(-1).text);
  assert.equal(report.runtime.extensionVersion, require('../package.json').version);
  assert.equal(report.runtime.platform, process.platform);
  assert.equal(report.runtime.runtimeVersion, process.version);
  assert.equal(report.currentMessage, 'Read directory');
  assert.equal(panel.messages.findLast(message => message.type === 'status-log-copy-result').ok, true);
});

test('status log copy reports clipboard errors without a success acknowledgement', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), writeClipboardText: async () => { throw new Error('Clipboard unavailable'); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'status-log-copy', requestId: 'status-log-2', text: JSON.stringify({ formatVersion: 1 }) });
  const result = panel.messages.findLast(message => message.type === 'status-log-copy-result');
  assert.equal(result.ok, false); assert.match(result.error, /Clipboard unavailable/);
});

test('refresh reports the actual pending state save before its final response', async t => {
  const initial = clipboardFixture(), gate = deferred(); let hold = false;
  const app = harness(t, { filesystemLoad: async () => initial, update: async (_store, key) => { if (hold && key === 'fileManagerState') await gate.promise; } });
  t.after(() => gate.resolve());
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  hold = true;
  const result = panel.receive({ type: 'filesystem-refresh', refreshRequestId: 'refresh-save', state: initial });
  await tick();
  assert.ok(panel.messages.some(message => message.type === 'filesystem-refresh-step' && message.phase === 'state-save' && message.refreshRequestId === 'refresh-save'));
  assert.equal(panel.messages.some(message => message.type === 'filesystem-result' && message.refreshRequestId === 'refresh-save'), false);
  gate.resolve(); await result;
  assert.ok(panel.messages.some(message => message.type === 'filesystem-result' && message.refreshRequestId === 'refresh-save'));
});

test('generated host HTML receives correlated metadata progress during an explicit refresh', async t => {
  const initial = clipboardFixture();
  const Progress = require('../media/commander-progress');
  const bytes = Progress.event({ phase: 'directory-comments', overall: Progress.unknown('bytes', 4, 'enumerating'), current: Progress.known('bytes', 4, 10) });
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const read = async settings => {
    await settings?.onDirectory?.({ path: 'C:/tmp', names: ['a.txt'], rows: [] });
    await settings?.onDirectory?.({ path: 'C:/tmp', phase: 'comments', completed: 1, total: 1, rows: [], progress: bytes });
    await settings?.onDirectory?.({ path: 'C:/tmp', phase: 'validation', completed: 1, total: 1, rows: [] });
    await settings?.onDirectory?.({ path: 'C:/tmp', done: true, rows: [] });
    return initial;
  };
  const app = harness(t, { filesystemLoad: read, filesystemPrepare: (_state, settings) => read(settings) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.action('refresh');
  const request = view.messages.find(message => message.type === 'filesystem-refresh');
  await panel.receive(request);
  const steps = panel.messages.filter(message => message.type === 'filesystem-refresh-step');
  assert.equal(panel.messages.findLast(message => message.type === 'filesystem-result').refreshRequestId, request.refreshRequestId);
  assert.deepEqual(steps.map(message => message.phase), ['metadata', 'comments', 'validation', 'done', 'state-save']);
  assert.deepEqual(steps[1].progress, bytes);
  assert.ok(steps.every(message => message.refreshRequestId === request.refreshRequestId));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: steps[0] }));
  assert.match(view.document.querySelector('#status-activity').textContent, /Dateieigenschaften lesen|Read file properties/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('generated context popup routes columns and exposes scoped folder tab focus', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const { createApp } = require('./support/webview.cjs');
  const view = createApp(t, undefined, { html: panel.webview.html });
  const crumb = view.document.querySelector('[data-breadcrumb]'); crumb.focus();
  await panel.receive(view.messages.filter(message => message.type === 'inputFocus').at(-1));
  assert.equal(app.contexts.get('bitfroest.tabFocus'), true);
  view.document.querySelector('.ag-header-cell').dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  view.click(view.document.querySelector('[data-context-action="configure-columns"]'));
  await panel.receive(view.messages.find(message => message.type === 'configure-columns'));
  await app.panels[1].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[1].messages.at(-1).section, 'columns');
  await panel.receive({ type: 'inputFocus', tabs: true, value: true });
  assert.equal(app.contexts.get('bitfroest.tabFocus'), false);
  await panel.receive({ type: 'inputFocus', tabs: true, dialog: true });
  assert.equal(app.contexts.get('bitfroest.tabFocus'), false);
  await panel.receive({ type: 'inputFocus', tabs: true }); panel.dispose();
  assert.equal(app.contexts.get('bitfroest.tabFocus'), false);
});

test('only a real window focus transition requests a filesystem focus refresh', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const count = () => panel.messages.filter(message => message.type === 'window-focus').length;
  app.windowFocus(true); assert.equal(count(), 0);
  app.windowFocus(false); assert.equal(count(), 0);
  app.windowFocus(true); assert.equal(count(), 1);
  app.windowFocus(true); assert.equal(count(), 1);
  panel.dispose(); app.windowFocus(false); app.windowFocus(true); assert.equal(count(), 1);
});

test('system-menu Git Diff uses confirmed repository status and shares the captured Git action', async t => {
  const initial = clipboardFixture(); let loads = 0;
  const repository = { status: async () => {}, state: { indexChanges: [{ uri: { fsPath: 'C:/tmp/a.txt' } }] } };
  const app = harness(t, { filesystemLoad: async () => { loads++; return initial; },
    gitInspect: async directories => Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, statuses: {} }])),
    gitExtension: { enabled: true, getAPI: () => ({ getRepository: () => repository }) },
    shellMenuShow: async (_paths, settings) => { assert.equal(settings.gitDiff, true); return { ok: true, displayed: true, invoked: true, cancelled: false, action: 'git-diff' }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'git-status', requestId: 'git-1', snapshotId: 'clipboard', directories: ['C:/tmp'] });
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.equal(app.calls.find(call => call.id === 'git.openChange')?.args[0].fsPath, 'C:/tmp/a.txt');
  assert.equal(loads, 1); assert.equal(panel.messages.at(-1).action, 'git-diff');
  assert.equal(panel.messages.at(-1).refreshed, false);
});

test('system-menu Git Diff is absent after repository inspection fails', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(),
    gitInspect: async (_directories, _settings, _creation, onProgress) => { onProgress({ 'C:/tmp': { ok: true, repository: true, statuses: {} } }); throw new Error('Status unavailable'); },
    shellMenuShow: async (_paths, settings) => { assert.equal(settings.gitDiff, false); return { ok: true, displayed: true, invoked: false, cancelled: true }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'git-status', requestId: 'git-1', snapshotId: 'clipboard', directories: ['C:/tmp'] });
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.equal(panel.messages.at(-1).ok, true);
  assert.equal(app.calls.some(call => call.id === 'git.openChange'), false);
});

test('Git History opens its own editor for captured files and folders and rejects stale selections', async t => {
  for (const folder of [false, true]) {
    const initial = clipboardFixture();
    if (folder) { initial.folders['C:/tmp'][0] = { id: 'a', name: 'docs', type: 'folder', fsSource: 'C:/tmp/docs' }; initial.folders['C:/tmp/docs'] = []; }
    const app = harness(t, { filesystemLoad: async () => initial,
      gitExtension: { enabled: true, getAPI: () => ({ getRepository: () => ({ rootUri: { fsPath: 'C:/tmp' }, state: {} }) }) } });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
    assert.match(panel.webview.html, /Content-Security-Policy/);
    const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
    const status = view.messages.find(m => m.type === 'git-status');
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: status.requestId, snapshotId: status.snapshotId, directories: { 'C:/tmp': { ok: true, repository: true, statuses: {} } } } }));
    const row = view.row(folder ? 'docs' : 'a.txt');
    row.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await app.command('bitfroest.gitHistory', JSON.parse(row.dataset.vscodeContext));
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.at(-1) }));
    const request = view.messages.find(m => m.type === 'git-history'); assert.ok(request);
    await panel.receive(request);
    const history = app.panels.find(p => p.viewType === 'bitfroestGitHistory'); assert.ok(history);
    assert.match(history.webview.html, /git-history/);
    assert.equal(app.calls.some(call => call.id === 'files.openTimeline'), false);
    assert.equal(panel.messages.find(m => m.requestId === request.requestId)?.ok, true);
    await panel.receive({ ...request, requestId: 'ui-action-2', snapshotId: 'stale' });
    assert.equal(panel.messages.find(m => m.requestId === 'ui-action-2')?.ok, false);
    assert.equal(app.panels.filter(p => p.viewType === 'bitfroestGitHistory').length, 1);
  }
});

test('Git History reports integration and repository failures through status replies', async t => {
  for (const mode of ['missing', 'disabled', 'repository']) {
    const initial = clipboardFixture();
    if (mode === 'older-folder') initial.folders['C:/tmp'][0] = { id: 'a', name: 'docs', type: 'folder', fsSource: 'C:/tmp/docs' };
    const app = harness(t, { filesystemLoad: async () => initial, vscodeVersion: '1.100.0', commandError: mode === 'command' ? 'files.openTimeline' : undefined,
      gitExtension: mode === 'missing' ? undefined : { enabled: mode !== 'disabled', getAPI: () => ({ getRepository: () => mode === 'repository' ? null : {}, openRepository: async () => null }) } });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
    await panel.receive({ type: 'git-history', requestId: 'ui-action-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
    const result = panel.messages.find(m => m.type === 'ui-action-result');
    assert.equal(result?.ok, false, mode); assert.ok(result.error, mode); assert.equal(app.errors.length, 0, mode);
    if (mode !== 'command') assert.equal(app.calls.some(call => call.id === 'files.openTimeline'), false, mode);
  }
});

test('Git Keep Local confirms a prepared file identity and cancellation never removes tracking', async t => {
  for (const accept of [false, true]) {
    const operations = [], initial = clipboardFixture();
    const app = harness(t, { filesystemLoad: async () => initial,
      gitExtension: { enabled: true, getAPI: () => ({ getRepository: () => ({ rootUri: { fsPath: 'C:/tmp' }, status: async () => {} }) }) },
      gitFilePrepare: async input => { operations.push(['prepare', input]); return { captured: true }; },
      gitFileExecute: async ticket => { assert.equal(ticket.captured, true); operations.push(['execute']); },
      showWarningMessage: async (_message, _settings, button) => accept ? button : undefined });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
    await panel.receive({ type: 'git-ignore', requestId: 'ui-action-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
    const result = panel.messages.find(m => m.type === 'ui-action-result'); assert.equal(result?.ok, true); assert.equal(Boolean(result.cancelled), !accept);
    assert.equal(operations[0][1].target, 'C:/tmp/a.txt'); assert.equal(operations[0][1].ignore, true);
    assert.equal(operations.some(o => o[0] === 'execute'), accept);
    assert.equal(app.deleteCalls.length, 0);
  }
});

test('location history opens the current directory without requiring or accepting a stale row selection', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(),
    gitExtension: { enabled: true, getAPI: () => ({ getRepository: () => ({ rootUri: { fsPath: 'C:/tmp' }, state: {} }) }) } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'git-history-directory', requestId: 'ui-action-1', directory: 'C:/tmp', snapshotId: 'clipboard' });
  assert.equal(app.panels.filter(p => p.viewType === 'bitfroestGitHistory').length, 1);
  await panel.receive({ type: 'git-history-directory', requestId: 'ui-action-2', directory: 'C:/temp/unknown', snapshotId: 'clipboard' });
  assert.equal(panel.messages.find(m => m.requestId === 'ui-action-2').ok, false);
  assert.equal(app.panels.filter(p => p.viewType === 'bitfroestGitHistory').length, 1);
});

test('system-menu Git History delegates a selected folder without refreshing or invoking a shell verb', async t => {
  const initial = clipboardFixture(); initial.folders['C:/tmp'][0] = { id: 'a', name: 'docs', type: 'folder', fsSource: 'C:/tmp/docs' }; initial.folders['C:/tmp/docs'] = [];
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: async directories => Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, statuses: {} }])),
    gitExtension: { enabled: true, getAPI: () => ({ getRepository: () => ({ rootUri: { fsPath: 'C:/tmp' }, state: {} }) }) },
    shellMenuShow: async (_paths, settings) => { assert.equal(settings.gitHistory, true); assert.equal(settings.gitDiff, false); return { ok: true, displayed: true, invoked: true, cancelled: false, action: 'git-history' }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'git-status', requestId: 'git-1', snapshotId: 'clipboard', directories: ['C:/tmp'] });
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.ok(app.panels.find(p => p.viewType === 'bitfroestGitHistory'));
  assert.equal(app.calls.some(call => call.id === 'files.openTimeline'), false);
  assert.equal(panel.messages.at(-1).action, 'git-history'); assert.equal(panel.messages.at(-1).refreshed, false); assert.equal(panel.messages.at(-1).invoked, false);
});

test('Git Diff validates captured selection and delegates to the built-in Git change editor', async t => {
  const initial = clipboardFixture(); let statusCalls = 0;
  const repository = { status: async () => { statusCalls++; }, state: { workingTreeChanges: [{ uri: { fsPath: 'C:/tmp/a.txt' } }], indexChanges: [], untrackedChanges: [], mergeChanges: [] } };
  const app = harness(t, { filesystemLoad: async () => initial, gitExtension: { enabled: true, getAPI: version => { assert.equal(version, 1); return { getRepository: () => repository }; } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'app-ready' });
  const request = { type: 'git-diff', requestId: 'ui-action-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' };
  await panel.receive(request);
  const call = app.calls.find(call => call.id === 'git.openChange');
  assert.ok(call); assert.equal(call.args[0].fsPath, 'C:/tmp/a.txt'); assert.equal(statusCalls, 1);
  await panel.receive({ ...request, snapshotId: 'old' });
  await panel.receive({ ...request, ids: ['missing'] });
  assert.equal(app.calls.filter(call => call.id === 'git.openChange').length, 1);
});

test('Git Diff opens clean files against HEAD through the public diff command', async t => {
  const initial = clipboardFixture(); let opened;
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const repository = { status: async () => {}, state: {} };
  const api = { getRepository: () => null, openRepository: async uri => { opened = uri.fsPath; return repository; }, toGitUri: (uri, ref) => ({ scheme: 'git', fsPath: uri.fsPath, ref }) };
  const app = harness(t, { filesystemLoad: async () => initial, gitExtension: { enabled: true, getAPI: () => api } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'app-ready' });
  const selection = { webviewSection: 'files', gitFile: true, directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' };
  await app.command('bitfroest.gitDiff', selection);
  const action = panel.messages.at(-1); assert.equal(action.action, 'git-diff');
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: action }));
  const request = view.messages.find(message => message.type === 'git-diff'); assert.ok(request);
  await panel.receive(request);
  const call = app.calls.find(call => call.id === 'vscode.diff'); assert.ok(call);
  assert.equal(opened, 'C:/tmp'); assert.equal(call.args[0].ref, 'HEAD'); assert.equal(call.args[1].fsPath, 'C:/tmp/a.txt');
  assert.equal(call.args[3].preview, false);
  assert.equal(panel.messages.at(-1).ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.at(-1) }));
  assert.equal(view.document.querySelector('#status-message').textContent, 'Git-Diff geöffnet.');
});

test('Git Diff reports unavailable integration and command errors in the existing status protocol', async t => {
  for (const mode of ['missing', 'disabled', 'repository', 'command']) {
    const initial = clipboardFixture();
    const repository = { status: async () => {}, state: { indexChanges: [{ uri: { fsPath: 'C:/tmp/a.txt' } }] } };
    const app = harness(t, { filesystemLoad: async () => initial, commandError: mode === 'command' ? 'git.openChange' : undefined,
      gitExtension: mode === 'missing' ? undefined : { enabled: mode !== 'disabled', getAPI: () => ({ getRepository: () => mode === 'repository' ? null : repository, openRepository: async () => null }) } });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
    await panel.receive({ type: 'git-diff', requestId: 'ui-action-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
    const result = panel.messages.find(message => message.type === 'ui-action-result');
    assert.equal(result?.ok, false, mode); assert.ok(result.error, mode); assert.equal(app.errors.length, 0, mode);
    if (mode !== 'command') assert.equal(app.calls.some(call => call.id === 'git.openChange'), false, mode);
  }
});

test('settings and shortcut commands share the existing configuration panel', async t => {
  const app = harness(t);
  await app.command('bitfroest.configureSettings');
  const settings = app.panels.at(-1);
  await settings.receive({ type: 'configuration-ready' });
  assert.equal(settings.messages.at(-1).section, 'settings');
  assert.ok(settings.messages.at(-1).settings.length > 0);
  await app.command('bitfroest.configureShortcuts');
  assert.equal(app.panels.length, 1);
  assert.equal(app.panels.at(-1), settings);
  assert.equal(settings.messages.at(-1).type, 'configuration-section');
  assert.equal(settings.messages.at(-1).section, 'shortcuts');
});

test('custom shortcut execution is validated against persisted binding, live focus and readiness', async t => {
  const { catalog } = require('../shortcut-settings');
  const copy = catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
  const app = harness(t, { configuration: { 'shortcuts.bindings': { [copy.id]: 'ctrl+shift+k' } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  panel.active = true;
  await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'inputFocus', list: true });
  const count = () => panel.messages.filter(message => message.type === 'action' && message.action === 'copy').length;
  const before = count();
  await panel.receive({ type: 'shortcut-execute', id: copy.id, key: 'ctrl+shift+k' }); assert.equal(count(), before + 1);
  assert.equal(app.contexts.get(`bitfroest.shortcutOverride.${copy.id}`), true);
  await panel.receive({ type: 'shortcut-execute', id: copy.id, key: 'f6' }); assert.equal(count(), before + 1);
  await panel.receive({ type: 'inputFocus', value: true });
  await panel.receive({ type: 'shortcut-execute', id: copy.id, key: 'ctrl+shift+k' }); assert.equal(count(), before + 1);
});

test('rapid external shortcut changes cannot leave obsolete host guards enabled', async t => {
  const { catalog } = require('../shortcut-settings');
  const copy = catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
  const entered = deferred(), release = deferred(), configuration = {};
  const app = harness(t, { configuration, commandEffect: async (id, args) => {
    if (id === 'setContext' && args[0] === `bitfroest.shortcutOverride.${copy.id}` && args[1]) { entered.resolve(); await release.promise; }
  } });
  await app.command('bitfroest.openPrototype');
  configuration['shortcuts.bindings'] = { [copy.id]: 'ctrl+shift+k' };
  const first = app.configuration('bitfroest.shortcuts'); await entered.promise;
  configuration['shortcuts.bindings'] = {};
  const second = app.configuration('bitfroest.shortcuts'); release.resolve();
  await Promise.all([first, second]);
  assert.equal(app.contexts.get(`bitfroest.shortcutOverride.${copy.id}`), false);
  assert.deepEqual(app.panels[0].messages.filter(message => message.type === 'shortcut-settings').at(-1).bindings, {});
});

test('ignored badges are requested by default and retain the explicit setting to turn them off', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let observed;
  const configuration = {};
  const app = harness(t, { configuration, filesystemLoad: async () => initial,
    gitInspect: async (directories, settings) => { observed = settings.showIgnored; return Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, statuses: { 'a.txt': 'ignored' } }])); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  await panel.receive(view.messages.find(message => message.type === 'git-status'));
  assert.equal(observed, true);
  const result = panel.messages.filter(message => message.type === 'git-status-result').at(-1);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.ok(view.row('a.txt').querySelector('svg.bi-slash-circle-fill'));
  configuration['gitStatus.showIgnored'] = false;
  await app.configuration('bitfroest.gitStatus');
  await panel.receive({ ...view.messages.find(message => message.type === 'git-status'), requestId: 'ignored-off' });
  assert.equal(observed, false);
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties));
  assert.equal(properties['bitfroest.gitStatus.showIgnored'].default, true);
  panel.dispose();
});

test('Bootstrap overlay size reaches generated HTML and updates without clearing current Git status', async t => {
  const configuration = { 'gitStatus.iconSizePercent': 66 };
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { configuration, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*git-status-icons.js"/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.equal(JSON.parse(decodeURIComponent(view.document.body.dataset.fileSettings)).gitStatus.iconSizePercent, 66);
  configuration['gitStatus.iconSizePercent'] = 80;
  await app.configuration(['bitfroest.gitStatus', 'bitfroest.gitStatus.iconSizePercent']);
  assert.equal(panel.messages.filter(message => message.type === 'file-settings').at(-1).settings.gitStatus.iconSizePercent, 80);
  assert.equal(panel.messages.some(message => message.type === 'git-settings-changed'), false);
  panel.dispose();
});

test('host publishes the complete catalog defaults when no custom file colors are configured', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const defaults = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties))['bitfroest.colors.rules'].default;
  const app = harness(t, { configurationDefaults: { 'colors.rules': defaults }, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const settings = JSON.parse(decodeURIComponent(view.document.body.dataset.fileSettings));
  assert.deepEqual(settings.colors.rules, defaults);
  assert.ok(settings.colors.rules['*.xlsx']);
  assert.equal(app.updateCalls.some(call => call.store === 'configuration'), false);
  panel.dispose();
});

test('file colors reach actual host HTML and native configuration changes reach the existing view', async t => {
  const configuration = { 'colors.fileTypes': true, 'colors.gitStatus': true, 'colors.rules': { '*.txt': '#ffffff' } };
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { configuration, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*commander-file-colors.js"/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const parsed = JSON.parse(decodeURIComponent(view.document.body.dataset.fileSettings));
  assert.deepEqual(parsed.colors.rules, { '*.txt': '#ffffff' });
  configuration['colors.fileTypes'] = false;
  await app.configuration('bitfroest.colors');
  assert.equal(panel.messages.filter(message => message.type === 'file-settings').at(-1).settings.colors.enabled, false);
  panel.dispose();
});

function clipboardFixture() {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null });
  return { version: 1, realFilesystem: true, snapshotId: 'clipboard', active: 0, panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', fsSource: 'C:/tmp/a.txt' }], 'C:/temp': [] } };
}

test('error details copy passes through actual host HTML to the public clipboard API', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /img-src [^;]+ data:;/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html, language: 'de' });
  view.action('mkdir');
  view.document.querySelector('#value').value = 'new';
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  const error = "EPERM: operation not permitted, lstat 'C:\\DumpStack.log.tmp'\nC:\\Recovery\\Ä.stage";
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: initial, error } }));
  const illustration = view.document.querySelector('.operation-error img');
  assert.ok(illustration);
  assert.match(illustration.src, /error-monkey\.png$/);
  assert.notEqual(illustration.getAttribute('src'), 'error-monkey.png', 'host resolves the packaged image URI');
  assert.equal(view.document.querySelector('.operation-error details').open, false);
  view.click(view.document.querySelector('[data-copy-error]'));
  const request = view.messages.find(message => message.type === 'selection-io');
  await panel.receive(request);
  assert.deepEqual(app.clipboardCalls.at(-1), { action: 'writeText', text: 'Dateioperation fehlgeschlagen\n\n' + error });
  const response = panel.messages.find(message => message.type === 'selection-io-result' && message.requestId === request.requestId);
  assert.equal(response.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
  assert.ok(view.document.querySelector('.operation-error-text').value.endsWith(error));
  assert.equal(view.document.querySelector('#status-message').textContent, 'Fehlerdetails kopiert.');
  panel.dispose();
});

test('selection text requests pass through the actual host HTML and public clipboard API', async t => {
  const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.action('copy-names');
  const request = view.messages.find(message => message.type === 'selection-io'); assert.ok(request);
  await panel.receive(request);
  assert.deepEqual(app.clipboardCalls.at(-1), { action: 'writeText', text: 'a.txt' });
  assert.ok(panel.messages.some(message => message.type === 'selection-io-result' && message.requestId === request.requestId && message.ok));
  const before = app.clipboardCalls.length;
  await panel.receive({ ...request, requestId: '../bad' });
  await panel.receive({ ...request, action: 'copy', text: {} });
  assert.equal(app.clipboardCalls.length, before);
  panel.dispose();
});

test('path clipboard resolves host path ranges from real HTML while preserving detail cells', async t => {
  const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let seen;
  const app = harness(t, { filesystemLoad: async () => initial, resolveUncPaths: async paths => { seen = paths; return ['\\\\files\\team\\a.txt']; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.action('copy-full-details'); const request = view.messages.find(message => message.type === 'selection-io');
  await panel.receive(request);
  assert.deepEqual(Array.from(seen), ['C:\\tmp\\a.txt']);
  assert.equal(app.clipboardCalls.at(-1).text, request.text.replace('C:\\tmp\\a.txt', '\\\\files\\team\\a.txt'));
  assert.ok(panel.messages.some(message => message.type === 'selection-io-result' && message.ok));
  panel.dispose();
});

test('slash path command reaches the public clipboard through actual host HTML and preserves native copies', async t => {
  const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial, resolveUncPaths: async () => ['\\\\files\\team\\a.txt'] });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  await app.command('bitfroest.copy-full-names-slash');
  const action = panel.messages.filter(message => message.type === 'action' && message.action === 'copy-full-names-slash').at(-1);
  assert.ok(action);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: action }));
  const request = view.messages.filter(message => message.type === 'selection-io').at(-1);
  assert.equal(request.pathStyle, 'slash');
  await panel.receive(request);
  assert.equal(app.clipboardCalls.at(-1).text, process.platform === 'win32' ? '//files/team/a.txt' : '\\\\files\\team\\a.txt');
  const reply = panel.messages.find(message => message.type === 'selection-io-result' && message.requestId === request.requestId);
  assert.equal(reply.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
  const before = app.clipboardCalls.length;
  await panel.receive({ ...request, requestId: 'selection-991', pathStyle: 'invalid' });
  assert.equal(app.clipboardCalls.length, before);
  assert.equal(panel.messages.find(message => message.requestId === 'selection-991').ok, false);
  await app.command('bitfroest.copy-full-names');
  view.action('copy-full-names');
  await panel.receive(view.messages.filter(message => message.type === 'selection-io').at(-1));
  assert.equal(app.clipboardCalls.at(-1).text, '\\\\files\\team\\a.txt');
  panel.dispose();
  await app.command('bitfroest.copy-full-names-slash');
  assert.equal(app.clipboardCalls.length, before + 1);
});

test('panel disposal during UNC resolution prevents delayed clipboard writes', async t => {
  const initial = clipboardFixture(); let finish;
  const app = harness(t, { filesystemLoad: async () => initial, resolveUncPaths: () => new Promise(resolve => { finish = resolve; }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'selection-io', requestId: 'selection-42', action: 'copy', text: 'Z:\\a.txt', pathRanges: [{ start: 0, length: 8 }] });
  assert.equal(typeof finish, 'function'); panel.dispose(); finish(['\\\\files\\team\\a.txt']);
  await pending;
  assert.equal(app.clipboardCalls.length, 0);
});
test('native editor action reports a correlated completion only after the editor result', async t => {
  for (const fail of [false, true]) {
    const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
    initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
    const app = harness(t, { filesystemLoad: async () => initial, ...(fail ? { documentError: 'Editor failed', showErrorMessage: () => new Promise(() => {}) } : {}) });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
    view.action('edit'); const request = view.messages.find(message => message.type === 'edit'); assert.ok(request);
    assert.match(request.requestId, /^ui-action-\d+$/);
    assert.equal(view.document.querySelector('#status-message').dataset.outcome, 'info');
    await panel.receive(request);
    const reply = panel.messages.find(message => message.type === 'ui-action-result' && message.requestId === request.requestId); assert.ok(reply);
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
    assert.equal(view.document.querySelector('#status-message').dataset.outcome, fail ? 'error' : 'success');
    panel.dispose();
  }
});

test('Git host uses generated HTML, deduplicates trusted directories and opens a branch list', async t => {
  let inspected, branchPath, disposed = 0;
  const initial = clipboardFixture(); initial.panes[1] = structuredClone(initial.panes[0]);
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: async directories => { inspected = directories; return { 'C:/tmp': { ok: true, repository: true, branch: 'main', statuses: { 'a.txt': 'modified' } } }; },
    gitBranches: async directory => { branchPath = directory; return { ok: true, names: ['feature/one', 'main', 'second'], remoteNames: ['origin/main'], count: 3, otherCount: 2, branch: 'main' }; }, gitDispose: () => disposed++ });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const request = view.messages.find(message => message.type === 'git-status'); assert.ok(request);
  await panel.receive(request); assert.deepEqual(inspected, ['C:/tmp']);
  const result = panel.messages.find(message => message.type === 'git-status-result'); assert.ok(result);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.equal(view.document.querySelector('[data-git-branch]').textContent, '(main)');
  view.click(view.document.querySelector('[data-git-branch]'));
  await panel.receive(view.messages.find(message => message.type === 'git-branches'));
  assert.equal(branchPath, 'C:/tmp');
  const pick = app.quickPicks.at(-1); assert.ok(pick);
  assert.deepEqual(Array.from(pick.items, item => item.label), ['main', 'feature/one', 'second', 'origin/main']);
  assert.equal(pick.items[0].description, 'Aktueller Branch');
  assert.equal(pick.items.at(-1).description, 'Remote-Branch');
  assert.equal(app.information.length, 0);
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp');
  await panel.receive({ type: 'git-status', requestId: 'invalid', snapshotId: initial.snapshotId, directories: ['C:/private'] });
  assert.deepEqual(inspected, ['C:/tmp']); panel.dispose(); assert.equal(disposed, 1);
});

for (const reason of ['stale snapshot', 'unloaded opposite directory']) test(`rejected Git reads finish the matching visible activity: ${reason}`, async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let inspections = 0;
  const app = harness(t, { filesystemLoad: async () => initial, gitInspect: async () => { inspections++; return {}; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const request = view.messages.find(message => message.type === 'git-status');
  assert.ok(view.document.querySelector('[data-location-icon][aria-busy="true"]'));
  if (reason === 'stale snapshot') initial.snapshotId = 'new-snapshot';
  else initial.unloadedFolders = ['C:/temp'];
  await panel.receive({ type: 'filesystem-refresh', state: initial });
  await panel.receive(request);
  const reply = panel.messages.find(message => message.type === 'git-status-result' && message.requestId === request.requestId && !message.partial);
  assert.ok(reply, 'a rejected read must terminate its activity');
  assert.equal(reply.snapshotId, request.snapshotId);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
  assert.equal(view.document.querySelector('[data-location-icon][aria-busy="true"]'), null);
  assert.equal(inspections, 0);
  panel.dispose();
});

test('a Git read invalidated during its calculation still ends the original loading indicator', async t => {
  let initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const work = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, gitInspect: () => work.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const request = view.messages.find(message => message.type === 'git-status');
  const pending = panel.receive(request);
  initial = structuredClone(initial); initial.snapshotId = 'changed'; initial.folders['C:/tmp'] = []; initial.folders['C:/temp'] = [{ id: 'external', name: 'external.txt', type: 'text' }];
  await panel.receive({ type: 'filesystem-refresh', state: initial });
  work.resolve({ 'C:/tmp': { ok: true, repository: true, branch: 'old', statuses: {} } }); await pending;
  const reply = panel.messages.find(message => message.type === 'git-status-result' && !message.partial && message.requestId === request.requestId);
  assert.ok(reply, 'invalidating a running query must still finish it');
  assert.deepEqual(reply.directories, {});
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
  assert.equal(view.document.querySelector('[data-location-icon][aria-busy="true"]'), null);
  panel.dispose();
});

test('navigation rejected by an open native menu preserves its request identity', async t => {
  const initial = clipboardFixture(), choice = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, shellMenuShow: () => choice.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const menu = panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: initial.snapshotId });
  await tick();
  try {
    await panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-1', path: 'C:/temp', side: 0, state: initial });
    const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
    assert.equal(result?.ok, false);
    assert.equal(result.navigationRequestId, 'directory-1');
  } finally { choice.resolve({ ok: true, invoked: false, cancelled: true }); await menu; panel.dispose(); }
});

test('Git host ignores status work completed after panel disposal', async t => {
  const work = deferred(); let started = false;
  const initial = clipboardFixture(), app = harness(t, { filesystemLoad: async () => initial, gitInspect: () => { started = true; return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'git-status', requestId: 'late', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  assert.equal(started, true); panel.dispose(); work.resolve({}); await pending;
  assert.equal(panel.messages.some(message => message.type === 'git-status-result'), false);
});

test('Git host never queues navigation behind a pending status calculation', async t => {
  const initial = clipboardFixture(), work = deferred();
  initial.folders['C:/tmp/next'] = [];
  const app = harness(t, { filesystemLoad: async () => initial, gitInspect: () => work.promise,
    filesystemPrepare: async before => ({ ...before, snapshotId: 'navigated' }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'git-status', requestId: 'slow', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  await panel.receive({ type: 'filesystem-navigate', path: 'C:/tmp/next', side: 0, state: initial });
  assert.equal(panel.messages.find(message => message.type === 'filesystem-result')?.resumeNavigation.path, 'C:/tmp/next');
  work.resolve({}); await pending;
  assert.deepEqual(panel.messages.find(message => message.type === 'git-status-result')?.directories, {}); panel.dispose();
});

test('Linux symbolic navigation resolves the provider alias before preparing and returns the canonical directory', async t => {
  const alias = 'C:/tmp/linked-directory', canonical = 'C:/tmp/real-directory';
  const initial = clipboardFixture();
  initial.folders['C:/tmp'].push({ id: 'linked-directory', name: 'linked-directory', type: 'link', fsSource: alias });
  let preparedDirectories;
  const providerFactory = () => ({
    contains: value => ['C:/tmp', 'C:/temp', alias, canonical].includes(value),
    canNavigate: value => [alias, canonical, 'C:/tmp', 'C:/temp'].includes(value),
    resolveNavigation: async value => ({ path: value === alias ? canonical : value, kind: 'directory' }),
    load: async () => initial,
    prepare: async (before, settings) => {
      preparedDirectories = settings.directories;
      return { ...before, folders: { ...before.folders, [canonical]: [{ id: 'inside-link-target', name: 'inside.txt', type: 'text' }] } };
    },
    apply: async (_before, after) => after,
    remove: async before => before,
    measureFolder: async () => 0,
    dispose() {}
  });
  const app = harness(t, { providerFactory });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];

  await panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-201', path: alias, side: 0, state: initial });

  const reply = panel.messages.findLast(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-201');
  assert.deepEqual(preparedDirectories, [canonical]);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.resumeNavigation, { path: canonical, side: 0 });
  assert.ok(reply.state.folders[canonical].some(item => item.name === 'inside.txt'));
  panel.dispose();
});

test('Linux symbolic file navigation returns and authorizes only its canonical in-root file', async t => {
  const alias = 'C:/tmp/linked-file', canonical = 'C:/tmp/real-file.txt';
  const initial = clipboardFixture();
  initial.folders['C:/tmp'].push({ id: 'linked-file', name: 'linked-file', type: 'link', fsSource: alias });
  const identities = {
    link: { dev: '4', ino: '12', size: '8', mode: '40960', mtimeNs: '100', ctimeNs: '200', linkText: 'cmVhbC1maWxlLnR4dA==' },
    target: { dev: '4', ino: '30', size: '16', mode: '33188', mtimeNs: '300', ctimeNs: '400' }
  };
  let prepares = 0;
  const providerFactory = () => ({
    contains: value => ['C:/tmp', 'C:/temp', alias, canonical].includes(value),
    canNavigate: value => [alias, canonical, 'C:/tmp', 'C:/temp'].includes(value),
    resolveNavigation: async value => ({ path: value === alias ? canonical : value, kind: 'file', identities }),
    load: async () => initial,
    prepare: async () => { prepares++; throw new Error('A file link must not be prepared as a directory.'); },
    apply: async (_before, after) => after,
    remove: async before => before,
    measureFolder: async () => 0,
    dispose() {}
  });
  const app = harness(t, { providerFactory });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];

  await panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-202', path: alias, side: 0, state: initial });

  const reply = panel.messages.findLast(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-202');
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.resumeOpen, { path: canonical });
  assert.equal(prepares, 0);
  await panel.receive({ type: 'open', path: canonical });
  assert.deepEqual(app.openCalls, [canonical]);
  panel.dispose();
});

test('Linux resolved file-link open is rejected when the captured target identity changes', async t => {
  const alias = 'C:/tmp/linked-file', canonical = 'C:/tmp/real-file.txt';
  const initial = clipboardFixture();
  initial.folders['C:/tmp'].push({ id: 'linked-file', name: 'linked-file', type: 'link', fsSource: alias });
  const linkIdentity = { dev: '4', ino: '12', size: '8', mode: '40960', mtimeNs: '100', ctimeNs: '200' };
  let targetIdentity = { dev: '4', ino: '30', size: '16', mode: '33188', mtimeNs: '300', ctimeNs: '400' };
  const providerFactory = () => ({
    contains: value => ['C:/tmp', 'C:/temp', alias, canonical].includes(value),
    canNavigate: value => [alias, canonical, 'C:/tmp', 'C:/temp'].includes(value),
    resolveNavigation: async value => ({ path: value === alias ? canonical : value, kind: 'file', identities: { link: linkIdentity, target: targetIdentity } }),
    load: async () => initial,
    prepare: async (_before, settings) => settings,
    apply: async (_before, after) => after,
    remove: async before => before,
    measureFolder: async () => 0,
    dispose() {}
  });
  const app = harness(t, { providerFactory });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-203', path: alias, side: 0, state: initial });
  targetIdentity = { ...targetIdentity, ino: '31' };

  await panel.receive({ type: 'open', requestId: 'ui-action-203', path: canonical });

  assert.deepEqual(app.openCalls, []);
  assert.equal(panel.messages.findLast(message => message.type === 'ui-action-result' && message.requestId === 'ui-action-203')?.ok, false);
  panel.dispose();
});

test('resolved file-link authorization ends when its panel closes', async t => {
  const alias = 'C:/tmp/linked-file', canonical = 'C:/tmp/real-file.txt';
  const initial = clipboardFixture();
  const providerFactory = () => ({
    contains: value => ['C:/tmp', 'C:/temp', alias].includes(value),
    canNavigate: () => true,
    resolveNavigation: async () => ({ path: canonical, kind: 'file', identities: {
      link: { dev: '1', ino: '2', mode: '40960', size: '10', mtimeNs: '1', ctimeNs: '1', linkText: 'ZmlsZQ==' },
      target: { dev: '1', ino: '3', mode: '33188', size: '4', mtimeNs: '1', ctimeNs: '1' }
    } }),
    load: async () => initial, prepare: async before => before, apply: async (_before, after) => after,
    remove: async before => before, measureFolder: async () => 0, dispose() {}
  });
  const app = harness(t, { providerFactory });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-204', path: alias, side: 0, state: initial });
  app.panels[0].dispose();
  await app.command('bitfroest.openPrototype');
  const panel = app.panels.at(-1);
  await panel.receive({ type: 'open', requestId: 'ui-action-204', path: canonical });
  assert.deepEqual(app.openCalls, []);
  assert.equal(panel.messages.findLast(message => message.type === 'ui-action-result' && message.requestId === 'ui-action-204')?.ok, false);
  panel.dispose();
});

test('generated host HTML double-click resolves a link through CSP-protected navigation and replies canonically', async t => {
  const alias = 'C:/tmp/linked-directory', canonical = 'C:/tmp/real-directory';
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  initial.folders['C:/tmp'].push({ id: 'linked-directory', name: 'linked-directory', type: 'link', fsSource: alias });
  const providerFactory = () => ({
    contains: value => ['C:/tmp', 'C:/temp', alias, canonical].includes(value),
    canNavigate: value => [alias, canonical, 'C:/tmp', 'C:/temp'].includes(value),
    resolveNavigation: async value => ({ path: value === alias ? canonical : value, kind: 'directory' }),
    load: async () => initial,
    prepare: async before => ({ ...before, folders: { ...before.folders, [canonical]: [{ id: 'canonical-child', name: 'inside.txt', type: 'text' }] } }),
    apply: async (_before, after) => after,
    remove: async before => before,
    measureFolder: async () => 0,
    dispose() {}
  });
  const app = harness(t, { providerFactory });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html, platform: 'linux' });

  view.click(view.row('linked-directory').querySelector('[data-filename]'));
  view.key('Enter');
  const request = view.messages.findLast(message => message.type === 'filesystem-navigate');
  assert.ok(request);
  await panel.receive(request);
  for (const message of panel.messages.filter(message => message.navigationRequestId === request.navigationRequestId)) {
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
  }

  assert.equal(view.state().panes[0].tabs[0], canonical);
  assert.ok(view.row('inside.txt'));
  assert.equal(panel.messages.findLast(message => message.type === 'filesystem-result').resumeNavigation.path, canonical);
  panel.dispose();
});

test('generated host HTML clears a cold directory immediately and keeps navigation bound through streamed completion', async t => {
  const initial = clipboardFixture(), target = 'C:/tmp/next', waiting = deferred(), started = deferred();
  initial.panes.forEach(p => { p.filter = ''; p.sort = 'name'; });
  initial.folders['C:/tmp'].push({ id: 'next', name: 'next', type: 'folder' });
  initial.folders[target] = []; initial.unloadedFolders = [target];
  const row = { id: 'fresh', name: 'fresh.txt', type: 'text' };
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async (before, options) => {
    started.resolve(); await waiting.promise;
    await options.onDirectory({ path: target, names: ['fresh.txt'], rows: [row] });
    return { ...before, unloadedFolders: [], folders: { ...before.folders, [target]: [row] } };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('next').querySelector('[data-filename]')); view.key('Enter');
  const request = view.messages.findLast(message => message.type === 'filesystem-navigate');
  const pending = panel.receive(request); await started.promise;
  assert.equal(view.state().panes[0].tabs[0], target);
  assert.equal(Boolean(view.row('a.txt')), false);
  view.click(view.document.querySelector('[data-pane="1"] .list'));
  waiting.resolve(); await pending;
  for (const data of panel.messages.filter(message => message.navigationRequestId === request.navigationRequestId)) {
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data }));
  }
  assert.equal(view.state().panes[0].tabs[0], target);
  assert.equal(view.state().panes[1].tabs[0], 'C:/temp');
  assert.equal(view.state().active, 1);
  assert.equal(view.state().panes[0].tabs.length, 1);
  assert.equal(Boolean(view.document.querySelector('[data-pane="0"] [data-id="fresh"]')), true);
});

test('directory navigation streams display batches and binds the final snapshot to the request', async t => {
  const initial = clipboardFixture(); initial.folders['C:/tmp/next'] = [];
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async (before, options) => {
    await options.onDirectory({ path: 'C:/tmp/next', names: ['fresh.txt'], rows: [] });
    await options.onDirectory({ path: 'C:/tmp/next', rows: [{ id: 'fresh', name: 'fresh.txt', type: 'text' }] });
    return { ...before, snapshotId: 'streamed', folders: { ...before.folders, 'C:/tmp/next': [{ id: 'fresh', name: 'fresh.txt', type: 'text' }] } };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /commander-directory-cache\.js/);
  assert.match(panel.webview.html, /href="webview-resource:[^"]*codicons\.css"/);
  assert.match(panel.webview.html, /font-src webview-resource:/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-1', path: 'C:/tmp/next', side: 0, state: initial });
  const messages = panel.messages.filter(message => message.navigationRequestId === 'directory-1');
  assert.deepEqual(messages.map(message => message.type), ['filesystem-directory', 'filesystem-directory', 'filesystem-result']);
  assert.equal(messages.at(-1).state.snapshotId, 'streamed'); assert.equal(messages.at(-1).ok, true);
});

test('newer navigation aborts obsolete same-panel reads before processing its destination', async t => {
  const initial = clipboardFixture(), started = deferred(); let firstSignal;
  initial.folders['C:/tmp/first'] = []; initial.folders['C:/tmp/last'] = [];
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async (before, options) => {
    if (options.directories[0].endsWith('/first')) {
      firstSignal = options.signal; started.resolve();
      await new Promise((resolve, reject) => { if (!firstSignal) { resolve(); return; } firstSignal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }); });
    }
    return { ...before, snapshotId: 'latest' };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const first = panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-1', path: 'C:/tmp/first', side: 0, state: initial });
  await started.promise;
  await panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-2', path: 'C:/tmp/last', side: 0, state: initial }); await first;
  assert.equal(firstSignal?.aborted, true);
  assert.equal(panel.messages.find(m => m.navigationRequestId === 'directory-1' && m.type === 'filesystem-result').cancelled, true);
  assert.equal(panel.messages.at(-1).resumeNavigation.path, 'C:/tmp/last');
});

test('Git host keeps the unchanged right status pending across left navigation without querying it again', async t => {
  const initial = clipboardFixture(), first = deferred(), second = deferred(), calls = [];
  initial.folders['C:/tmp/next'] = [];
  let initialProgress;
  const app = harness(t, { filesystemLoad: async () => initial,
    filesystemPrepare: async before => ({ ...before, snapshotId: 'navigated' }),
    gitInspect: (directories, _settings, _creation, onProgress) => {
      calls.push(directories);
      if (calls.length === 1) { initialProgress = onProgress; return first.promise; }
      return second.promise;
    }
  });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const initialRequest = panel.receive({ type: 'git-status', requestId: 'both', snapshotId: initial.snapshotId, directories: ['C:/tmp', 'C:/temp'] });
  await panel.receive({ type: 'filesystem-navigate', side: 0, path: 'C:/tmp/next', state: initial });
  const nextRequest = panel.receive({ type: 'git-status', requestId: 'left', snapshotId: 'navigated', directories: ['C:/tmp/next'], visibleDirectories: ['C:/tmp/next', 'C:/temp'] });
  initialProgress({ 'C:/temp': { ok: true, repository: true, branch: 'right', loading: true, statuses: {} }, 'C:/tmp': { ok: true, repository: true, branch: 'stale-left', statuses: {} } });
  const progress = panel.messages.filter(message => message.type === 'git-status-result' && message.partial).at(-1);
  assert.ok(progress);
  assert.deepEqual(Object.keys(progress.directories), ['C:/temp']);
  first.resolve({ 'C:/temp': { ok: true, repository: true, branch: 'right', statuses: {} }, 'C:/tmp': { ok: true, repository: true, branch: 'stale-left', statuses: {} } });
  await initialRequest;
  assert.deepEqual(calls, [['C:/tmp', 'C:/temp'], ['C:/tmp/next']]);
  const final = panel.messages.filter(message => message.type === 'git-status-result' && !message.partial && message.requestId === 'both').at(-1);
  assert.deepEqual(Object.keys(final.directories), ['C:/temp']);
  second.resolve({}); await nextRequest; panel.dispose();
});

test('Git host drops a late branch count after navigation with the same snapshot', async t => {
  const initial = clipboardFixture(), work = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, gitBranches: () => work.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'first', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  const pending = panel.receive({ type: 'git-branches', path: 'C:/tmp', snapshotId: initial.snapshotId });
  await panel.receive({ type: 'git-status', requestId: 'next', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  work.resolve({ ok: true, count: 3, otherCount: 2 }); await pending;
  assert.equal(app.information.length, 0); assert.equal(app.quickPicks.length, 0); panel.dispose();
});

test('Git host defers hidden-panel updates and refreshes when the panel becomes visible', async t => {
  const initial = clipboardFixture(); let inspected = 0, observer;
  const app = harness(t, { filesystemLoad: async () => initial, gitInspect: async (_directories, _settings, creation) => { inspected++; observer = creation; return {}; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'visible', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  assert.equal(observer.onChange, undefined, 'no filesystem change subscription is configured');
  panel.changeVisibility(false); await tick(); assert.equal(inspected, 1);
  panel.changeVisibility(true); await tick(); assert.equal(inspected, 2); panel.dispose();
});

test('Git host drops a late branch error after navigation', async t => {
  const initial = clipboardFixture(), work = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, gitBranches: () => work.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'before', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  const pending = panel.receive({ type: 'git-branches', path: 'C:/tmp', snapshotId: initial.snapshotId });
  await panel.receive({ type: 'git-status', requestId: 'after', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  work.reject(new Error('Old repository unavailable')); await pending;
  assert.deepEqual(app.errors, []); panel.dispose();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, options = {}) {
  const commands = new Map(), calls = [], panels = [], errors = [], information = [], contexts = new Map();
  const textDocuments = [], textEditors = [], quickPicks = [], nativeCalls = [], updateCalls = [];
  const deleteCalls = [];
  const documentProviders = new Map();
  const clipboardCalls = [];
  const readonlyPaths = [];
  const trashCalls = [];
  const shellCalls = [], shellDisposals = [], openCalls = [];
  let providerOptions;
  const choices = [...(options.choices || [])];
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: options.platform || 'win32', configurable: true });
  const disposable = () => ({ dispose() {} });
  const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath.replace(/\\/g, '/')}` });
  function memento(name, initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
      values,
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) {
        updateCalls.push({ store: name, key, value });
        if (options.update) await options.update(name, key, value);
        values.set(key, value);
      }
    };
  }
  const context = {
    subscriptions: [], extensionUri: { ...uri(root), scheme: options.extensionScheme || 'file' }, extensionPath: root,
    extension: { extensionKind: options.extensionKind || 1 },
    globalStorageUri: uri(path.join(root, 'storage')),
    extensionMode: options.development ? 2 : 1,
    workspaceState: memento('workspace', options.workspaceState),
    globalState: memento('global', options.globalState)
  };
  let configurationListener, saveDocumentListener, closeDocumentListener, windowStateListener;
  let status, serializer;
  const tabGroups = [], tabListeners = new Set(), groupListeners = new Set();
  const vscode = {
    version: options.vscodeVersion || '1.144.1',
    extensions: { getExtension: id => id === 'vscode.git' && options.gitExtension ? { activate: async () => options.gitExtension } : undefined },
    env: { language: options.language || 'de', remoteName: options.remoteName, openExternal: async uri => { calls.push({ id: 'openExternal', args: [uri.toString()] }); return true; }, clipboard: { writeText: async text => { clipboardCalls.push({ action: 'writeText', text }); await options.writeClipboardText?.(text); }, readText: async () => { clipboardCalls.push({ action: 'readText' }); if (options.readClipboardText) return options.readClipboardText(); return options.clipboardText || ''; } } },
    ExtensionKind: { UI: 1, Workspace: 2 },
    Uri: { parse: value => ({ toString: () => value }), file: uri, joinPath: (base, ...parts) => uri(path.resolve(base.fsPath, ...parts)) },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Right: 2 }, ViewColumn: { Active: -1, Beside: -2, One: 1 }, ExtensionMode: { Development: 2 },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return disposable(); },
      async executeCommand(id, ...args) {
        calls.push({ id, args });
        if (id === 'setContext') contexts.set(args[0], args[1]);
        if (options.commandError === id) throw new Error(`Command failed: ${id}`);
        if (options.commandEffect) await options.commandEffect(id, args, panels);
        if (commands.has(id)) return commands.get(id)(...args);
      }
    },
    workspace: {
      onDidSaveTextDocument(listener) { saveDocumentListener = listener; return disposable(); },
      onDidCloseTextDocument(listener) { closeDocumentListener = listener; return disposable(); },
      registerTextDocumentContentProvider(scheme, provider) { documentProviders.set(scheme, provider); return { dispose() { documentProviders.delete(scheme); } }; },
      fs: { delete: async (uri, deleteOptions) => { deleteCalls.push({ uri, options: deleteOptions }); if (options.deleteError) throw new Error(options.deleteError); } },
      getConfiguration: () => ({ get: key => {
        if (!options.configurationScopes?.[key]) return options.configuration?.[key] ?? options.configurationDefaults?.[key];
        const { globalValue, workspaceValue } = options.configurationScopes[key];
        return globalValue && workspaceValue && !Array.isArray(globalValue) ? { ...globalValue, ...workspaceValue } : workspaceValue ?? globalValue;
      }, inspect: key => options.configurationScopes?.[key] || ({ defaultValue: options.configurationDefaults?.[key], workspaceValue: options.configuration?.[key] }), async update(key, value, target) { options.configuration ||= {}; options.configuration[key] = value; if (options.configurationScopes) { options.configurationScopes[key] ||= {}; options.configurationScopes[key][target === 1 ? 'globalValue' : 'workspaceValue'] = value; } updateCalls.push({ store: 'configuration', key, value, target }); } }),
      workspaceFolders: options.noWorkspace ? undefined : [{ uri: { ...uri(path.join(root, 'workspace')), scheme: options.workspaceScheme || 'file' } }],
      onDidChangeConfiguration(listener) { configurationListener = listener; return disposable(); },
      async openTextDocument(definition) {
        const document = { ...definition, uri: definition.fsPath ? definition : uri(`/untitled-${textDocuments.length + 1}`) };
        textDocuments.push(document); if (options.documentError) throw new Error(options.documentError); return document;
      }
    },
    window: {
      createOutputChannel: (name, config) => ({ info(message) { options.onInfoLog?.(message); }, error(message) { options.onLog?.(name, config, message); }, dispose() {} }),
      state: { focused: true },
      onDidChangeWindowState(listener) { windowStateListener = listener; return disposable(); },
      tabGroups: {
        all: tabGroups,
        onDidChangeTabs(listener) { tabListeners.add(listener); return { dispose: () => tabListeners.delete(listener) }; },
        onDidChangeTabGroups(listener) { groupListeners.add(listener); return { dispose: () => groupListeners.delete(listener) }; }
      },
      registerWebviewPanelSerializer(viewType, value) {
        assert.equal(viewType, 'bitfroestPrototype'); serializer = value; return disposable();
      },
      createStatusBarItem(alignment, priority) {
        status = { alignment, priority, shown: false, text: '', show() { this.shown = true; }, ...disposable() };
        return status;
      },
      createWebviewPanel(viewType, title, column, panelOptions) {
        const disposeListeners = [];
        let viewListener, messageListener, html = '';
        const panel = {
          viewType, title, viewColumn: 3, column, panelOptions, visible: true, disposed: false, reveals: 0, messages: [],
          reveal() { this.reveals++; this.visible = true; viewListener?.(); },
          dispose() { if (!this.disposed) { this.disposed = true; this.visible = false; for (const listener of disposeListeners) listener(); } },
          onDidDispose(listener) { disposeListeners.push(listener); return disposable(); },
          onDidChangeViewState(listener) { viewListener = listener; return disposable(); },
          changeVisibility(value) { this.visible = value; viewListener?.(); },
          receive(message) { return messageListener(message); },
          webview: {
            cspSource: 'webview-resource:', get html() { return html; }, set html(value) { html = value; options.onHtml?.(panel); },
            asWebviewUri: value => ({ toString: () => `webview-resource:${value.fsPath}` }),
            onDidReceiveMessage(listener) { messageListener = listener; return disposable(); },
            async postMessage(message) { panel.messages.push(message); return true; }
          }
        };
        tabGroups.push({ viewColumn: panel.viewColumn, tabs: [{ input: { viewType } }] });
        panels.push(panel); return panel;
      },
      async showErrorMessage(message) { errors.push(message); if (options.showErrorMessage) return options.showErrorMessage(message); },
      async showWarningMessage(message, ...items) { errors.push(message); return options.showWarningMessage?.(message, ...items); },
      async showInformationMessage(message) { information.push(message); },
      async showInputBox() { return options.inputResults?.shift(); },
      async showTextDocument(document, editorOptions) { textEditors.push({ document, options: editorOptions }); return {}; },
      async showQuickPick(items, pickOptions) {
        quickPicks.push({ items, options: pickOptions });
        const choice = choices.shift();
        return choice === undefined ? undefined : items.find(item => item.value === choice);
      }
    }
  };
  const native = titleToken => {
    nativeCalls.push({ operation: 'windows.maximize', titleToken });
    return new Promise((resolve, reject) => {
      const callback = error => error ? reject(error) : resolve({ maximized: true });
      if (options.native) options.native(callback);
      else callback(options.nativeError ? new Error(options.nativeError) : null);
    });
  };
  let themeCalls = 0;
  const icons = { roots: [uri(path.join(root, 'theme'))], associations: { base: { file: 'theme-icon-0' } }, css: () => '.theme-icon-0{color:red}' };
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === extensionPath) {
      if (request === 'vscode') return vscode;
      if (request === './git-file-actions') return { createGitFileActions: () => ({ prepare: async input => options.gitFilePrepare ? options.gitFilePrepare(input) : input, execute: async ticket => options.gitFileExecute?.(ticket), dispose() {} }) };
      if (request === './open-terminal') return { openTerminal: async target => { if (options.terminalOpen) return options.terminalOpen(target); throw new Error('Terminal unavailable'); } };
      if (request === './license-information' && options.licenseOpenError) return { createLicenseInformation: () => ({ dispose() {}, async open() { throw new Error(options.licenseOpenError); } }) };
      if (request === './network-paths') return { prepareNetworkDeletion: require('../network-paths').prepareNetworkDeletion,
        findNetworkPaths: paths => require('../network-paths').findNetworkPaths(paths, { resolvePaths: options.resolveUncPaths || (async paths => paths) }),
        resolveUncPaths: options.resolveUncPaths || (async paths => paths) };
      if (request === './lock-inspector') return { createLockInspector: () => ({ open: folder => options.lockInspectorOpen?.(folder), dispose() {} }) };
      if (request === './open-file') return { openAssociatedFile: async target => { openCalls.push(target); if (options.openError) throw new Error(options.openError); return { editor: Boolean(options.associatedEditor) }; } };
      if (request === './search-provider' && options.searchRoots) return { createSearchProvider: args => require('../search-provider').createSearchProvider({ ...args, roots: options.searchRoots }) };
      if (request === './icon-theme') return { loadIconTheme: async () => { themeCalls++; return options.theme ? options.theme(themeCalls, icons) : icons; } };
      if (request === './native-window') return { maximizeWindow: native, inspectWindows: async request => options.nativeInspect ? options.nativeInspect(request) : ({ version: 1, readOnly: true, windows: [], truncated: false }) };
      if (request === 'node:child_process') throw new Error('Window setup must use the native module.');
      if (request === './filesystem-icons') return { getFilesystemIcons: async requests => options.filesystemIcons ? options.filesystemIcons(requests) : {}, clearFilesystemIconCache: () => options.clearFilesystemIconCache?.() };
      if (request === './git-status-provider' && !options.realGitProvider) return { createGitStatusProvider: creation => ({
        inspect: async (directories, settings, onProgress) => options.gitInspect ? options.gitInspect(directories, settings, creation, onProgress) : {},
        branches: async directory => options.gitBranches ? options.gitBranches(directory) : { ok: true, count: 0, otherCount: 0 },
        dispose() { options.gitDispose?.(); }
      }) };
      if (request === './open-trash') return { openTrash: async () => { trashCalls.push('open'); if (options.trashOpen) return options.trashOpen(); if (options.trashError) throw new Error(options.trashError); return { requested: true }; } };
      if (request === './native-shell-menu') return { createShellMenuProvider: configuration => ({
        async show(paths, settings) { shellCalls.push({ paths, settings, configuration }); return options.shellMenuShow ? options.shellMenuShow(paths, settings) : { ok: true, displayed: true, invoked: false, cancelled: true }; },
        dispose() { shellDisposals.push(true); }
      }) };
      if (request === './readonly-files') return { createReadonlyResources: () => ({ async createUri(original) { if (options.readonlyError) throw new Error(options.readonlyError); readonlyPaths.push(original); return { scheme: 'bitfroest-conflict', path: `/snapshot-${readonlyPaths.length}/${path.posix.basename(original)}`, toString() { return `bitfroest-conflict:${this.path}`; } }; }, dispose() {} }) };
      if (request === './clipboard-provider') return { createClipboardProvider: options.clipboardFactory || (() => ({
        read: async () => { clipboardCalls.push({ action: 'read' }); return options.clipboardSelection || null; },
        write: async selection => { clipboardCalls.push({ action: 'write', selection }); if (options.clipboardError) throw new Error(options.clipboardError); return { ...selection, token: 'clip-1', source: 'system' }; },
        ack: async selection => { clipboardCalls.push({ action: 'ack', selection }); return true; },
        reset: async selection => { clipboardCalls.push({ action: 'reset', selection }); return true; }, dispose() {}
      })) };
      if (request === './startup-paths') return { selectStartupRoots: preferred => options.startupRoots || preferred, existingDirectories: directories => directories.filter(value => !options.missingDirectories?.includes(value)) };
      if (request === './filesystem-provider') return { createProvider: creation => { providerOptions = creation; return options.providerFactory ? options.providerFactory(creation) : ({
        load: async optionsForLoad => options.filesystemLoad ? options.filesystemLoad(optionsForLoad) : null,
        prepare: async (before, preparation) => options.filesystemPrepare ? options.filesystemPrepare(before, preparation) : before,
        measureFolder: async (before, directory, settings) => options.measureFolder(before, directory, settings),
        apply: async (before, after, operation) => options.filesystemApply ? options.filesystemApply(before, after, operation) : after,
        remove: async (before, request) => options.filesystemRemove ? options.filesystemRemove(before, request, providerOptions) : before,
        contains: target => options.containsPath ? options.containsPath(target) : /^C:\/(tmp|temp)(\/|$)/i.test(target)
      }); } };
    }
    return load.call(this, request, parent, isMain);
  };
  let extension;
  try {
    delete require.cache[extensionPath];
    extension = require(extensionPath);
  } finally { Module._load = load; }
  t.after(() => { Object.defineProperty(process, 'platform', originalPlatform); delete require.cache[extensionPath]; });
  extension.activate(context);
  return {
    context, commands, calls, panels, errors, information, contexts, textDocuments, textEditors, quickPicks, nativeCalls, updateCalls, deleteCalls, clipboardCalls, readonlyPaths, trashCalls, shellCalls, shellDisposals, openCalls, documentProviders,
    get status() { return status; },
    deactivate: () => extension.deactivate(),
    env: vscode.env,
    get serializer() { return serializer; },
    restore: (...args) => { serializer.deserializeWebviewPanel(...args); return vscode.commands.executeCommand('bitfroest.show'); },
    tabGroups,
    tabsChanged: () => { for (const listener of tabListeners) listener({}); },
    groupsChanged: () => { for (const listener of groupListeners) listener({}); },
    restoredPanel: () => vscode.window.createWebviewPanel('bitfroestPrototype', 'Restored', 3, {}),
    get providerOptions() { return providerOptions; },
    command: async (id, ...args) => { const result = await vscode.commands.executeCommand(id, ...args); if (['bitfroest.openPrototype', 'bitfroest.show'].includes(id) && !options.manualReadiness && panels.at(-1) && !panels.at(-1).disposed) await panels.at(-1).receive({ type: 'app-ready' }); return result; },
    configuration: affects => configurationListener({ affectsConfiguration: key => Array.isArray(affects) ? affects.includes(key) : key === affects }),
    saveDocument: document => saveDocumentListener(document),
    closeDocument: document => closeDocumentListener(document),
    windowFocus: focused => windowStateListener({ focused })
  };
}

test('ZIP host opens metadata and copies selection through the generated host protocol', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'), target = path.join(root, 'out').replaceAll('\\', '/');
  fs.mkdirSync(target); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'hello' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'archive', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(result?.ok, true); assert.ok(result.resumeNavigation.path.startsWith('zip:'));
  const sourcePath = result.resumeNavigation.path;
  await panel.receive({ type: 'zip-copy', path: sourcePath, ids: [result.state.folders[sourcePath][0].id], target, operationId: 'zip-host-copy', state: result.state });
  assert.equal(panel.messages.filter(message => message.type === 'filesystem-result').at(-1).ok, true, JSON.stringify(panel.messages.at(-1)));
  assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'hello');
  assert.equal(panel.messages.filter(message => message.type === 'filesystem-result').at(-1).ok, true);
});

test('ZIP pack host confirms an existing normalized target through a native choice', async t => {
  for (const choice of ['update', 'cancel']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-existing-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'file.txt').replaceAll('\\', '/'), archive = path.join(root, 'result.zip').replaceAll('\\', '/');
    fs.writeFileSync(source, 'new'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'keep.txt': 'keep' }));
    const before = fs.readFileSync(archive), initial = clipboardFixture();
    initial.folders['C:/tmp'] = [{ id: 'file', name: 'file.txt', type: 'text', fsSource: source }];
    const app = harness(t, { choices: [choice], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['file'], archive: archive.slice(0, -4), operationId: 'zip-existing', state: initial });
    const pick = app.quickPicks.at(-1); assert.ok(pick);
    assert.equal(pick.options.title, 'Archiv bereits vorhanden');
    assert.equal(pick.options.placeHolder.replaceAll('\\', '/'), archive);
    assert.deepEqual(pick.items.map(item => item.value), ['update', 'cancel']);
    const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
    assert.equal(result.ok, true);
    if (choice === 'cancel') { assert.equal(result.cancelled, true); assert.deepEqual(fs.readFileSync(archive), before); }
    else {
      const z = require('@zip.js/zip.js'), reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive)));
      assert.deepEqual((await reader.getEntries()).map(entry => entry.filename).sort(), ['file.txt', 'keep.txt']); await reader.close();
    }
    assert.equal(fs.readFileSync(source, 'utf8'), 'new');
    assert.equal(fs.existsSync(archive.slice(0, -4)), false); panel.dispose();
  }
});

test('ZIP host bounds intermediate progress, forwards phase changes and flushes the latest file before completion', async t => {
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem;
  let report;
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), writeArchive: async (_state, _request, settings) => {
    report = settings.onProgress;
    for (const phase of ['packing', 'verifying']) for (let n = 0; n < 1000; n++) report(progressSample({ phase, overallScope: 'phase', currentPath: `${n}.txt`, completedBytes: n, totalBytes: 2000 }));
  } });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const initial = clipboardFixture();
  for (const pane of initial.panes) Object.assign(pane, { filter: '', sort: 'name' });
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt')); view.action('pack');
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = view.messages.find(message => message.type === 'zip-write'); assert.ok(request);
  await panel.receive(request);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const messages = panel.messages.filter(message => message.type === 'filesystem-progress');
  assert.ok(messages.length <= 6, `unbounded ZIP progress messages: ${messages.length}`);
  assert.equal(messages[0].progress.phase, 'packing');
  assert.ok(messages.some(message => message.progress.phase === 'verifying' && message.progress.currentPath === '0.txt'));
  assert.equal(messages.at(-1).progress.currentPath, '999.txt');
  const refreshed = panel.messages.find(message => message.type === 'filesystem-result').refreshGitDirectories;
  assert.equal(refreshed?.length, 1);
  assert.ok(request.archive.startsWith(refreshed[0] + '/'));
  for (const message of messages) {
    assert.equal(message.progress.overallScope, 'phase');
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
    assert.equal(view.document.querySelector('#status-progress-overall').style.width, '0%');
    assert.equal(view.document.querySelector('#status-progress-overall').hasAttribute('aria-valuenow'), false);
  }
  assert.equal(view.document.querySelector('#status-message').textContent, 'Archiv prüfen · 999.txt');
  const lastProgress = panel.messages.lastIndexOf(messages.at(-1));
  assert.ok(panel.messages.findIndex((message, index) => index > lastProgress && message.type === 'filesystem-result' && message.ok) > lastProgress, JSON.stringify(panel.messages.at(-1)));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.find(message => message.type === 'filesystem-result' && message.operationId === request.operationId) }));
  assert.equal(view.document.querySelector('#statusbar').dataset.statusProgressOwner, 'background');
  const count = panel.messages.length; report({ phase: 'packing', currentPath: 'late.txt' });
  assert.equal(panel.messages.length, count);
});

test('read-only archive verification does not reread directory views', async t => {
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem;
  let verified = 0, loads = 0;
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), testArchives: async () => { verified++; return []; } });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const initial = clipboardFixture(), app = harness(t, { filesystemLoad: async () => { loads++; return structuredClone(initial); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'zip-test', sourcePath: 'C:/tmp', ids: ['a'], operationId: 'read-only-archive-test', state: initial });
  assert.equal(verified, 1); assert.equal(loads, 1);
  assert.equal(panel.messages.at(-1).ok, true); panel.dispose();
});

test('ZIP write host requests a native password and confirmation without sending it to the webview', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-write-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'file.txt').replaceAll('\\', '/'), archive = path.join(root, 'created.zip').replaceAll('\\', '/'); fs.writeFileSync(source, 'secret');
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'file', name: 'file.txt', type: 'text', fsSource: source }];
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value), inputResults: ['private-password', 'private-password'] });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['file'], archive, encryption: 'aes256', operationId: 'zip-write-host', state: initial });
  const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(result?.ok, true, JSON.stringify(result)); assert.equal(JSON.stringify(panel.messages).includes('private-password'), false);
  const z = require('@zip.js/zip.js'), reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive)));
  const entries = await reader.getEntries(); assert.equal(entries[0].encrypted, true);
  assert.equal(await entries[0].getData(new z.TextWriter(), { password: 'private-password', useWebWorkers: false }), 'secret'); await reader.close();
});

test('ZIP host distinguishes a committed archive from cancellation of its optional post-pack test', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-committed-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'), source = path.join(root, 'new.txt').replaceAll('\\', '/'); fs.writeFileSync(source, 'new');
  const z = require('@zip.js/zip.js'), writer = new z.ZipWriter(new z.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('secret.txt', new z.TextReader('secret'), { password: 'secret-password', encryptionStrength: 3 }); fs.writeFileSync(archive, await writer.close());
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'file', name: 'new.txt', type: 'text', fsSource: source }];
  const app = harness(t, { choices: ['update'], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['file'], archive, operationId: 'zip-post-test', state: initial });
  const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(result.cancelled, true); assert.equal(result.archiveCommitted, true); assert.match(result.notice, /ZIP wurde gespeichert/);
  const reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive))); assert.equal((await reader.getEntries()).length, 2); await reader.close();
});

test('ZIP browsing F3 materializes only the selected entry through the common provider', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-view-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'chosen.txt': 'chosen content', 'other.txt': 'other' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { choices: ['view'], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), ref = opened.state.folders[opened.resumeNavigation.path].find(row => row.name === 'chosen.txt');
  const request = { type: 'lister-open', path: ref.fsSource, side: 0, requestId: 'lister-1900' }; await panel.receive(request);
  assert.equal(panel.messages.at(-1).type, 'lister-result');
  assert.equal(panel.messages.at(-1).ok, true, JSON.stringify(panel.messages.at(-1)));
  assert.equal(app.quickPicks.length, 1);
  const result = panel.messages.at(-1); assert.equal(fs.existsSync(request.path), true);
  await panel.receive({ type: 'lister-close', id: result.id }); assert.equal(fs.existsSync(request.path), false);
  panel.dispose(); await tick();
});

test('ZIP browsing F4 uses native editor save and close events for confirmed repacking', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-edit-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'chosen.txt': 'original', 'other.txt': 'other' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { choices: ['repack', 'repack'], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), reference = opened.state.folders[opened.resumeNavigation.path].find(row => row.name === 'chosen.txt');
  await panel.receive({ type: 'edit', path: reference.fsSource });
  assert.equal(app.textDocuments.length, 1); const document = app.textDocuments[0], target = document.uri.fsPath;
  assert.equal(fs.readFileSync(target, 'utf8'), 'original'); fs.writeFileSync(target, 'edited'); await app.saveDocument(document);
  const z = require('@zip.js/zip.js'), reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive)));
  const entries = await reader.getEntries(); assert.equal(await entries.find(entry => entry.filename === 'chosen.txt').getData(new z.TextWriter(), { useWebWorkers: false }), 'edited'); await reader.close();
  fs.writeFileSync(target, 'edited again'); await app.saveDocument(document);
  assert.equal(app.errors.length, 0);
  await app.closeDocument(document); assert.equal(fs.existsSync(target), false);
});

test('ZIP browsing F4 cleans the plaintext working copy when native editor opening fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-edit-fail-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'content' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { documentError: 'Editor failed', filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), reference = opened.state.folders[opened.resumeNavigation.path][0];
  await panel.receive({ type: 'edit', path: reference.fsSource });
  assert.equal(app.textDocuments.length, 1); assert.equal(fs.existsSync(app.textDocuments[0].uri.fsPath), false); assert.ok(app.errors.includes('Editor failed'));
});

test('ZIP explicit open honors a VS Code file association and retains editor writeback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-associated-editor-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'content' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { associatedEditor: true, filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), reference = opened.state.folders[opened.resumeNavigation.path][0];
  await panel.receive({ type: 'zip-open-entry', path: reference.fsSource });
  assert.equal(app.textDocuments.length, 1); assert.equal(app.openCalls[0], app.textDocuments[0].uri.fsPath);
  await app.closeDocument(app.textDocuments[0]); assert.equal(fs.existsSync(app.openCalls[0]), false);
});

test('main menu settings in generated host HTML open the searchable settings dialog', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.click(view.document.querySelector('[data-menu-group="Konfigurieren"]'));
  view.click(view.document.querySelector('[data-menu-action="settings"]'));
  const request = view.messages.find(message => message.type === 'configure-settings');
  assert.ok(request);
  await panel.receive(request);
  const settings = app.panels.at(-1); assert.notEqual(settings, panel);
  await settings.receive({ type: 'configuration-ready' });
  assert.equal(settings.messages.at(-1).section, 'settings');
  assert.ok(settings.messages.at(-1).settings.some(item => item.key === 'bitfroest.shortcuts.bindings'));
  panel.dispose();
});

test('Help links in generated host HTML open fixed product destinations', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  const targets = {
    marketplace: 'https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype',
    github: 'https://github.com/s-a/Bitfroest.fs',
    documentation: 'https://github.com/s-a/Bitfroest.fs#readme',
    'developer-documentation': 'https://github.com/s-a/Bitfroest.fs/blob/main/DEVELOPMENT.md',
    issue: 'https://github.com/s-a/Bitfroest.fs/issues/new'
  };
  for (const [id, url] of Object.entries(targets)) {
    const help = [...view.document.querySelectorAll('[data-main-menu] > button')].at(-1);
    view.click(help); view.click(view.document.querySelector(`[data-menu-action="help-link:${id}"]`));
    const request = view.messages.findLast(message => message.type === 'open-help-link');
    assert.ok(request);
    await panel.receive({ ...request, href: 'https://example.invalid/ignored' });
    assert.equal(app.calls.filter(call => call.id === 'openExternal').at(-1).args[0], url);
    const result = panel.messages.findLast(message => message.type === 'ui-action-result' && message.requestId === request.requestId);
    assert.equal(result.ok, true);
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
    assert.equal(view.document.querySelector('#status-message').dataset.outcome, 'success');
  }
  const count = app.calls.filter(call => call.id === 'openExternal').length;
  for (const id of ['unknown', '__proto__', 'constructor']) await panel.receive({ type: 'open-help-link', id, requestId: 'ui-action-99' });
  assert.equal(app.calls.filter(call => call.id === 'openExternal').length, count);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('Help link requests wait for readiness and report refused or failed opening', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'open-help-link', id: 'github', requestId: 'ui-action-1' });
  assert.equal(app.calls.some(call => call.id === 'openExternal'), false);
  await panel.receive({ type: 'app-ready' });
  app.env.openExternal = async () => false;
  await panel.receive({ type: 'open-help-link', id: 'github', requestId: 'ui-action-2' });
  assert.equal(panel.messages.findLast(message => message.requestId === 'ui-action-2').ok, false);
  app.env.openExternal = async () => { throw new Error('Browser unavailable'); };
  await panel.receive({ type: 'open-help-link', id: 'github', requestId: 'ui-action-3' });
  const result = panel.messages.findLast(message => message.requestId === 'ui-action-3');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Browser unavailable');
});

test('failed license opening reports the actual failure instead of a green command dispatch', async t => {
  const app = harness(t, { licenseOpenError: 'Credits unavailable' });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.action('licenses'); const request = view.messages.find(message => message.type === 'show-licenses');
  await panel.receive(request);
  const result = panel.messages.find(message => message.type === 'ui-action-result' && message.requestId === request.requestId); assert.ok(result);
  assert.equal(result.ok, false);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.equal(view.document.querySelector('#status-message').dataset.outcome, 'error');
});

test('licenses command and Help in generated host HTML open the same readonly credits', async t => {
  const app = harness(t);
  assert.ok(app.commands.has('bitfroest.licenses'));
  await app.command('bitfroest.licenses');
  const first = app.calls.find(call => call.id === 'markdown.showPreview');
  assert.match(first.args[0].toString(), /^bitfroest-licenses:\/de\/licenses\.md$/);
  const content = app.documentProviders.get('bitfroest-licenses').provideTextDocumentContent(first.args[0]);
  assert.match(content, /Stephan Ahlf/);
  assert.match(content, /Apache-2\.0/);
  assert.equal(app.panels.length, 0);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], calls = app.calls.length;
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  const help = [...view.document.querySelectorAll('[data-main-menu] > button')].at(-1);
  view.click(help); view.key('ArrowUp', {}, view.document.activeElement);
  assert.equal(view.document.activeElement.dataset.menuAction, 'licenses');
  view.key('Enter', {}, view.document.activeElement);
  const request = view.messages.find(message => message.type === 'show-licenses');
  assert.ok(request);
  await panel.receive(request);
  const preview = app.calls.slice(calls).filter(call => call.id === 'markdown.showPreview');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].args[0].toString(), first.args[0].toString());
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.equal(app.deleteCalls.length, 0);
  assert.deepEqual(app.errors, []);
});

test('license requests wait for host readiness and ignore caller-supplied document paths', async t => {
  const app = harness(t, { language: 'en', manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'show-licenses', path: 'file:///other-document.md' });
  assert.equal(app.calls.some(call => call.id === 'markdown.showPreview'), false);
  await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'show-licenses', path: 'file:///other-document.md' });
  const uri = app.calls.find(call => call.id === 'markdown.showPreview').args[0];
  assert.equal(uri.toString(), 'bitfroest-licenses:/en/licenses.md');
  assert.match(app.documentProviders.get('bitfroest-licenses').provideTextDocumentContent(uri), /Licenses and acknowledgements/);
  assert.equal(app.textDocuments.length, 0);
  assert.deepEqual(app.errors, []);
});

test('native license preview failure opens a text fallback without creating a file manager', async t => {
  const app = harness(t, { commandError: 'markdown.showPreview' });
  await app.command('bitfroest.licenses');
  assert.equal(app.textDocuments.length, 1);
  assert.equal(app.textEditors.length, 1);
  assert.equal(app.textEditors[0].options.preview, false);
  assert.equal(app.panels.length, 0);
  assert.deepEqual(app.errors, []);
});

test('file search host uses isolated jobs, trusted results and generated HTML with CSP', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'found.txt').replaceAll('\\', '/'); fs.writeFileSync(file, 'needle');
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [];
  const app = harness(t, { filesystemLoad: async () => initial, containsPath: target => target === file || target === root.replaceAll('\\', '/') });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*file-search-view.js"/);
  await app.command('bitfroest.search'); assert.equal(panel.messages.at(-1).action, 'search');
  await panel.receive({ type: 'inputFocus', dialog: true, search: true, value: true }); assert.equal(app.contexts.get('bitfroest.searchFocus'), true);
  await panel.receive({ type: 'search-preset-save', name: 'Text', settings: { searchIn: '>', name: '*.txt' } });
  assert.equal(app.context.globalState.get('searchPresets').Text.name, '*.txt');
  await panel.receive({ type: 'search-copy', searchId: 'missing', results: [{ fsSource: file }] });
  assert.equal(app.clipboardCalls.length, 0);
  panel.dispose(); assert.equal(app.contexts.get('bitfroest.searchFocus'), false);
});

test('file search persistence loads parents of deep results and serializes global template writes', async t => {
  const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'search-persistence-')).replaceAll('\\', '/'); t.after(() => fs.rmSync(resultRoot, { recursive: true, force: true }));
  const state = clipboardFixture(); state.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [resultRoot + '/a.txt'] } }];
  const loaded = [], gate = deferred(); let writes = 0;
  const app = harness(t, { containsPath: () => true, workspaceState: { fileManagerState: state }, filesystemLoad: async settings => { loaded.push(settings); return state; }, update: async (store, key) => { if (store === 'global' && key === 'searchPresets' && ++writes === 1) await gate.promise; } });
  await app.command('bitfroest.openPrototype'); assert.ok(loaded[0].directories.includes(resultRoot));
  const panel = app.panels[0];
  const first = panel.receive({ type: 'search-preset-save', name: 'One', settings: { name: '*.txt' } });
  const second = panel.receive({ type: 'search-preset-save', name: 'Two', settings: { name: '*.md' } });
  gate.resolve(); await Promise.all([first, second]); assert.deepEqual(Object.keys(app.context.globalState.get('searchPresets')).sort(), ['One', 'Two']);
});

test('file search integrates real nested files with host HTML, apply, result tabs and copy operations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-integration-')).replaceAll('\\', '/'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = root + '/left', right = root + '/right'; fs.mkdirSync(left); fs.mkdirSync(right); fs.mkdirSync(left + '/deep');
  fs.writeFileSync(left + '/one.txt', 'one'); fs.writeFileSync(left + '/deep/two.txt', 'two');
  const provider = require('../filesystem-provider').createProvider({ roots: [left, right] });
  const app = harness(t, { searchRoots: [left, right], containsPath: value => provider.contains(value), filesystemLoad: settings => provider.load(settings), filesystemPrepare: (before, settings) => provider.prepare(before, settings), filesystemApply: (before, after, operation) => provider.apply(before, after, operation) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.key('F7', { altKey: true }); view.document.querySelector('[data-file-search] [name=name]').value = '*.txt'; view.key('s', { altKey: true });
  await panel.receive(view.messages.find(m => m.type === 'search-start'));
  const complete = panel.messages.find(m => m.type === 'search-complete'); assert.equal(complete.results.length, 2);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: complete })); view.key('w', { altKey: true });
  await panel.receive(view.messages.find(m => m.type === 'search-apply'));
  const applied = panel.messages.find(m => m.type === 'search-applied'); assert.equal(applied.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: applied }));
  assert.equal(view.state().panes[0].tabs.length, 2); assert.ok(view.row('two.txt')); assert.ok(view.row('one.txt'));
  const resultTab = view.state().panes[0].tabStates[1].id;
  view.click(view.row('two.txt')); view.row('two.txt').dispatchEvent(new view.window.MouseEvent('dblclick', { bubbles: true }));
  await panel.receive(view.messages.filter(message => message.type === 'open').at(-1));
  view.window.dispatchEvent(new view.window.Event('blur')); view.window.dispatchEvent(new view.window.Event('focus'));
  assert.equal(view.messages.filter(message => message.type === 'filesystem-refresh').length, 0, 'browser focus alone does not represent a host window transition');
  const focusStart = panel.messages.length;
  app.windowFocus(false); app.windowFocus(true); app.windowFocus(true);
  const focusMessages = panel.messages.slice(focusStart).filter(message => message.type === 'window-focus');
  assert.equal(focusMessages.length, 1, 'one host window return produces one focus message');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: focusMessages[0] }));
  assert.equal(view.messages.filter(message => message.type === 'filesystem-refresh').length, 1);
  const refresh = view.messages.filter(message => message.type === 'filesystem-refresh').at(-1); assert.ok(refresh);
  await panel.receive(refresh);
  const refreshed = panel.messages.filter(message => message.type === 'filesystem-result').at(-1); assert.equal(refreshed.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: refreshed }));
  assert.equal(view.state().panes[0].tabStates[1].id, resultTab); assert.equal(view.state().panes[0].tabStates[1].searchResult.id, complete.searchId); assert.ok(view.row('two.txt')); assert.ok(view.row('one.txt'));
  view.action('select-all'); view.action('copy'); view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  let processed = 0, replies = panel.messages.length;
  for (let count = 0; count < 100 && (!fs.existsSync(right + '/one.txt') || !fs.existsSync(right + '/two.txt')); count++) {
    while (processed < view.messages.length) { const message = view.messages[processed++]; if (['filesystem-apply', 'filesystem-prepare', 'state'].includes(message.type)) await panel.receive(message); }
    for (const message of panel.messages.slice(replies)) view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
    replies = panel.messages.length;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(right + '/one.txt'), JSON.stringify({ errors: app.errors, messages: panel.messages.filter(m => m.type.startsWith('filesystem')).map(m => ({ type: m.type, ok: m.ok, error: m.error })), sent: view.messages.slice(-8).map(m => m.type), dialog: view.document.querySelector('#modal-title').textContent }));
  assert.equal(fs.readFileSync(right + '/one.txt', 'utf8'), 'one'); assert.equal(fs.readFileSync(right + '/two.txt', 'utf8'), 'two');
  assert.equal(fs.readFileSync(left + '/deep/two.txt', 'utf8'), 'two'); panel.dispose();
});

test('file search preserves single-archive entries on apply and materializes only the selected entry for Lister', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-zip-')).replaceAll('\\', '/'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = root + '/left', right = root + '/right'; fs.mkdirSync(left); fs.mkdirSync(right);
  fs.writeFileSync(left + '/data.zip', require('./support/search-archives.cjs').zip({ 'inside.txt': 'hello needle' }));
  const provider = require('../filesystem-provider').createProvider({ roots: [left, right] });
  const app = harness(t, { searchRoots: [left, right], containsPath: value => provider.contains(value), filesystemLoad: settings => provider.load(settings), filesystemPrepare: (before, settings) => provider.prepare(before, settings) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], id = 'search-1234567890abcdef-1';
  await panel.receive({ type: 'search-start', searchId: id, settings: { name: '*.txt', searchIn: left, archives: true } });
  const complete = panel.messages.find(m => m.type === 'search-complete'); assert.equal(complete.results[0].entry, 'inside.txt');
  await panel.receive({ type: 'search-apply', searchId: id }); const applied = panel.messages.find(m => m.type === 'search-applied');
  assert.equal(applied.results[0].entry, 'inside.txt');
  await panel.receive({ type: 'lister-open', requestId: 'lister-321', side: 0, path: complete.results[0].fsSource });
  const opened = panel.messages.find(m => m.requestId === 'lister-321'); assert.equal(opened.ok, true); assert.equal(opened.view.text, 'hello needle');
  await panel.receive({ type: 'lister-edit', requestId: 'lister-322', id: opened.id });
  assert.equal(app.textDocuments.length, 0); assert.match(panel.messages.find(message => message.requestId === 'lister-322').error, /Archivtreffer|archive/i);
  await panel.receive({ type: 'edit', path: complete.results[0].fsSource }); assert.equal(app.textDocuments.length, 0);
  fs.writeFileSync(left + '/data.zip', require('./support/search-archives.cjs').zip({ 'inside.txt': 'replacement content' }));
  await panel.receive({ type: 'lister-open', requestId: 'lister-323', side: 0, path: complete.results[0].fsSource });
  const stale = panel.messages.find(message => message.requestId === 'lister-323'); assert.equal(stale.ok, false); assert.match(stale.error, /geändert/);
  panel.dispose();
});

test('fixed settings reach generated host HTML and replace columns without losing legacy compatibility', async t => {
  const app = harness(t, { configuration: { 'columns.visible.path': true, 'columns.width.path': 320 } });
  await app.command('bitfroest.openPrototype');
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html });
  assert.ok(view.document.querySelector('[role="columnheader"][data-column="path"]'));
  assert.ok(view.grid().getColumn('path'));
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(item => item.properties));
  assert.equal(properties['bitfroest.columns.visible.path'].type, 'boolean');
  assert.doesNotMatch(manifest.contributes.menus['webview/context'].find(item => item.command === 'bitfroest.configureColumns').when, /bitfroest.ready/);
});

test('favorite settings initialize the real HTML, broadcast changes and open their native settings area', async t => {
  const app = harness(t, { configuration: { 'favorites.entries': { Work: 'C:/tmp' } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.click(view.document.querySelector('[data-favorites]'));
  assert.equal(view.document.querySelector('[data-favorite-entry]').textContent, 'Work');
  await panel.receive({ type: 'configure-favorites' });
  assert.equal(app.panels[1].viewType, 'bitfroestConfiguration');
  await app.panels[1].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[1].messages.at(-1).section, 'favorites');
  await app.configuration('bitfroest.favorites');
  assert.equal(panel.messages.at(-1).type, 'favorite-settings');
});

test('startup fallback roots reach the provider while saved tabs remain navigable', async t => {
  const home = os.homedir().replaceAll('\\', '/');
  const initial = clipboardFixture();
  let loaded;
  const app = harness(t, { startupRoots: [home], workspaceState: { fileManagerState: initial }, filesystemLoad: async settings => { loaded = settings; return initial; } });
  await app.command('bitfroest.openPrototype');
  assert.deepEqual(app.providerOptions.roots, [home]);
  assert.ok(loaded.directories.includes('C:/tmp'));
  assert.equal(app.panels.length, 1);
  assert.deepEqual(app.errors, []);
});

test('missing persisted tabs cannot prevent startup in the fallback directory', async t => {
  const initial = clipboardFixture();
  const app = harness(t, { startupRoots: ['C:/Users/example'], missingDirectories: ['C:/tmp'], workspaceState: { fileManagerState: initial }, filesystemLoad: async settings => {
    assert.equal(settings.directories.includes('C:/tmp'), false);
    return initial;
  } });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 1);
  assert.deepEqual(app.errors, []);
});

test('removing a missing earlier tab retains the active saved path and its tab state', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => Object.assign(pane, { filter: '', sort: 'name' }));
  const saved = structuredClone(initial);
  saved.panes[0] = { ...saved.panes[0], tabs: ['C:/missing', 'C:/tmp', 'C:/temp'], tab: 1, tabStates: [
    { id: 'missing', path: 'C:/missing' }, { id: 'active', path: 'C:/tmp', filter: 'saved filter' }, { id: 'other', path: 'C:/temp' }
  ] };
  const app = harness(t, { missingDirectories: ['C:/missing'], workspaceState: { fileManagerState: saved }, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html });
  const pane = view.state().panes[0];
  assert.equal(pane.tabs[pane.tab], 'C:/tmp');
  assert.equal(pane.tabStates[pane.tab].id, 'active');
  assert.equal(pane.tabStates[pane.tab].filter, 'saved filter');
});

test('configured favorites extend the provider while legacy opposite targets are ignored', t => {
  const configuration = { 'favorites.entries': { Work: 'C:/git' }, 'favorites.targets': { Work: 'A:/Media' } };
  const app = harness(t, { configuration });
  assert.deepEqual(app.providerOptions.roots, ['C:/tmp', 'C:/temp']);
  assert.deepEqual(app.providerOptions.additionalRoots(), ['C:/git']);
  configuration['favorites.entries'] = { Work: 'D:/Work' };
  assert.deepEqual(app.providerOptions.additionalRoots(), ['D:/Work']);
});

test('configuration editor saves trees and layout into the chosen scope and broadcasts the resulting panel state', async t => {
  const app = harness(t, { configurationScopes: {} });
  await app.command('bitfroest.openPrototype'); const main = app.panels[0];
  await app.command('bitfroest.configureFavorites'); const editor = app.panels[1];
  await editor.receive({ type: 'configuration-ready' });
  const initial = editor.messages.at(-1);
  initial.data.favorites = [{ id: 'root', type: 'group', parent: null, name: 'Projects' }, { id: 'work', type: 'favorite', parent: 'root', name: 'Work', path: 'C:/git', target: '' }];
  initial.data.columns.find(item => item.id === 'path').visible = true;
  await editor.receive({ type: 'configuration-save', scope: 'user', revision: initial.revision, data: initial.data });
  assert.ok(app.updateCalls.some(call => call.key === 'favorites.items' && call.target === 1));
  assert.ok(app.updateCalls.some(call => call.key === 'columns.layout' && call.target === 1));
  const favorites = main.messages.filter(item => item.type === 'favorite-settings').at(-1).settings;
  assert.equal(favorites.entries.work, 'C:/git'); assert.equal(favorites.groups.work, 'Projects');
  assert.equal(main.messages.filter(item => item.type === 'column-settings').at(-1).settings.sets[0].columns.find(item => item.id === 'path').visible, true);
});

test('cancelled favorite input returns through the real host refresh protocol without replacing lists', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let loads = 0;
  const app = harness(t, { inputResults: [undefined], manualReadiness: true, filesystemLoad: async () => ({ ...structuredClone(initial), snapshotId: `load-${++loads}` }) });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const policy = view.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(policy, /script-src 'nonce-/);
  assert.doesNotMatch(policy, /unsafe-inline/);
  await panel.receive(view.messages.find(message => message.type === 'app-ready'));
  const lists = [...view.document.querySelectorAll('.list')];
  const row = view.row('a.txt');
  view.click(view.document.querySelector('[data-favorites]'));
  view.click(view.document.querySelector('[data-favorite-toggle]'));
  view.window.dispatchEvent(new view.window.Event('blur'));
  await panel.receive(view.messages.find(message => message.type === 'favorite-toggle'));
  assert.equal(app.updateCalls.length, 0);
  view.click(row);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'window-focus' } }));
  const request = view.messages.find(message => message.type === 'filesystem-refresh');
  assert.ok(request);
  await panel.receive(request);
  const response = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(response.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
  lists.forEach((list, side) => assert.equal(view.document.querySelectorAll('.list')[side], list));
  assert.equal(view.row('a.txt'), row);
  assert.equal(view.document.activeElement, lists[0]);
  assert.equal(view.document.querySelector('#panes').inert, false);
  assert.equal(view.state().snapshotId, response.state.snapshotId);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('favorite menu adds a named directory, cancels without writing and removes only matching entries', async t => {
  const app = harness(t, { inputResults: [undefined, 'Work'], configurationScopes: { 'favorites.entries': { globalValue: { Other: 'C:/temp' } } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'favorite-toggle', path: 'C:/tmp' });
  assert.equal(app.updateCalls.filter(call => call.key === 'favorites.items').length, 0);
  await panel.receive({ type: 'favorite-toggle', path: 'C:/tmp' });
  const added = app.updateCalls.find(call => call.key === 'favorites.items');
  assert.deepEqual(added.value.map(item => [item.name, item.path]), [['Other', 'C:/temp'], ['Work', 'C:/tmp']]);
  assert.equal(added.target, 1);
  await panel.receive({ type: 'favorite-toggle', path: 'c:\\tmp\\' });
  assert.deepEqual(app.updateCalls.filter(call => call.key === 'favorites.items').at(-1).value.map(item => [item.name, item.path]), [['Other', 'C:/temp']]);
});

test('favorite writes preserve configuration scopes and removal uses the owning scope', async t => {
  const app = harness(t, { inputResults: ['New'], configurationScopes: {
    'favorites.entries': { globalValue: { Personal: 'C:/personal' }, workspaceValue: { Team: 'C:/team' } }
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'favorite-toggle', path: 'C:/new' });
  const added = app.updateCalls.find(call => call.key === 'favorites.items');
  assert.deepEqual(added.value.map(item => [item.name, item.path]), [['Personal', 'C:/personal'], ['New', 'C:/new']]);
  assert.equal(added.target, 1);
  await panel.receive({ type: 'favorite-toggle', path: 'C:/team' });
  const removed = app.updateCalls.filter(call => call.key === 'favorites.items').at(-1);
  assert.equal(removed.target, 2);
  assert.deepEqual(removed.value, []);
});

test('lister host protocol opens only known files, renders generated HTML, copies matches and closes on Escape', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lister-host-'));
  const original = path.join(directory, 'sample.txt').replace(/\\/g, '/');
  fs.writeFileSync(original, 'first\r\nneedle\r\nlast\r\n');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = clipboardFixture();
  for (const p of state.panes) Object.assign(p, { filter: '', sort: 'name', descending: false });
  state.folders['C:/tmp'][0] = { id: 'a', name: 'sample.txt', type: 'text', fsSource: original, size: fs.statSync(original).size };
  state.panes[0].cursor = 'a'; state.panes[0].selected = ['a'];
  const app = harness(t, { filesystemLoad: async () => state, containsPath: candidate => candidate.startsWith(directory.replace(/\\/g, '/') + '/') });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.key('F3');
  const request = view.messages.find(message => message.type === 'lister-open');
  await panel.receive(request);
  const opened = panel.messages.find(message => message.requestId === request.requestId);
  assert.equal(opened?.ok, true);
  assert.equal(opened.view.text, 'first\nneedle\nlast\n');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: opened }));
  assert.match(view.document.querySelector('[data-lister] textarea').value, /needle/);
  await panel.receive({ type: 'lister-search', requestId: 'lister-900', id: opened.id, settings: { text: 'needle', position: 0, encoding: 'utf-8' } });
  assert.deepEqual(panel.messages.at(-1).match, { start: 7, end: 13 });
  await panel.receive({ type: 'lister-copy', requestId: 'lister-901', id: opened.id, settings: { start: 7, end: 13, encoding: 'utf-8' } });
  assert.ok(app.clipboardCalls.some(call => call.action === 'writeText' && call.text === 'needle'));
  assert.equal(app.textDocuments.length, 0);
  assert.equal(app.calls.some(call => call.id === 'markdown.showPreview'), false);
  view.key('Escape');
  await panel.receive(view.messages.filter(message => message.type === 'lister-close').at(-1));
  await panel.receive({ type: 'lister-read', requestId: 'lister-902', id: opened.id, settings: {} });
  assert.equal(panel.messages.at(-1).ok, false);
  await panel.receive({ type: 'lister-open', requestId: 'lister-903', side: 0, path: `${original}.missing` });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.ok(view.document.activeElement.matches('.list'));
  fs.writeFileSync(path.join(directory, 'next.txt'), 'linked\nfile\n');
  await panel.receive({ type: 'lister-open', requestId: 'lister-904', side: 0, path: original });
  const reopened = panel.messages.at(-1);
  await panel.receive({ type: 'lister-link', requestId: 'lister-905', id: reopened.id, href: 'next.txt' });
  const linked = panel.messages.at(-1);
  assert.equal(linked.ok, true); assert.match(linked.view.text, /linked/);
  await panel.receive({ type: 'lister-edit', requestId: 'lister-9051', id: linked.id });
  assert.equal(app.textDocuments.at(-1)?.fsPath, linked.path);
  assert.deepEqual(app.textEditors.at(-1).options, { viewColumn: 1, preview: false });
  assert.equal(app.calls.some(call => call.id === 'openExternal'), false);
  await panel.receive({ type: 'lister-link', requestId: 'lister-906', id: linked.id, href: 'https://example.invalid/lister' });
  assert.ok(app.calls.some(call => call.id === 'openExternal' && call.args[0] === 'https://example.invalid/lister'));
  await panel.receive({ type: 'lister-link', requestId: 'lister-907', id: linked.id, href: 'javascript:alert(1)' });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.equal(app.calls.filter(call => call.id === 'openExternal').length, 1);
  panel.dispose();
});

test('activation registers a right-aligned show entry after initialization without opening a production window', async t => {
  const app = harness(t);
  assert.equal(app.status.command, undefined);
  await tick();
  assert.equal(app.status.alignment, 2);
  assert.equal(app.status.priority, 101);
  assert.equal(app.status.shown, true);
  assert.equal(app.status.command, 'bitfroest.show');
  assert.equal(app.panels.length, 0);
  assert.ok(app.commands.has('bitfroest.chooseTabMode'));
});

test('clipboard path protocol validates one absolute reachable directory without writing files', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-shortcut-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'file.txt'), 'unchanged');
  const target = directory.replace(/\\/g, '/');
  const state = clipboardFixture();
  let value = ` "${target}" `;
  const app = harness(t, { clipboardText: value, readClipboardText: async () => value, filesystemLoad: async () => state, containsPath: candidate => candidate === target || candidate.startsWith(`${target}/`) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-path-read', requestId: 'path-1' });
  assert.equal(panel.messages.at(-1).ok, true); assert.equal(panel.messages.at(-1).path, target);
  assert.equal(panel.messages.at(-1).type, 'clipboard-result');
  value = `${target}/.`;
  await panel.receive({ type: 'clipboard-path-read', requestId: 'path-dot' });
  assert.equal(panel.messages.at(-1).path, target);
  for (value of ['', 'relative/path', `${target}\n${target}`, `${target}/missing`, `${target}/file.txt`, 'C:/elsewhere']) {
    await panel.receive({ type: 'clipboard-path-read', requestId: 'path-2' });
    assert.equal(panel.messages.at(-1).ok, false, value); assert.equal(panel.messages.at(-1).path, undefined);
  }
  assert.equal(fs.readFileSync(path.join(directory, 'file.txt'), 'utf8'), 'unchanged');
  assert.equal(app.clipboardCalls.every(call => call.action === 'readText'), true);
});

test('clipboard path command is exposed with a shortcut confined to the file manager list', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  assert.ok(manifest.contributes.commands.find(command => command.command === 'bitfroest.path-clipboard'));
  const binding = manifest.contributes.keybindings.find(binding => binding.command === 'bitfroest.path-clipboard');
  assert.equal(binding.key, 'ctrl+shift+l');
  for (const guard of ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.listFocus', '!bitfroest.textInput']) assert.ok(binding.when.includes(guard));
  await app.command('bitfroest.path-clipboard');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'action', action: 'path-clipboard' });
});

test('clipboard path protocol ignores stale panels and reports clipboard failures', async t => {
  const waiting = deferred();
  const app = harness(t, { readClipboardText: () => waiting.promise, filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = panel.receive({ type: 'clipboard-path-read', requestId: 'path-1' });
  panel.dispose(); waiting.resolve('C:/tmp'); await request;
  assert.equal(panel.messages.some(message => message.requestId === 'path-1'), false);
  await app.command('bitfroest.openPrototype'); const next = app.panels[1];
  await next.receive({ type: 'clipboard-path-read', requestId: 'bad\nrequest' });
  assert.equal(app.clipboardCalls.length, 1);
  const failed = harness(t, { readClipboardText: async () => { throw new Error('clipboard unavailable'); } });
  await failed.command('bitfroest.openPrototype');
  await failed.panels[0].receive({ type: 'clipboard-path-read', requestId: 'path-error' });
  assert.equal(failed.panels[0].messages.at(-1).ok, false);
  assert.match(failed.panels[0].messages.at(-1).error, /clipboard unavailable/);
});

test('generated host HTML isolates shortcuts and completes checked clipboard navigation after host acknowledgement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = directory.replace(/\\/g, '/'), state = clipboardFixture();
  state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => state, clipboardText: destination, containsPath: () => true,
    filesystemPrepare: async () => ({ ...state, folders: { ...state.folders, [destination]: [] } }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  const escaped = []; view.window.addEventListener('keydown', event => escaped.push(event.key));
  view.key('n', { ctrlKey: true, shiftKey: true }); view.key('k', { ctrlKey: true });
  assert.deepEqual(escaped, []);
  view.key('l', { ctrlKey: true, shiftKey: true });
  await panel.receive(view.messages.find(message => message.type === 'clipboard-path-read'));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.at(-1) }));
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp');
  const navigation = view.messages.find(message => message.type === 'filesystem-navigate');
  assert.equal(navigation.path, destination);
  await panel.receive(navigation);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.at(-1) }));
  assert.equal(view.state().panes[0].tabs[0], destination);
  assert.equal(view.document.activeElement.className, 'list');
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('folder sizing host protocol returns read-only metadata and rejects stale or unknown targets', async t => {
  const state = clipboardFixture(); state.folders['C:/tmp'].push({ id: 'docs', name: 'docs', type: 'folder' });
  const calls = [];
  const app = harness(t, { filesystemLoad: async () => state, measureFolder: async (...args) => { calls.push(args); return 27; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = { type: 'folder-size', operationId: 'size-1', snapshotId: state.snapshotId, path: 'C:/tmp/docs' };
  await panel.receive(request);
  assert.equal(calls.length, 1); assert.equal(calls[0][1], request.path);
  assert.equal(panel.messages.at(-1).type, 'folder-size-result');
  assert.equal(panel.messages.at(-1).size, 27); assert.equal(panel.messages.at(-1).ok, true);
  for (const extra of [{ snapshotId: 'stale' }, { path: 'C:/tmp/missing' }, { path: 'C:/tmp/a.txt' }, { path: 'C:/elsewhere/docs' }]) {
    await panel.receive({ ...request, ...extra }); assert.equal(panel.messages.at(-1).ok, false);
  }
  assert.equal(calls.length, 1);
  assert.equal(state.folders['C:/tmp'][1].size, undefined);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('folder sizing cancellation and panel disposal abort work without waiting on a notification', async t => {
  const state = clipboardFixture(); state.folders['C:/tmp'].push({ id: 'docs', name: 'docs', type: 'folder' });
  let signal;
  const app = harness(t, { filesystemLoad: async () => state, measureFolder: async (_before, _directory, settings) => {
    signal = settings.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = { type: 'folder-size', operationId: 'size-1', snapshotId: state.snapshotId, path: 'C:/tmp/docs' };
  const pending = panel.receive(request); await tick(); assert.ok(signal);
  await panel.receive({ type: 'filesystem-cancel', operationId: request.operationId }); await pending;
  assert.equal(signal.aborted, true); assert.equal(panel.messages.at(-1).cancelled, true);
  const next = panel.receive({ ...request, operationId: 'size-2' }); await tick();
  panel.dispose(); await next; assert.equal(signal.aborted, true); assert.deepEqual(app.errors, []);
});

test('folder sizing settings use the native resource configuration and reach the generated host HTML', async t => {
  const app = harness(t, { configuration: { 'files.countFolderSizeOnSpace': false } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const encoded = /data-file-settings="([^"]+)"/.exec(panel.webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).countFolderSizeOnSpace, false);
  await app.configuration('bitfroest.files');
  assert.equal(panel.messages.at(-1).settings.countFolderSizeOnSpace, false);
  const setting = Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties))['bitfroest.files.countFolderSizeOnSpace'];
  assert.equal(setting.scope, 'resource'); assert.equal(setting.default, true);
});

test('generated webview HTML authorizes and resolves every startup script including numbered module names', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(app.panels[0].webview.html); t.after(() => dom.window.close());
  const document = dom.window.document;
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce);
  const bootstrap = document.querySelector('head script:not([src])');
  assert.ok(bootstrap, 'the error handler must not depend on loading an external script');
  assert.equal(bootstrap.getAttribute('nonce'), nonce);
  assert.ok(bootstrap.compareDocumentPosition(document.querySelector('link[rel="stylesheet"]')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(bootstrap.textContent, /app-startup-error/);
  const scripts = [...document.querySelectorAll('script[src]')];
  const template = new JSDOM(fs.readFileSync(path.join(root, 'media/index.html'), 'utf8')); t.after(() => template.window.close());
  const templateScripts = [...template.window.document.querySelectorAll('script[src]')].map(script => script.getAttribute('src')).filter(name => name !== 'webview-bootstrap.js');
  assert.equal(scripts.length, templateScripts.length);
  for (const [index, script] of scripts.entries()) {
    assert.equal(script.getAttribute('nonce'), nonce, `${templateScripts[index]} must be authorized by the actual startup CSP`);
    assert.equal(script.getAttribute('src'), `webview-resource:${path.join(root, 'media', templateScripts[index])}`, `${templateScripts[index]} must use a webview resource URI`);
    assert.equal(fs.existsSync(path.join(root, 'media', templateScripts[index])), true, 'the referenced startup asset exists');
  }
});

for (const language of ['de', 'en']) test(`generated startup status displays a loaded resource in ${language}`, async t => {
  const app = harness(t, { language, manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.acquireVsCodeApi = () => ({ postMessage() {} });
  require('node:vm').runInContext(window.document.querySelector('head script:not([src])').textContent, dom.getInternalVMContext());
  window.document.querySelector('script[src$="commander-paths.js"]').dispatchEvent(new window.Event('load'));
  const status = window.document.querySelector('#startup-detail').textContent;
  assert.match(status, language === 'de' ? /Ressource geladen: commander-paths\.js/ : /Loaded resource: commander-paths\.js/);
  panel.dispose();
});

for (const language of ['de', 'en']) test(`generated startup shows indeterminate progress before any resource event in ${language}`, async t => {
  const app = harness(t, { language, manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const progress = document.querySelector('#startup-progress');
  assert.ok(progress, 'progress must exist in the initial HTML before scripts or stylesheets load');
  assert.equal(progress.hasAttribute('value'), false, 'startup progress has no known total');
  assert.match(progress.getAttribute('aria-label'), language === 'de' ? /Dateiverwaltung/ : /file manager/i);
  assert.equal(document.querySelector('#startup-progress-reason'), null);
  const window = dom.window;
  window.acquireVsCodeApi = () => ({ postMessage() {} });
  require('node:vm').runInContext(document.querySelector('head script:not([src])').textContent, dom.getInternalVMContext());
  document.querySelector('script[src$="commander-paths.js"]').dispatchEvent(new window.Event('load'));
  assert.equal(document.querySelector('#startup-progress'), progress, 'resource updates must preserve the indicator');
  panel.dispose();
});

test('initial HTML contains timed host startup stages and real directory progress even before webview scripts execute', async t => {
  const app = harness(t, { manualReadiness: true, filesystemLoad: async settings => {
    await settings.onDirectory({ path: 'C:/work/<test>', completed: 2, total: 5, rows: [] });
    return null;
  } });
  await app.command('bitfroest.openPrototype');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(app.panels[0].webview.html); t.after(() => dom.window.close());
  const log = dom.window.document.querySelector('#startup-log');
  assert.match(log.textContent, /Startverzeichnisse/);
  assert.match(log.textContent, /C:\/work\/<test>/);
  assert.match(log.textContent, /2\/5/);
  assert.match(log.textContent, /Webview/);
  assert.equal(log.querySelector('test'), null, 'directory names are rendered as text');
  assert.ok([...log.querySelectorAll('li')].every(row => /^\[\d+\.\d{3} s\]/.test(row.textContent)));
  app.panels[0].dispose();
});

for (const language of ['de', 'en']) test(`startup log reports actual requests and outcomes in ${language}`, async t => {
  const app = harness(t, { language, manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, document = window.document;
  window.acquireVsCodeApi = () => ({ postMessage() {} });
  const context = dom.getInternalVMContext(), vm = require('node:vm');
  const scripts = [...document.querySelectorAll('script:not([src])')];
  vm.runInContext(scripts.find(script => script.textContent.includes('app-startup-error')).textContent, context);
  const marker = scripts.find(script => script.textContent.includes('CommanderStartupResource.start') && script.textContent.includes('commander-paths.js'));
  assert.ok(marker, 'the actual HTML records the request before its script');
  const resource = document.querySelector('script[src$="commander-paths.js"]');
  assert.ok(marker.compareDocumentPosition(resource) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  vm.runInContext(marker.textContent, context);
  const log = document.querySelector('#startup-log');
  assert.match(log.textContent, language === 'de' ? /Skript angefordert: commander-paths\.js/ : /Script requested: commander-paths\.js/);
  assert.match(log.querySelector('li').textContent, /^\[\d+\.\d{3} s\] /);
  assert.doesNotMatch(log.textContent, language === 'de' ? /Skript geladen/ : /Script loaded/);
  resource.dispatchEvent(new window.Event('load'));
  assert.match(log.textContent, language === 'de' ? /Skript geladen: commander-paths\.js/ : /Script loaded: commander-paths\.js/);
  panel.dispose();
});

test('the generated HTML executes its complete startup sequence with the log enabled', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const { JSDOM } = require('jsdom'), vm = require('node:vm');
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only', url: 'https://prototype.invalid/' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage: message => messages.push(message) });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 8 }) });
  window.TextEncoder = TextEncoder;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.document.fonts = { forEach() {} };
  t.after(() => window.dispatchEvent(new window.Event('pagehide')));
  const steps = [];
  for (const script of window.document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    const source = src ? fs.readFileSync(src.includes('ag-grid-community') ? path.join(root, 'node_modules/ag-grid-community/dist', path.win32.basename(src)) : path.join(root, 'media', path.win32.basename(src)), 'utf8') : script.textContent;
    new vm.Script(source).runInContext(dom.getInternalVMContext());
    if (script.textContent.includes('app-startup-error')) {
      const original = window.CommanderStartupResource.step;
      window.CommanderStartupResource.step = name => { steps.push(name); original(name); };
    }
    if (src) script.dispatchEvent(new window.Event('load'));
  }
  assert.equal(messages.filter(message => message.type === 'app-ready').length, 1);
  assert.deepEqual(steps, ['initializing', 'settings', 'restore', 'controls', 'rendering']);
  assert.equal(messages.some(message => message.type === 'app-startup-error'), false);
  assert.equal(window.document.querySelector('#startup-progress'), null);
  const gridStyles = [...window.document.querySelectorAll('style[data-ag-css]')];
  const nonce = /script-src 'nonce-([^']+)'/.exec(window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content)[1];
  assert.ok(gridStyles.length > 0);
  assert.ok(gridStyles.every(style => style.getAttribute('nonce') === nonce));
  panel.dispose();
});

test('declared text select-all command delegates to the native action without selecting files', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false });
  const before = app.panels[0].messages.length;
  await app.command('bitfroest.select-all-text');
  assert.equal(app.calls.filter(call => call.id === 'editor.action.selectAll').length, 1);
  assert.equal(app.panels[0].messages.length, before);
  const command = manifest.contributes.commands.find(item => item.command === 'bitfroest.select-all-text');
  assert.ok(command);
  for (const language of ['', '.de']) assert.ok(require(`../package.nls${language}.json`)[command.title.slice(1, -1)]);
  app.panels[0].dispose();
});

test('fresh and restored views authorize existing stylesheets inside their resource roots', async t => {
  for (const restoring of [false, true]) {
    const app = harness(t);
    let panel;
    if (restoring) {
      panel = app.restoredPanel();
      await app.restore(panel, null);
    } else {
      await app.command('bitfroest.openPrototype'); panel = app.panels[0];
    }
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(panel.webview.html); t.after(() => dom.window.close());
    const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    const stylePolicy = /(?:^|;)\s*style-src ([^;]+)/.exec(policy)?.[1];
    assert.ok(stylePolicy?.split(/\s+/).includes(panel.webview.cspSource));
    const options = panel.webview.options;
    assert.equal(options.enableScripts, true);
    const mediaRoot = path.join(root, 'media');
    assert.ok(options.localResourceRoots.some(uri => uri.fsPath === mediaRoot));
    const links = [...dom.window.document.querySelectorAll('link[rel="stylesheet"]')];
    assert.equal(links.length, 4);
    for (const name of ['workbench-vendor.css', 'codicons.css', 'app.css', 'file-search.css']) {
      assert.ok(links.some(link => link.getAttribute('href') === `webview-resource:${path.join(mediaRoot, name)}`));
      assert.ok(fs.statSync(path.join(mediaRoot, name)).size > 0);
    }
    assert.match(fs.readFileSync(path.join(mediaRoot, 'codicons.css'), 'utf8'), /@import url\('\.\/icon-metrics\.css'\)/);
    assert.ok(fs.statSync(path.join(mediaRoot, 'icon-metrics.css')).size > 0);
    const imagePolicy = /(?:^|;)\s*img-src ([^;]+)/.exec(policy)?.[1];
    assert.ok(imagePolicy?.split(/\s+/).includes(panel.webview.cspSource));
    assert.match(fs.readFileSync(path.join(mediaRoot, 'app.css'), 'utf8'), /url\("icons\/drag-click-rings\.svg"\)/);
    assert.ok(fs.statSync(path.join(mediaRoot, 'icons', 'drag-click-rings.svg')).size > 0);
    assert.match(policy, new RegExp(`font-src ${panel.webview.cspSource}`));
    panel.dispose();
  }
});

test('uninitialized or failed panels cannot run file commands or accept file messages', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  await app.command('bitfroest.delete'); await panel.receive({ type: 'inputFocus', list: true });
  assert.equal(panel.messages.filter(message => message.type !== 'host-startup').length, 0); assert.notEqual(app.contexts.get('bitfroest.listFocus'), true);
  await panel.receive({ type: 'app-ready' });
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  await app.command('bitfroest.delete'); assert.equal(panel.messages.at(-1).action, 'delete');
  await panel.receive({ type: 'app-startup-error' }); const count = panel.messages.length;
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  await app.command('bitfroest.copy'); await panel.receive({ type: 'choose-drop-action', requestId: 'right-drop-1' });
  assert.equal(panel.messages.length, count); assert.equal(app.quickPicks.length, 0);
  await panel.receive({ type: 'app-ready' }); assert.equal(app.contexts.get('bitfroest.ready'), false);
  panel.dispose(); await app.command('bitfroest.openPrototype');
  await panel.receive({ type: 'app-ready' }); assert.equal(app.contexts.get('bitfroest.ready'), false);
  await app.panels[1].receive({ type: 'app-ready' }); assert.equal(app.contexts.get('bitfroest.ready'), true);
  app.panels[1].dispose(); assert.equal(app.contexts.get('bitfroest.ready'), false);
});

test('startup failures notify VS Code once without waiting for notification dismissal', async t => {
  const logs = [];
  const app = harness(t, { manualReadiness: true, showErrorMessage: () => new Promise(() => {}), onLog: (...args) => logs.push(args) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const diagnostic = { message: 'startup fixture failed', source: 'app.js', line: 42, column: 7, stack: 'fixture stack' };
  await panel.receive({ type: 'app-startup-error', diagnostic });
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0], /startup fixture failed/);
  assert.equal(logs[0][0], 'Bitfroest.fs');
  assert.equal(logs[0][1].log, true);
  assert.match(logs[0][2], /fixture stack/);
  assert.match(logs[0][2], /app\.js/);
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  await panel.receive({ type: 'app-startup-error', diagnostic });
  await panel.receive({ type: 'app-ready' });
  assert.equal(app.errors.length, 1);
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  panel.dispose();
});

test('the host receives a startup error as soon as the webview HTML is assigned', async t => {
  let delivery;
  const app = harness(t, { manualReadiness: true, onHtml: panel => {
    delivery = panel.receive({ type: 'app-startup-error', diagnostic: { message: 'early stylesheet failure' } });
  } });
  await app.command('bitfroest.openPrototype');
  await delivery;
  assert.match(app.errors[0], /early stylesheet failure/);
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  app.panels[0].dispose();
});

for (const language of ['de', 'en']) test(`generated startup failure dialog remains localized before application initialization (${language})`, async t => {
  const app = harness(t, { language, manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  require('node:vm').runInContext(fs.readFileSync(path.join(root, 'media/webview-bootstrap.js'), 'utf8'), dom.getInternalVMContext());
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'startup fixture failed' }));
  assert.equal(window.document.querySelector('#modal').open, true);
  assert.equal(window.document.querySelector('#modal-cancel').textContent, language === 'de' ? 'Schließen' : 'Close');
  assert.match(window.document.querySelector('#modal-title').textContent, language === 'de' ? /nicht gestartet/ : /Unable to start/);
  await panel.receive(messages[0]);
  assert.match(app.errors[0], language === 'de' ? /nicht gestartet/ : /Unable to start/);
  panel.dispose();
});

test('directory navigation completes while a file mutation is still running', async t => {
  const initial = clipboardFixture(); let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const app = harness(t, { filesystemLoad: async () => initial,
    filesystemApply: async () => { await barrier; return initial; },
    filesystemPrepare: async before => before });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const mutation = panel.receive({ type: 'filesystem-apply', state: initial, operationId: 'background-copy', transfer: { mode: 'copy', sourcePath: 'C:/tmp', ids: ['a'], sourceSide: 0 } });
  await tick();
  const navigation = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/temp', side: 0, navigationRequestId: 'directory-1' });
  await tick();
  try { assert.ok(panel.messages.some(message => message.navigationRequestId === 'directory-1' && message.type === 'filesystem-result')); }
  finally { release(); await Promise.all([mutation, navigation]); panel.dispose(); }
});

test('ZIP navigation completes while packing remains active', async t => {
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem;
  let release, entered; const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), writeArchive: async state => { entered(); await barrier; return state; } });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-parallel-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'existing.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'data' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'].push({ id: 'zip', name: 'existing.zip', type: 'archive', fsSource: archive });
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(dir.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const packing = panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['a'], archive: `${dir.replaceAll('\\', '/')}/out.zip`, operationId: 'pack-parallel', state: initial });
  await started;
  const navigation = panel.receive({ type: 'zip-open', path: archive, side: 0, navigationRequestId: 'directory-1', state: initial });
  try { assert.equal(await Promise.race([navigation.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('blocked'), 500))]), 'done'); assert.ok(panel.messages.some(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-1' && message.ok), JSON.stringify(panel.messages.at(-1))); }
  finally { release(); await Promise.all([packing, navigation]); panel.dispose(); }
});

test('navigation publishes the exact authoritative folders after cache eviction and allows the next write', async t => {
  const { createProvider } = require('../filesystem-provider');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfroest-navigation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const left = path.join(directory, 'left').replace(/\\/g, '/'), right = path.join(directory, 'right').replace(/\\/g, '/');
  fs.mkdirSync(left); fs.mkdirSync(right); fs.mkdirSync(`${left}/docs`); fs.writeFileSync(`${left}/docs/nested.txt`, 'nested');
  let authoritative;
  const app = harness(t, { startupRoots: [left, right], providerFactory: () => {
    const provider = createProvider({ roots: [left, right], directoryCacheBytes: 64 });
    return { ...provider,
      async load(settings) { const result = await provider.load(settings); authoritative = structuredClone(result); return result; },
      async prepare(before, settings) { const result = await provider.prepare(before, settings); authoritative = structuredClone(result); return result; } };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  for (const [index, target] of [`${left}/docs`, left, `${left}/docs`, left].entries()) {
    await panel.receive({ type: 'filesystem-navigate', state: authoritative, path: target, side: 0, navigationRequestId: `directory-${index + 1}` });
    const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.state.folders, authoritative.folders);
  }
  await panel.receive({ type: 'filesystem-apply', state: authoritative });
  assert.equal(panel.messages.at(-1).ok, true, panel.messages.at(-1).error);
  panel.dispose();
});

test('confirmed mutations interrupt pending directory reads and ignore their late results', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let reads = 0, concurrent = 0, maximum = 0, writes = 0, visiblePaths, readSignal;
  const initial = clipboardFixture();
  initial.panes.forEach((pane, side) => { pane.tabStates = [{ id: `tab-${side}`, path: pane.tabs[pane.tab] }]; });
  const app = harness(t, { filesystemLoad: async () => initial, filesystemApply: async before => { writes++; return before; }, filesystemPrepare: async (before, settings) => {
    maximum = Math.max(maximum, ++concurrent);
    if (++reads === 1) { visiblePaths = settings.getVisibleDirectories; readSignal = settings.signal; entered(); await barrier; }
    concurrent--; return before;
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const first = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/temp', side: 0, navigationRequestId: 'directory-1', navigationTabId: 'tab-0' });
  await started;
  const second = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/tmp', side: 1, navigationRequestId: 'directory-2', navigationTabId: 'tab-1' });
  let mutation;
  try {
    await tick();
    assert.equal(maximum, 2, 'opposite navigation must start while the first read is pending');
    assert.equal(panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-2')?.ok, true);
    const panes = structuredClone(initial.panes); panes[1].tabs[panes[1].tab] = 'C:/tmp';
    await panel.receive({ type: 'view-state', panes, active: 1 });
    assert.deepEqual(visiblePaths(), ['C:/temp', 'C:/tmp']);
    mutation = panel.receive({ type: 'filesystem-apply', state: initial }); await tick();
    assert.equal(writes, 1, 'a confirmed write must start before the pending read completes');
    assert.equal(readSignal.aborted, true, 'the superseded directory read must be cancelled');
  } finally { release(); await Promise.all([first, second, mutation]); }
  assert.equal(writes, 1);
  assert.equal(panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-1')?.cancelled, true);
  assert.equal(panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-2')?.ok, true);
  panel.dispose();
});

for (const type of ['zip-write', 'zip-unpack']) test(`${type} starts while directory metadata is pending`, async t => {
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem;
  const reading = deferred(), entered = deferred();
  let signal, operations = 0;
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), writeArchive: async () => { operations++; }, unpackArchives: async () => { operations++; } });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const initial = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), filesystemPrepare: async (before, settings) => { signal = settings.signal; entered.resolve(); await reading.promise; return before; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const navigation = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/temp', side: 1, navigationRequestId: 'directory-1' });
  await entered.promise;
  let operation;
  try {
    operation = panel.receive({ type, action: 'pack', sourcePath: 'C:/tmp', ids: ['a'], archive: 'C:/temp/out.zip', target: 'C:/temp', operationId: 'zip-during-read', state: initial });
    await tick(); assert.equal(operations, 1); assert.equal(signal.aborted, true);
  } finally { reading.resolve(); await Promise.all([navigation, operation]); panel.dispose(); }
});

test('generated host HTML starts a copy during a pending refresh and rejects the stale refresh result', { timeout: 10000 }, async t => {
  const initial = clipboardFixture(), reading = deferred(), entered = deferred();
  let signal, writes = 0;
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), filesystemPrepare: async (_before, settings) => {
    signal = settings.signal; entered.resolve(); await reading.promise; return { ...initial, snapshotId: 'obsolete' };
  }, filesystemApply: async (_before, after) => { writes++; return { ...after, snapshotId: 'copied' }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  view.action('refresh');
  const refresh = view.messages.find(message => message.type === 'filesystem-refresh');
  const refreshRun = panel.receive(refresh); await entered.promise;
  let copyRun;
  try {
    view.click(view.row('a.txt').querySelector('[data-filename]')); view.action('copy');
    view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    const copy = view.messages.find(message => message.type === 'filesystem-apply'); assert.ok(copy);
    copyRun = panel.receive(copy); await tick();
    assert.equal(writes, 1); assert.equal(signal.aborted, true);
  } finally { reading.resolve(); await Promise.all([refreshRun, copyRun]); }
  const copyResult = panel.messages.find(message => message.type === 'filesystem-result' && message.operationId);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: copyResult }));
  const old = panel.messages.find(message => message.type === 'filesystem-result' && message.refreshRequestId);
  assert.equal(old.cancelled, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: old }));
  assert.equal(view.state().snapshotId, 'copied');
  assert.ok(view.state().folders['C:/temp'].some(row => row.name === 'a.txt'));
  panel.dispose();
});

test('a superseded archive opening cannot publish after a confirmed archive write', async t => {
  const initial = clipboardFixture(); initial.folders['C:/tmp'].push({ id: 'zip', name: 'archive.zip', type: 'archive', fsSource: 'C:/tmp/archive.zip' });
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem, entered = deferred(), reading = deferred();
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), openArchive: async () => { entered.resolve(); await reading.promise; return { path: 'zip:C:/tmp/archive.zip!/', state: initial }; }, writeArchive: async () => {} });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const app = harness(t, { filesystemLoad: async () => initial }); await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const opening = panel.receive({ type: 'zip-open', path: 'C:/tmp/archive.zip', side: 0, navigationRequestId: 'directory-1', state: initial }); await entered.promise;
  await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['a'], archive: 'C:/temp/new.zip', operationId: 'pack-after-open', state: initial });
  reading.resolve(); await opening;
  assert.equal(panel.messages.find(message => message.navigationRequestId === 'directory-1')?.cancelled, true);
  panel.dispose();
});

test('copy content verification is a persistent boolean setting with an off default', async t => {
  const configurations = manifest.contributes.configuration;
  const property = (Array.isArray(configurations) ? configurations : [configurations]).map(section => section.properties?.['bitfroest.files.verifyAfterCopy']).find(Boolean);
  assert.equal(property?.type, 'boolean'); assert.equal(property.default, false);
  const initial = clipboardFixture(), app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'copy-verification-setting', enabled: true });
  assert.ok(app.updateCalls.some(update => update.store === 'configuration' && update.key === 'files.verifyAfterCopy' && update.value === true && update.target === 1));
  await panel.receive({ type: 'copy-verification-setting', enabled: false });
  assert.equal(app.updateCalls.filter(update => update.key === 'files.verifyAfterCopy').at(-1).value, false);
  const count = app.updateCalls.length; await panel.receive({ type: 'copy-verification-setting', enabled: 'true' }); assert.equal(app.updateCalls.length, count);
  await panel.receive({ type: 'copy-verification-setting', enabled: true });
  panel.dispose();
  await app.command('bitfroest.openPrototype');
  const reopened = app.panels.at(-1), value = reopened.webview.html.match(/data-file-settings="([^"]+)"/)[1];
  assert.equal(JSON.parse(decodeURIComponent(value)).verifyAfterCopy, true);
  reopened.dispose();
});
for (const enabled of [false, true]) test(`host forwards content verification ${enabled} to the copy provider`, async t => {
  const initial = clipboardFixture(); let received;
  const app = harness(t, { configuration: { 'files.verifyAfterCopy': !enabled }, filesystemLoad: async () => initial, filesystemApply: async (before, _after, operation) => { received = operation; return before; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'filesystem-apply', state: initial, operationId: 'copy-verification', transfer: { mode: 'copy', sourcePath: 'C:/tmp', sourceSide: 0, ids: ['a'], verifyAfterCopy: enabled } });
  assert.equal(received.verifyAfterCopy, enabled); panel.dispose();
});
test('copy verification updates an existing workspace override', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), configurationScopes: { 'files.verifyAfterCopy': { globalValue: false, workspaceValue: true } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'copy-verification-setting', enabled: false });
  assert.ok(app.updateCalls.some(update => update.key === 'files.verifyAfterCopy' && update.value === false && update.target === 2)); panel.dispose();
});

test('clipboard reads do not wait for directory metadata', async t => {
  const initial = clipboardFixture(), reading = deferred(), entered = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async before => { entered.resolve(); await reading.promise; return before; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const navigation = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/temp', side: 1, navigationRequestId: 'directory-1' }); await entered.promise;
  let clipboard;
  try {
    clipboard = panel.receive({ type: 'clipboard-read', requestId: 'read-during-navigation' }); await tick();
    assert.ok(panel.messages.some(message => message.type === 'clipboard-result' && message.requestId === 'read-during-navigation'));
  } finally { reading.resolve(); await Promise.all([navigation, clipboard]); panel.dispose(); }
});

test('navigation in another tab does not cancel a pending read of the same pane', async t => {
  const initial = clipboardFixture(), reading = deferred(), entered = deferred();
  const aborted = [];
  let count = 0;
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async (before, settings) => {
    settings.signal.addEventListener('abort', () => aborted.push(count), { once: true });
    if (++count === 1) { entered.resolve(); await reading.promise; }
    return before;
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const first = panel.receive({ type: 'filesystem-navigate', state: initial, navigationRequestId: 'directory-1', navigationTabId: 'tab-a', path: 'C:/temp', side: 0 }); await entered.promise;
  const second = panel.receive({ type: 'filesystem-navigate', state: initial, navigationRequestId: 'directory-2', navigationTabId: 'tab-b', path: 'C:/tmp', side: 0 });
  await tick(); reading.resolve(); await Promise.all([first, second]);
  assert.deepEqual(aborted, []);
  assert.equal(panel.messages.filter(message => message.type === 'filesystem-result' && message.cancelled).length, 0);
  panel.dispose();
});

test('a completed directory read preserves tabs switched while it was pending', async t => {
  const initial = clipboardFixture(), reading = deferred(), entered = deferred();
  initial.panes[0].tabs = ['C:/tmp', 'C:/temp'];
  initial.panes[0].tabStates = [{ id: 'tab-a', path: 'C:/tmp' }, { id: 'tab-b', path: 'C:/temp' }];
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async before => { entered.resolve(); await reading.promise; return before; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-1', navigationTabId: 'tab-a', state: initial, side: 0, path: 'C:/tmp' }); await entered.promise;
  const switched = structuredClone(initial); switched.panes[0].tab = 1; switched.active = 1;
  await panel.receive({ type: 'state', state: switched });
  reading.resolve(); await pending;
  const result = panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-1');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state.panes[0].tab, 1);
  assert.equal(result.state.panes[0].tabs[1], 'C:/temp');
  assert.equal(result.state.active, 1);
  panel.dispose();
});

test('closing a tab cancels its pending directory read without restoring the closed tab', async t => {
  const initial = clipboardFixture(), reading = deferred(), entered = deferred();
  initial.panes[0].tabs = ['C:/tmp', 'C:/temp'];
  initial.panes[0].tabStates = [{ id: 'tab-a', path: 'C:/tmp' }, { id: 'tab-b', path: 'C:/temp' }];
  const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async (before, settings) => { entered.resolve(settings.signal); await reading.promise; return before; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-1', navigationTabId: 'tab-a', state: initial, side: 0, path: 'C:/tmp' });
  const signal = await entered.promise;
  const closed = structuredClone(initial); closed.panes[0].tabs = ['C:/temp']; closed.panes[0].tabStates.splice(0, 1);
  await panel.receive({ type: 'state', state: closed });
  try { assert.equal(signal.aborted, true); }
  finally { reading.resolve(); await pending; }
  const result = panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-1');
  assert.equal(result.cancelled, true); assert.equal(result.resumeNavigation, undefined);
  assert.deepEqual(app.context.workspaceState.get('fileManagerState').panes[0].tabs, ['C:/temp']);
  panel.dispose();
});

test('an isolated navigation finishing after a mutation cannot replace the authoritative snapshot', async t => {
  let providerCount = 0, releaseWrite, releaseRead, authoritative;
  const writing = new Promise(resolve => { releaseWrite = resolve; });
  const reading = new Promise(resolve => { releaseRead = resolve; });
  const app = harness(t, { providerFactory: () => {
    const isolated = providerCount++ > 0; let sequence = 0;
    return { contains: path => /^C:\/(tmp|temp)/.test(path),
      async load() { if (isolated) await reading; const state = { ...clipboardFixture(), snapshotId: `${isolated ? 'read' : 'main'}-${++sequence}` }; if (!isolated) authoritative = state.snapshotId; return state; },
      async apply(before, after) { assert.equal(before.snapshotId, authoritative); await writing; return { ...after, snapshotId: authoritative }; },
      async prepare(before) { assert.equal(before.snapshotId, authoritative); return before; } };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const initial = { ...clipboardFixture(), snapshotId: authoritative };
  const write = panel.receive({ type: 'filesystem-apply', state: initial, operationId: 'write-1', transfer: { mode: 'copy', sourcePath: 'C:/tmp', ids: ['a'], sourceSide: 0 } }); await tick();
  const read = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/temp', side: 0, navigationRequestId: 'directory-1' }); await tick();
  releaseWrite(); await write; releaseRead(); await read;
  const result = panel.messages.filter(message => message.navigationRequestId === 'directory-1' && message.type === 'filesystem-result').at(-1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state.snapshotId, authoritative, JSON.stringify(panel.messages.map(m => ({type:m.type, request:m.navigationRequestId, id:m.state?.snapshotId, error:m.error}))));
  assert.match(authoritative, /^main-/);
  await panel.receive({ type: 'filesystem-apply', state: result.state, operationId: 'write-2' });
  assert.equal(panel.messages.at(-1).ok, true); panel.dispose();
});

test('late isolated navigation serializes its authoritative rebase with a running refresh', async t => {
  let count = 0, sequence = 0, concurrent = 0, maximum = 0, authoritative;
  const writing = deferred(), reading = deferred(), refreshing = deferred(), refreshStarted = deferred();
  const app = harness(t, { providerFactory: () => {
    const isolated = count++ > 0;
    return { contains: target => /^C:\/(tmp|temp)/.test(target),
      async load() {
        if (isolated) { await reading.promise; return { ...clipboardFixture(), snapshotId: 'isolated' }; }
        maximum = Math.max(maximum, ++concurrent);
        const id = ++sequence;
        if (id === 2) { refreshStarted.resolve(); await refreshing.promise; }
        concurrent--; authoritative = `main-${id}`;
        return { ...clipboardFixture(), snapshotId: authoritative };
      },
      async apply(before) { assert.equal(before.snapshotId, authoritative); await writing.promise; return before; },
      async prepare(before) { assert.equal(before.snapshotId, authoritative); return before; }
    };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], initial = { ...clipboardFixture(), snapshotId: authoritative };
  const write = panel.receive({ type: 'filesystem-apply', state: initial, operationId: 'write-1', transfer: { mode: 'copy' } }); await tick();
  const read = panel.receive({ type: 'filesystem-navigate', state: initial, path: 'C:/temp', side: 0, navigationRequestId: 'directory-1' }); await tick();
  writing.resolve(); await write;
  const refresh = panel.receive({ type: 'filesystem-refresh', state: initial }); await refreshStarted.promise;
  reading.resolve(); await tick(); refreshing.resolve(); await Promise.all([read, refresh]);
  assert.equal(maximum, 1, 'rebase must not overlap another authoritative load');
  const result = panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-1');
  assert.equal(result.ok, true, result.error); assert.equal(result.state.snapshotId, authoritative);
  await panel.receive({ type: 'filesystem-apply', state: result.state });
  assert.equal(panel.messages.at(-1).ok, true, panel.messages.at(-1).error);
  panel.dispose();
});

test('a superseded isolated rebase is cancelled without publishing its obsolete view', async t => {
  const writing = deferred(), reading = deferred(), rebasing = deferred(), releaseRebase = deferred();
  let count = 0, loads = 0, authoritative = 'main-1';
  const app = harness(t, { providerFactory: () => {
    const isolated = count++ > 0;
    return { contains: target => /^C:\/(tmp|temp)/.test(target),
      async load(settings) {
        if (isolated) { await reading.promise; return { ...clipboardFixture(), snapshotId: 'isolated' }; }
        if (++loads === 2) {
          rebasing.resolve(settings.signal); await releaseRebase.promise;
          if (settings.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          authoritative = 'obsolete';
        }
        return { ...clipboardFixture(), snapshotId: authoritative };
      },
      async apply(before) { assert.equal(before.snapshotId, authoritative); await writing.promise; return before; },
      async prepare(before) { assert.equal(before.snapshotId, authoritative); return before; }
    };
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], initial = { ...clipboardFixture(), snapshotId: authoritative };
  const write = panel.receive({ type: 'filesystem-apply', state: initial, operationId: 'write-1', transfer: { mode: 'copy' } }); await tick();
  const read = panel.receive({ type: 'filesystem-navigate', state: initial, side: 0, path: 'C:/temp', navigationRequestId: 'directory-1', navigationTabId: 'tab-a' }); await tick();
  writing.resolve(); await write; reading.resolve();
  const signal = await rebasing.promise;
  const newer = panel.receive({ type: 'filesystem-navigate', state: initial, side: 0, path: 'C:/tmp', navigationRequestId: 'directory-2', navigationTabId: 'tab-a' });
  assert.ok(signal); assert.equal(signal.aborted, true);
  releaseRebase.resolve(); await Promise.all([read, newer]);
  const old = panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-1');
  const current = panel.messages.find(message => message.type === 'filesystem-result' && message.navigationRequestId === 'directory-2');
  assert.equal(old.cancelled, true); assert.equal(old.resumeNavigation, undefined);
  assert.equal(current.ok, true, current.error); assert.equal(current.state.snapshotId, authoritative);
  assert.equal(authoritative, 'main-1');
  await panel.receive({ type: 'filesystem-apply', state: current.state });
  assert.equal(panel.messages.at(-1).ok, true, panel.messages.at(-1).error);
  panel.dispose();
});

test('native webview file menus require a rendered ready application', () => {
  for (const item of manifest.contributes.menus['webview/context']) {
    if (item.command === 'bitfroest.select-all-text') assert.match(item.when, /webviewSection == textInput/);
    else if (item.command === 'bitfroest.configureColumns') assert.match(item.when, /webviewSection == columns/);
    else assert.match(item.when, /bitfroest\.ready/);
    assert.match(item.when, /webviewId == bitfroestPrototype/);
  }
  for (const item of manifest.contributes.commands.filter(item => item.enablement)) {
    if (['bitfroest.openPrototype', 'bitfroest.show'].includes(item.command)) assert.equal(item.enablement, 'bitfroest.canOpen');
    else assert.match(item.enablement, /bitfroest\.ready/);
  }
});

test('file shortcuts require this webview, list focus and absence of text input', () => {
  const bindings = manifest.contributes.keybindings.filter(binding => binding.command !== 'bitfroest.openPrototype');
  assert.ok(bindings.some(binding => binding.key === 'ctrl+t'));
  assert.ok(bindings.some(binding => binding.key === 'f5'));
  for (const binding of bindings) {
    const clauses = binding.when.split(/\s*&&\s*/);
    if (binding.command === 'bitfroest.lister-action' || binding.command === 'bitfroest.search-key') {
      for (const guard of ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.ready']) assert.ok(clauses.includes(guard));
      assert.ok(clauses.some(clause => /^bitfroest\.(listerFocus|searchFocus|searchResultsFocus)$/.test(clause)));
      continue;
    }
    const guards = ['bitfroest.next-tab', 'bitfroest.previous-tab'].includes(binding.command) ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.tabFocus', '!bitfroest.textInput'] : binding.when.includes('bitfroest.inlineRenameInput') ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.inlineRenameInput', 'bitfroest.textInput'] : binding.command === 'bitfroest.ignore-dialog-function-key' ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.fileDialog', '!bitfroest.transferNameInput'] : binding.command.startsWith('bitfroest.transfer-name-') ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.transferNameInput', 'bitfroest.textInput'] : binding.command.startsWith('bitfroest.conflict-') ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.conflictDialog'] : ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.listFocus', '!bitfroest.textInput'];
    for (const guard of guards) assert.ok(clauses.includes(guard), `${binding.command} lacks ${guard}`);
  }
});

test('Shift+F5 is registered as a scoped same-directory copy command', async t => {
  const binding = manifest.contributes.keybindings.find(item => item.key === 'shift+f5');
  assert.equal(binding?.command, 'bitfroest.copy-same');
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.copy-same');
  assert.equal(app.panels[0].messages.at(-1).action, 'copy-same');
});
test('Insert is registered only for focused file lists and forwards its selection command', async t => {
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.toggle-selection-next');
  assert.equal(binding?.key, 'insert'); assert.match(binding.when, /bitfroest.listFocus/); assert.match(binding.when, /!bitfroest.textInput/);
  const app = harness(t); await app.command('bitfroest.openPrototype'); await app.command('bitfroest.toggle-selection-next');
  assert.equal(app.panels[0].messages.at(-1).action, 'toggle-selection-next');
});

test('column header configuration opens the configuration editor and has its own context section', async t => {
  const app = harness(t);
  await app.command('bitfroest.configureColumns');
  assert.equal(app.panels[0].viewType, 'bitfroestConfiguration');
  await app.panels[0].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[0].messages.at(-1).section, 'columns');
  const item = manifest.contributes.menus['webview/context'].find(item => item.command === 'bitfroest.configureColumns');
  assert.match(item?.when || '', /webviewSection == columns/);
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties));
  assert.ok(properties['bitfroest.columns.sets']);
  assert.ok(properties['bitfroest.columns.activeSet']);
});

test('list focus does not reconfigure the window or start a focus refresh feedback chain', async t => {
  let feedback = false, effects = 0;
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), commandEffect: async (id, _args, panels) => {
    if (!feedback || id !== 'workbench.action.enableCompactAuxiliaryWindow') return;
    if (++effects > 3) return;
    const panel = panels[0];
    await panel.receive({ type: 'inputFocus', value: false, list: false });
    await panel.receive({ type: 'filesystem-refresh', state: clipboardFixture() });
    await panel.receive({ type: 'inputFocus', value: false, list: true });
  } });
  await app.command('bitfroest.openPrototype');
  const before = app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  feedback = true;
  await app.panels[0].receive({ type: 'inputFocus', value: false, list: true });
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length, before);
  assert.equal(effects, 0);
  assert.equal(app.contexts.get('bitfroest.listFocus'), true);
  await app.command('bitfroest.copy');
  assert.equal(app.panels[0].messages.at(-1).action, 'copy');
});

test('new auxiliary windows preserve native window controls after focused readiness', async t => {
  for (const platform of ['win32', 'linux']) {
    const app = harness(t, { platform, manualReadiness: true });
    await app.command('bitfroest.openPrototype');
    const panel = app.panels[0];
    const fullscreen = () => app.calls.filter(call => call.id === 'workbench.action.toggleFullScreen').length;
    assert.equal(fullscreen(), 0);
    await panel.receive({ type: 'app-ready' });
    const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
    assert.ok(check);
    await panel.receive({ type: 'auxiliary-compact-ready', requestId: 'stale' });
    assert.equal(fullscreen(), 0);
    await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
    assert.equal(fullscreen(), 0);
    await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
    await app.command('bitfroest.show');
    assert.equal(fullscreen(), 0);
    panel.dispose();
    await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
    assert.equal(fullscreen(), 0);
  }
});

test('native window setup uses only the marked window and restores a stable title', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  assert.equal(panel.viewType, 'bitfroestPrototype');
  assert.equal(panel.title, 'Bitfroest.fs · Arbeitsbereich');
  assert.ok(panel.webview.html.includes('Content-Security-Policy'));
  assert.ok(panel.webview.html.includes('data-icon-theme='));
  assert.ok(panel.webview.html.includes('nonce='));
  assert.ok(panel.webview.options.localResourceRoots.length >= 2);
  const setup = app.calls.filter(call => call.id.startsWith('workbench.action.')).map(call => call.id);
  assert.deepEqual(setup, ['workbench.action.moveEditorToNewWindow']);
  assert.equal(app.nativeCalls.length, 1);
  assert.equal(app.nativeCalls[0].operation, 'windows.maximize');
  assert.match(app.nativeCalls[0].titleToken, /^[a-f0-9-]{36}$/);
  assert.equal(app.errors.length, 0);
});

test('a stale source window title cannot claim maximization after an editor move', async t => {
  const moved = deferred();
  const source = { title: '' }, destination = { title: '' };
  let selected, panelTitle, owner = source;
  const app = harness(t, {
    commandEffect: async (id, _args, panels) => {
      if (id !== 'workbench.action.moveEditorToNewWindow') return;
      const panel = panels[0];
      panelTitle = panel.title; source.title = panelTitle;
      Object.defineProperty(panel, 'title', { get: () => panelTitle, set(value) { panelTitle = value; owner.title = value; } });
      await moved.promise;
      destination.title = panelTitle; owner = destination;
    },
    native: callback => {
      const token = app.nativeCalls.at(-1).titleToken;
      selected = [source, destination].find(window => window.title.includes(token));
      callback(null);
    }
  });
  const opening = app.command('bitfroest.openPrototype'); await tick();
  assert.equal(app.nativeCalls.length, 0);
  moved.resolve(); await opening;
  assert.equal(selected, destination, 'Only the destination may receive the native action.');
  assert.equal(source.title.includes(app.nativeCalls[0].titleToken), false);
  app.panels[0].dispose();
});

test('compact readiness waits until native setup finishes without entering fullscreen', async t => {
  let finish;
  const app = harness(t, { manualReadiness: true, native: callback => { finish = callback; }, commandError: 'workbench.action.toggleFullScreen' });
  const opening = app.command('bitfroest.openPrototype');
  await tick();
  const panel = app.panels[0];
  await panel.receive({ type: 'app-ready' });
  assert.equal(panel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  finish(null);
  await opening;
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
  assert.ok(check);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  await tick();
  assert.equal(app.errors.length, 0);
  assert.equal(panel.disposed, false);
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length, 1);
});

test('a newly opened active panel restores focus after replacing its loading document', async t => {
  const loading = deferred();
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise });
  const opening = app.command('bitfroest.openPrototype'); await tick();
  const panel = app.panels[0]; panel.active = true;
  loading.resolve(clipboardFixture()); await opening;
  assert.equal(panel.reveals, 1);
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
  assert.ok(check);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length, 1);
});

test('opening completion does not focus an inactive panel', async t => {
  const loading = deferred();
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise });
  const opening = app.command('bitfroest.openPrototype'); await tick();
  const panel = app.panels[0]; panel.active = false;
  loading.resolve(clipboardFixture()); await opening;
  assert.equal(panel.reveals, 0);
});

test('compact auxiliary mode waits for webview readiness after the move and ignores stale replies', async t => {
  const move = deferred(); let moveStarted;
  const started = new Promise(resolve => { moveStarted = resolve; });
  const app = harness(t, { manualReadiness: true, commandEffect: async id => { if (id === 'workbench.action.moveEditorToNewWindow') { moveStarted(); await move.promise; } } });
  const opening = app.commands.get('bitfroest.openPrototype')(); await started; await tick();
  const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  const compact = () => app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  assert.equal(compact(), 0);
  assert.equal(panel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  move.resolve(); await opening;
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check'); assert.ok(check);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  assert.equal(compact(), 1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(compact(), 1);
});

test('compact auxiliary readiness requested after move handles app-ready later and ignores replies from a reopened panel', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.commands.get('bitfroest.openPrototype')(); const oldPanel = app.panels[0];
  assert.equal(oldPanel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  await oldPanel.receive({ type: 'app-ready' });
  const oldCheck = oldPanel.messages.find(message => message.type === 'auxiliary-compact-check'); assert.ok(oldCheck);
  await oldPanel.receive({ type: 'auxiliary-compact-ready', requestId: oldCheck.requestId });
  oldPanel.dispose();
  await app.commands.get('bitfroest.openPrototype')(); const panel = app.panels[1];
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check'); assert.ok(check);
  const compact = () => app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  assert.equal(compact(), 1);
  await oldPanel.receive({ type: 'auxiliary-compact-ready', requestId: oldCheck.requestId });
  assert.equal(compact(), 1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  assert.equal(compact(), 2);
});

test('focused file list hides the auxiliary status strip through generated host HTML without a window focus event', async t => {
  let activeWindow = 'main';
  const fullscreenWindows = [];
  const strips = { main: true, auxiliary: true };
  const app = harness(t, { manualReadiness: true, commandEffect: async id => {
    if (id === 'workbench.action.toggleFullScreen') fullscreenWindows.push(activeWindow);
    if (id === 'workbench.action.enableCompactAuxiliaryWindow' && activeWindow === 'auxiliary') strips.auxiliary = false;
  } });
  await app.commands.get('bitfroest.openPrototype')();
  const panel = app.panels[0];
  const { createApp } = require('./support/webview.cjs');
  const view = createApp(t, undefined, { html: panel.webview.html });
  let focused = false;
  view.document.hasFocus = () => focused;
  Object.defineProperty(view.document, 'visibilityState', { configurable: true, value: 'visible' });
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
  assert.ok(check);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: check }));
  assert.equal(strips.auxiliary, true);
  activeWindow = 'auxiliary'; focused = true;
  const list = view.document.querySelector('.list');
  list.dispatchEvent(new view.window.FocusEvent('focusin', { bubbles: true }));
  const replies = view.messages.filter(message => message.type === 'auxiliary-compact-ready');
  assert.equal(replies.length, 1);
  await panel.receive(replies[0]);
  assert.equal(strips.auxiliary, false);
  assert.equal(strips.main, true);
  assert.deepEqual(fullscreenWindows, []);
  const before = app.calls.length;
  list.dispatchEvent(new view.window.FocusEvent('focusin', { bubbles: true }));
  view.window.dispatchEvent(new view.window.Event('focus'));
  assert.equal(view.messages.filter(message => message.type === 'auxiliary-compact-ready').length, 1);
  assert.equal(app.calls.length, before);
  assert.equal(app.updateCalls.length, 0);
});

test('restored single editor hides native tabs and status strip through generated host readiness', async t => {
  const logs = [], app = harness(t, { manualReadiness: true, onInfoLog: line => logs.push(JSON.parse(line)) });
  const panel = app.restoredPanel();
  await app.restore(panel);
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.document.hasFocus = () => true;
  Object.defineProperty(view.document, 'visibilityState', { configurable: true, value: 'visible' });
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
  assert.ok(check, 'restoration must request focused readiness');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: check }));
  await panel.receive(view.messages.find(message => message.type === 'auxiliary-compact-ready'));
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length, 1);
  const command = logs.find(row => row.kind === 'window-command-start' && row.command === 'workbench.action.enableCompactAuxiliaryWindow');
  assert.ok(command);
  assert.equal(command.panelActive, panel.active);
  await tick();
  assert.ok(logs.some(row => row.kind === 'window-command-complete' && row.requestId === command.requestId));
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.toggleFullScreen'), false);
  assert.equal(app.updateCalls.length, 0);
});

test('closing a companion editor restores compact chrome once and rejects earlier readiness', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], group = app.tabGroups[0];
  await panel.receive({ type: 'app-ready' });
  const first = panel.messages.at(-1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: first.requestId });
  const compact = () => app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  assert.equal(compact(), 1);
  group.tabs.push({ input: { viewType: 'bitfroestFolderLocks' } }); app.tabsChanged();
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: first.requestId });
  assert.equal(compact(), 1, 'companion tabs must stay accessible');
  group.tabs.pop(); app.tabsChanged();
  const next = panel.messages.at(-1);
  assert.equal(next.type, 'auxiliary-compact-check');
  assert.notEqual(next.requestId, first.requestId);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: first.requestId });
  assert.equal(compact(), 1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: next.requestId });
  assert.equal(compact(), 2);
  const count = panel.messages.length;
  app.tabGroups.push({ viewColumn: 9, tabs: [{ input: {} }, { input: {} }] });
  app.tabsChanged(); app.groupsChanged();
  assert.equal(panel.messages.length, count, 'unrelated tab changes must not reconfigure the window');
  panel.dispose(); group.tabs.push({ input: {} }); app.tabsChanged(); group.tabs.pop(); app.tabsChanged();
  assert.equal(panel.messages.length, count);
  assert.equal(app.updateCalls.length, 0);
});

test('restored companion editors keep native tabs until the last companion closes', async t => {
  const app = harness(t, { manualReadiness: true });
  const panel = app.restoredPanel(), group = app.tabGroups[0];
  group.tabs.push({ input: { viewType: 'volume-details' } });
  await app.restore(panel);
  await panel.receive({ type: 'app-ready' });
  assert.equal(panel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  group.tabs.pop(); app.groupsChanged();
  assert.equal(panel.messages.at(-1).type, 'auxiliary-compact-check');
});

test('preview and comparison editors do not force compact mode over their additional tabs', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  for (const message of [
    { type: 'preview', path: 'C:/tmp/a.txt' },
    { type: 'conflict-preview', path: 'C:/tmp/a.txt' },
    { type: 'compare', sourcePath: 'C:/tmp/a.txt', targetPath: 'C:/tmp/a.txt' }
  ]) {
    const before = app.calls.length;
    await panel.receive(message);
    assert.equal(app.calls.slice(before).some(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow'), false, message.type);
  }
});

test('the icon-only status button opens or reveals the application without a text editor', async t => {
  const app = harness(t);
  await tick();
  assert.equal(app.status.text, '$(folder)');
  assert.equal(app.status.shown, true);
  assert.equal(app.status.accessibilityInformation.label, app.status.tooltip);
  await app.command(app.status.command); const panel = app.panels[0];
  await app.command(app.status.command);
  assert.equal(panel.disposed, false); assert.equal(app.panels.length, 1); assert.equal(panel.reveals, 1);
  panel.changeVisibility(false); await app.command(app.status.command);
  assert.equal(panel.disposed, false); assert.equal(panel.reveals, 2);
});

test('concurrent status button opens share the pending startup until the first panel is available', async t => {
  const gate = deferred(), app = harness(t, { theme: async (_count, icons) => { await gate.promise; return icons; } });
  const first = app.command('bitfroest.show'); let secondFinished = false;
  const second = app.command('bitfroest.show').then(() => { secondFinished = true; });
  await tick(); assert.equal(secondFinished, false); assert.equal(app.panels.length, 1);
  gate.resolve(); await Promise.all([first, second]); assert.equal(app.panels.length, 1);
});

test('active directory updates the editor title without changing VS Code settings', async t => {
  const initial = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial) });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  await panel.receive({ type: 'active-directory', path: 'C:/tmp' });
  assert.equal(panel.title, 'C:/tmp');
  await panel.receive({ type: 'active-directory', path: 'C:/temp' });
  assert.equal(panel.title, 'C:/temp');
  assert.equal(app.updateCalls.some(call => call.store === 'configuration' && call.key === 'title'), false);
});

test('generated webview sends the active tab path to the host title', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial) });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const sendTitle = async () => panel.receive(view.messages.filter(message => message.type === 'active-directory').at(-1));
  await sendTitle();
  assert.equal(panel.title, 'C:\\tmp');
  view.key('Tab');
  await sendTitle();
  assert.equal(panel.title, 'C:\\temp');
});

test('real provider deletes a streamed folder without preparation before the pending host listing completes', { timeout: 10000 }, async t => {
  const disk = require('node:fs/promises'), { createProvider } = require('../filesystem-provider');
  const root = (await disk.mkdtemp(path.join(os.tmpdir(), 'stream-delete-host-'))).replaceAll('\\', '/');
  const left = `${root}/left`, right = `${root}/right`, target = `${left}/new-folder`;
  t.after(() => disk.rm(root, { recursive: true, force: true }));
  await disk.mkdir(left); await disk.mkdir(right);
  const started = deferred(), release = deferred(), calls = [];
  t.after(() => release.resolve());
  let holding = false;
  const app = harness(t, { startupRoots: [left, right], providerFactory: creation => {
    const provider = createProvider({ ...creation, roots: [left, right], readDirectory: undefined, readAttributes: undefined, networkPaths: async () => [],
      fs: { ...disk, readdir: async (directory, ...args) => {
        assert.equal(String(directory).replaceAll('\\', '/').startsWith(target), false, 'no inventory of the deletion target');
        return disk.readdir(directory, ...args);
      } },
      deletePath: async (target, options) => { calls.push([target, options.useTrash]); await disk.rm(target, { recursive: true }); } });
    const prepare = provider.prepare;
    provider.prepare = (before, settings) => prepare(before, { ...settings, onDirectory: async update => {
      await settings.onDirectory?.(update);
      if (holding && settings.navigation && update.path === left && update.rows?.some(row => row.name === 'new-folder')) {
        holding = false; started.resolve(); await release.promise;
      }
    } });
    return provider;
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const initial = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html }).state();
  await disk.mkdir(`${target}/nested`, { recursive: true }); await disk.writeFile(`${target}/nested/keep.txt`, 'fixture'); holding = true;
  let listingDone = false;
  const listing = panel.receive({ type: 'filesystem-navigate', navigationRequestId: 'directory-101', side: 0, path: left, state: initial }).finally(() => { listingDone = true; });
  await started.promise;
  assert.equal(listingDone, false);
  assert.ok(panel.messages.some(message => message.type === 'filesystem-directory' && message.rows?.some(row => row.name === 'new-folder')));
  await panel.receive({ type: 'filesystem-delete', paths: [target], useTrash: false, operationId: 'delete-streamed-test', state: initial });
  assert.equal(listingDone, false);
  assert.deepEqual(calls, [[target, false]]);
  assert.equal(panel.messages.findLast(message => message.operationId === 'delete-streamed-test')?.ok, true);
  await assert.rejects(disk.lstat(target), { code: 'ENOENT' });
  release.resolve(); await listing;
  assert.equal(panel.messages.findLast(message => message.navigationRequestId === 'directory-101')?.cancelled, true);
});

test('folder tabs and their active positions survive a fresh extension instance and provider', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), { createProvider } = require('../filesystem-provider');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-restart-')), left = path.join(root, 'left').replaceAll('\\', '/'), right = path.join(root, 'right').replaceAll('\\', '/'), inactive = `${left}/nested/archive`;
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(inactive, { recursive: true }); await fs.mkdir(right);
  const options = { startupRoots: [left, right], providerFactory: creation => createProvider({ ...creation, roots: [left, right], readAttributes: undefined }) };
  const first = harness(t, options); await first.command('bitfroest.openPrototype');
  const panel = first.panels[0], view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  const panes = view.state().panes; panes[0].tabs.push(inactive); panes[1].tabs.unshift(left); panes[1].tab = 1;
  await panel.receive({ type: 'view-state', panes, active: 1 });
  const saved = JSON.parse(JSON.stringify(first.context.workspaceState.get('fileManagerState')));
  panel.dispose();
  const second = harness(t, { ...options, workspaceState: { fileManagerState: saved } }); await second.command('bitfroest.openPrototype');
  const restarted = require('./support/webview.cjs').createApp(t, undefined, { html: second.panels[0].webview.html }).state();
  assert.deepEqual(Array.from(restarted.panes[0].tabs), [left, inactive]);
  assert.deepEqual(Array.from(restarted.panes[1].tabs), [left, right]);
  assert.equal(restarted.panes[0].tab, 0); assert.equal(restarted.panes[1].tab, 1); assert.equal(restarted.active, 1);
});

test('restart preserves the active tab when multiple tabs have the same directory path', async t => {
  const saved = clipboardFixture(); saved.panes[0].tabs.push('C:/tmp'); saved.panes[0].tab = 1;
  for (const pane of saved.panes) Object.assign(pane, { filter: '', sort: 'name' });
  const app = harness(t, { workspaceState: { fileManagerState: saved }, filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.show');
  const state = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html }).state();
  assert.deepEqual(Array.from(state.panes[0].tabs), ['C:/tmp', 'C:/tmp']); assert.equal(state.panes[0].tab, 1);
});

test('a late refresh result cannot overwrite newer durably saved folder tabs', async t => {
  const initial = clipboardFixture(), gate = deferred(), started = deferred(); let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { if (++loads > 1) { started.resolve(); await gate.promise; } return structuredClone(initial); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const refresh = panel.receive({ type: 'filesystem-refresh', refreshRequestId: 'refresh-tabs', state: structuredClone(initial) });
  await started.promise;
  const panes = structuredClone(initial.panes); panes[0].tabs.push('C:/temp'); panes[0].tab = 1;
  await panel.receive({ type: 'view-state', panes, active: 1 });
  assert.equal(app.context.workspaceState.get('fileManagerState').panes[0].tab, 1);
  gate.resolve(); await refresh;
  assert.equal(panel.messages.findLast(message => message.type === 'filesystem-result').ok, true);
  const saved = app.context.workspaceState.get('fileManagerState');
  assert.deepEqual(saved.panes[0].tabs, ['C:/tmp', 'C:/temp']); assert.equal(saved.panes[0].tab, 1); assert.equal(saved.active, 1);
});

test('extension shutdown waits for queued folder-tab storage writes', async t => {
  const gate = deferred(), app = harness(t, { update: async (_store, key) => { if (key === 'fileManagerState') await gate.promise; } });
  t.after(() => gate.resolve());
  await app.command('bitfroest.show');
  const state = clipboardFixture(), write = app.panels[0].receive({ type: 'state', state }); await tick();
  let stopped = false; const shutdown = app.deactivate().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  gate.resolve(); await Promise.all([write, shutdown]);
  assert.deepEqual(app.context.workspaceState.get('fileManagerState').panes, state.panes);
});

test('a folder-tab storage error does not make shutdown wait for dismissal of its notification', async t => {
  const notice = deferred(), app = harness(t, { update: async (_store, key) => { if (key === 'fileManagerState') throw new Error('Storage unavailable'); }, showErrorMessage: () => notice.promise });
  t.after(() => notice.resolve()); await app.command('bitfroest.show');
  const write = app.panels[0].receive({ type: 'state', state: clipboardFixture() }); await tick();
  let stopped = false; const shutdown = app.deactivate().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, true); assert.ok(app.errors.some(error => error.includes('Storage unavailable')));
  notice.resolve(); await Promise.all([write, shutdown]);
});

test('a second toggle disposes the panel and clears focus contexts', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false });
  assert.equal(app.contexts.get('bitfroest.textInput'), true);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels[0].disposed, true);
  assert.equal(app.contexts.get('bitfroest.textInput'), false);
  assert.equal(app.contexts.get('bitfroest.listFocus'), false);
  assert.equal(app.status.text, '$(folder)');
});

test('a hidden existing panel is revealed without moving another editor into a new window', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  panel.changeVisibility(false);
  assert.equal(app.status.text, '$(folder)');
  await app.command('bitfroest.openPrototype');
  assert.equal(panel.reveals, 1);
  assert.equal(app.panels.length, 1);
  assert.equal(app.nativeCalls.length, 1);
  assert.equal(app.status.text, '$(folder-opened)');
});

test('overlapping opens wait for the first theme load rather than creating duplicate windows', async t => {
  const barrier = deferred(), entered = deferred();
  t.after(() => barrier.resolve());
  const app = harness(t, { theme: async (_, icons) => { entered.resolve(); await barrier.promise; return icons; } });
  const first = app.command('bitfroest.openPrototype');
  await entered.promise;
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 1);
  barrier.resolve(); await first;
  assert.equal(app.panels.filter(panel => !panel.disposed).length, 1);
});

test('the opening guard resets when theme acquisition fails', async t => {
  const app = harness(t, { theme: (count, icons) => { if (count === 1) throw new Error('Theme unavailable'); return icons; } });
  await assert.rejects(app.command('bitfroest.openPrototype'), /Theme unavailable/);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.filter(panel => !panel.disposed).length, 1);
});

test('native maximization failures are reported without abandoning the usable panel', async t => {
  const app = harness(t, { nativeError: 'Window not found' });
  await app.command('bitfroest.openPrototype');
  assert.match(app.errors[0], /Window not found/);
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Arbeitsbereich');
  assert.equal(app.panels[0].disposed, false);
});

test('window setup diagnostics retain the native failure and the affected panel identity', async t => {
  const logs = [];
  const details = { stage: 'confirm-title', handle: '1234', processId: 42, visible: true, maximized: true };
  const failure = Object.assign(new Error('Window action failed.'), { code: 'NativeFailure', nativeCode: 1400,
    operation: 'windows.maximize', requestId: 7n, generation: 3n, details });
  const app = harness(t, { native: callback => callback(failure), onLog: (_name, _config, line) => logs.push(JSON.parse(line)) });
  await app.command('bitfroest.openPrototype');
  const event = logs.find(row => row.kind === 'error' && row.operation === 'window-setup');
  assert.equal(event.code, 'NativeFailure');
  assert.equal(event.nativeCode, 1400);
  assert.equal(event.nativeOperation, 'windows.maximize');
  assert.equal(event.requestId, '7');
  assert.equal(event.generation, '3');
  assert.deepEqual(event.details, details);
  assert.match(event.titleToken, /^[a-f0-9-]{36}$/);
  assert.equal(event.panelDisposed, false);
  assert.equal(app.panels[0].disposed, false);
  app.panels[0].dispose();
});

test('a failed window command does not launch a native helper', async t => {
  const app = harness(t, { commandError: 'workbench.action.moveEditorToNewWindow' });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.nativeCalls.length, 0);
  assert.match(app.errors[0], /moveEditorToNewWindow/);
});

test('non-Windows startup has no native process side effects or support popups', async t => {
  const app = harness(t, { platform: 'linux' });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.nativeCalls.length, 0);
  assert.equal(app.information.length, 0);
});

test('disposing a panel during native setup does not revive its title or entry', async t => {
  let complete;
  const app = harness(t, { native: callback => { complete = callback; } });
  const pending = app.command('bitfroest.openPrototype');
  await tick();
  app.panels[0].dispose();
  complete(null, '', '');
  await pending;
  assert.equal(app.status.text, '$(folder)');
  assert.equal(app.panels[0].disposed, true);
});

test('F4 opens a retained document in the main window without changing the auxiliary window', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const before = app.calls.length;
  await app.panels[0].receive({ type: 'edit', content: 'example', language: 'typescript' });
  assert.equal(app.textDocuments.length, 1);
  assert.equal(app.textDocuments[0].content, 'example');
  assert.equal(app.textDocuments[0].language, 'plaintext');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
  assert.notEqual(app.textEditors[0].options.viewColumn, -2);
  assert.equal(app.calls.slice(before).some(call => /Window|Compact/.test(call.id)), false);
  assert.equal(app.panels[0].disposed, false);
});

test('F4 from the generated file manager HTML opens the selected source as a retained main-window tab', async t => {
  const state = clipboardFixture();
  state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => state });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.click(view.row('a.txt').querySelector('[data-filename]'));
  const start = app.calls.length;
  view.key('F4');
  const edits = view.messages.filter(message => message.type === 'edit');
  assert.equal(edits.length, 1); assert.equal(edits[0].path, 'C:/tmp/a.txt');
  await panel.receive(edits[0]);
  assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/a.txt');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
  assert.deepEqual(app.openCalls, []);
  assert.equal(app.calls.slice(start).some(call => /Window|Compact/.test(call.id)), false);
  assert.equal(panel.disposed, false);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

for (const editor of [false, true]) for (const gesture of ['double-click', 'Enter']) {
  test(`${gesture} opens the activated file using its ${editor ? 'associated editor' : 'external application'}`, async t => {
    const state = clipboardFixture();
    state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
    state.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', fsSource: 'C:/tmp/b.txt' });
    state.panes[0].selected = ['b'];
    const app = harness(t, { filesystemLoad: async () => state, associatedEditor: editor });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
    const row = view.row('a.txt');
    view.click(row.querySelector('[data-filename]'), { ctrlKey: true });
    if (gesture === 'Enter') view.key('Enter', {}, row.closest('.list'));
    else {
      view.click(view.row('a.txt').querySelector('[data-filename]'), { ctrlKey: true, detail: 2 });
      view.row('a.txt').dispatchEvent(new view.window.MouseEvent('dblclick', { bubbles: true, button: 0, ctrlKey: true, detail: 2 }));
    }
    const messages = view.messages.filter(message => ['open', 'edit', 'preview'].includes(message.type));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'open');
    assert.equal(messages[0].path, 'C:/tmp/a.txt');
    const start = app.calls.length;
    await panel.receive(messages[0]);
    assert.deepEqual(app.openCalls, ['C:/tmp/a.txt']);
    assert.equal(app.textDocuments.length, editor ? 1 : 0);
    if (editor) {
      assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/a.txt');
      assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
    }
    assert.equal(app.calls.slice(start).some(call => /Window|Compact/.test(call.id)), false);
  });
}

test('file activation rejects unlisted paths and reports launch failures without opening an editor', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), openError: 'Launch failed' });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  for (const target of [undefined, 'C:/tmp/missing.txt', 'C:/private.txt', 'C:/tmp']) await panel.receive({ type: 'open', path: target });
  assert.deepEqual(app.openCalls, []);
  await panel.receive({ type: 'open', path: 'C:/tmp/a.txt' });
  assert.deepEqual(app.openCalls, ['C:/tmp/a.txt']);
  assert.ok(app.errors.some(message => message.includes('Launch failed')));
  assert.equal(app.textDocuments.length, 0);
});

test('Enter activates an unmarked cursor file while another file remains marked', async t => {
  const state = clipboardFixture();
  state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  state.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', fsSource: 'C:/tmp/b.txt' });
  state.panes[0].selected = ['b']; state.panes[0].cursor = 'a';
  const app = harness(t, { filesystemLoad: async () => state });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.key('Enter', {}, view.row('a.txt').closest('.list'));
  const messages = view.messages.filter(message => message.type === 'open');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].path, 'C:/tmp/a.txt');
  assert.deepEqual(view.state().panes[0].selected, ['b']);
  await panel.receive(messages[0]);
  assert.deepEqual(app.openCalls, ['C:/tmp/a.txt']);
});

test('markdown preview opens a document in the same group then invokes its renderer', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'preview', content: '# Title', language: 'markdown' });
  assert.equal(app.textDocuments[0].language, 'markdown');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 3, preview: false });
  const preview = app.calls.find(call => call.id === 'markdown.showPreview');
  assert.equal(preview.args[0], app.textDocuments[0].uri);
});

test('plain previews use the active group fallback if no column is available', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  app.panels[0].viewColumn = undefined;
  await app.panels[0].receive({ type: 'preview', content: 'plain' });
  assert.deepEqual(app.textEditors[0].options, { viewColumn: -1, preview: false });
});

test('unknown messages and invalid document payloads cannot open editors', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  for (const message of [null, {}, { type: 'unrelated' }, { type: 'edit', content: 12 }, { type: 'preview', content: 'x'.repeat(100001) }]) await app.panels[0].receive(message);
  assert.equal(app.textDocuments.length, 0);
});

test('input focus messages update both independent context guards', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: false, list: true });
  assert.equal(app.contexts.get('bitfroest.textInput'), false);
  assert.equal(app.contexts.get('bitfroest.listFocus'), true);
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false });
  assert.equal(app.contexts.get('bitfroest.textInput'), true);
  assert.equal(app.contexts.get('bitfroest.listFocus'), false);
});

test('registered file actions are inert without a panel and forwarded when one exists', async t => {
  const app = harness(t);
  await app.command('bitfroest.copy');
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.copy');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'action', action: 'copy' });
});

test('real directories replace stored example contents on opening', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'snapshot-1', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real });
  await app.command('bitfroest.openPrototype');
  assert.match(app.panels[0].webview.html, /snapshot-1/);
  assert.match(app.panels[0].webview.html, /realFilesystem/);
});

test('real filesystem changes are committed before a fresh snapshot is returned', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const applied = [];
  const app = harness(t, { filesystemLoad: async () => real, filesystemApply: async (before, after) => { applied.push([before, after]); return { ...after, snapshotId: 'two' }; } });
  await app.command('bitfroest.openPrototype');
  const after = structuredClone(real); after.folders['C:/tmp'].push({ id: 'new', name: 'new', type: 'folder' }); after.folders['C:/tmp/new'] = [];
  await app.panels[0].receive({ type: 'filesystem-apply', state: after });
  assert.equal(applied.length, 1);
  assert.equal(app.panels[0].messages.at(-1).state.snapshotId, 'two');
});

test('filesystem errors restore a fresh directory view and report failure', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real, filesystemApply: async () => { throw new Error('Target changed'); } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-apply', state: real });
  assert.match(app.panels[0].messages.at(-1).error, /Target changed/);
  assert.deepEqual(app.errors, []);
  assert.equal(app.panels[0].messages.at(-1).type, 'filesystem-result');
  assert.equal(app.panels[0].messages.at(-1).ok, false);
});

test('structured recovery failures reach notifications and the webview in the interface language with unchanged paths', async t => {
  const { createOperationError } = require('../operation-errors');
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  real.panes.forEach(pane => Object.assign(pane, { selected: [], cursor: null, filter: '', sort: 'name' }));
  const recoveryPath = 'C:/tmp/Neuer Ordner/Dateioperation fehlgeschlagen.stage';
  const failure = createOperationError('recovery-incomplete', { cause: new Error('Sicherungsdatei extern verändert.'), paths: [recoveryPath] });
  const app = harness(t, { language: 'en', filesystemLoad: async () => real, filesystemApply: async () => { throw failure; } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-apply', state: real });
  const result = app.panels[0].messages.at(-1);
  assert.equal(result.ok, false);
  assert.match(result.error, /Recovery is incomplete/);
  assert.match(result.error, /A backup file changed externally/);
  assert.ok(result.error.includes(recoveryPath));
  assert.deepEqual(app.errors, []);
  const view = require('./support/webview.cjs').createApp(t, real, { html: app.panels[0].webview.html });
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.ok(view.document.querySelector('.operation-error-text').value.includes(recoveryPath));
  assert.match(view.document.querySelector('#status-message').textContent, /Recovery is incomplete/);
});

test('workspace state is restored into the HTML safely and saved serially', async t => {
  const gate = deferred(); let held = false;
  const initial = { name: '<folder> "quoted" & safe' };
  const app = harness(t, {
    workspaceState: { fileManagerState: initial },
    update: async (store, key) => { if (store === 'workspace' && key === 'fileManagerState' && !held) { held = true; await gate.promise; } }
  });
  await app.command('bitfroest.openPrototype');
  assert.ok(app.panels[0].webview.html.includes('&lt;folder>'));
  assert.ok(app.panels[0].webview.html.includes('&quot;'));
  const first = app.panels[0].receive({ type: 'state', state: { order: 1 } });
  const second = app.panels[0].receive({ type: 'state', state: { order: 2 } });
  await tick();
  assert.equal(app.updateCalls.filter(call => call.key === 'fileManagerState').length, 1);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(app.context.workspaceState.get('fileManagerState'), { order: 2 });
  assert.equal(app.context.globalState.get('fileManagerState'), undefined);
});

test('a storage error is reported and later state saves can recover', async t => {
  let fail = true;
  const app = harness(t, { update: async () => { if (fail) { fail = false; throw new Error('Storage unavailable'); } } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'state', state: { order: 1 } });
  await app.panels[0].receive({ type: 'state', state: { order: 2 } });
  assert.match(app.errors[0], /Storage unavailable/);
  assert.deepEqual(app.context.workspaceState.get('fileManagerState'), { order: 2 });
});

test('workspace and global modes use separate mementos and restore the chosen layout', async t => {
  const local = { source: 'workspace' }, shared = { source: 'global' };
  const app = harness(t, { workspaceState: { fileManagerState: local }, globalState: { fileManagerState: shared }, choices: ['global', 'workspace'] });
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.context.workspaceState.get('tabScope'), 'global');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Global');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'restore', resetViews: true, state: shared });
  await app.panels[0].receive({ type: 'state', state: { source: 'global-updated' } });
  assert.deepEqual(app.context.globalState.get('fileManagerState'), { source: 'global-updated' });
  assert.deepEqual(app.context.workspaceState.get('fileManagerState'), local);
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Arbeitsbereich');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'restore', resetViews: true, state: local });
});

test('first use of another mode copies the current layout, including when closed', async t => {
  const local = { source: 'current' };
  const app = harness(t, { workspaceState: { fileManagerState: local }, choices: ['global'] });
  await app.command('bitfroest.chooseTabMode');
  assert.deepEqual(app.context.globalState.get('fileManagerState'), local);
  assert.equal(app.panels.length, 0);
});

test('cancelled or unchanged tab-mode choices do not write storage', async t => {
  const app = harness(t, { choices: [undefined, 'workspace'] });
  await app.command('bitfroest.chooseTabMode');
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.updateCalls.length, 0);
  assert.equal(app.quickPicks[1].items[0].description, 'Aktiv');
});

test('an empty window defaults to global mode and respects a stored scope preference', async t => {
  const app = harness(t, { noWorkspace: true, globalState: { fileManagerState: { shared: true } } });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Global');
  await app.panels[0].receive({ type: 'state', state: { shared: 'updated' } });
  assert.deepEqual(app.context.globalState.get('fileManagerState'), { shared: 'updated' });
});

test('stored global preference wins even when a workspace is open', async t => {
  const app = harness(t, { workspaceState: { tabScope: 'global' }, choices: ['workspace'] });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Global');
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.quickPicks[0].items[1].description, 'Aktiv');
});

test('only an icon-theme configuration change rebuilds an open panel', async t => {
  const app = harness(t);
  await app.configuration('workbench.iconTheme');
  assert.equal(app.panels.length, 0);
  await app.command('bitfroest.openPrototype');
  await app.configuration('editor.fontSize');
  assert.equal(app.panels.length, 1);
  await app.configuration('workbench.iconTheme');
  assert.equal(app.panels.length, 2);
  assert.equal(app.panels[0].disposed, true);
});

test('activation leaves closed panels closed in production and development with saved tabs', async t => {
  for (const development of [false, true]) {
    let loads = 0;
    const app = harness(t, { development, workspaceState: { fileManagerState: clipboardFixture() }, filesystemLoad: async () => { loads++; return clipboardFixture(); } });
    await tick();
    assert.equal(app.panels.length, 0);
    assert.equal(loads, 0);
    assert.ok(app.serializer);
    assert.ok(manifest.activationEvents.includes('onWebviewPanel:bitfroestPrototype'));
    await app.command('bitfroest.openPrototype');
    app.panels[0].dispose();
    assert.equal(app.panels.filter(panel => !panel.disposed).length, 0);
  }
});

test('restart rehydrates the existing panel with fresh lists and working host events', async t => {
  const saved = clipboardFixture(); saved.active = 1;
  for (const pane of saved.panes) Object.assign(pane, { filter: '', sort: 'name' });
  const fresh = clipboardFixture(); fresh.folders['C:/tmp'][0].name = 'fresh.txt';
  const app = harness(t, { manualReadiness: true, workspaceState: { fileManagerState: saved }, filesystemLoad: async () => fresh });
  const panel = app.restoredPanel();
  panel.active = true;
  assert.equal(panel.visible, true);
  assert.equal(panel.active, true);
  assert.ok(app.serializer, 'restart requires a registered serializer');
  await app.restore(panel, saved);
  assert.equal(app.panels.length, 1);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.ok(panel.webview.options.localResourceRoots.length >= 1);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  assert.deepEqual(app.nativeCalls.map(call => call.operation), process.platform === 'win32' ? ['windows.maximize'] : []);
  if (process.platform === 'win32') assert.match(app.nativeCalls[0].titleToken, /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(panel.title, /\[[a-f0-9-]{36}\]/);
  const view = require('./support/webview.cjs').createApp(t, saved, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.ok([...view.document.scripts].every(script => script.nonce));
  assert.ok(view.document.querySelector('[data-pane="0"] [data-cell][title="fresh.txt"]'));
  assert.equal(view.document.querySelector('.pane.active').dataset.pane, '1');
  for (const message of view.messages) await panel.receive(message);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  assert.equal(app.nativeCalls.length, process.platform === 'win32' ? 1 : 0, 'webview readiness does not repeat window setup');
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.moveEditorToNewWindow').length, 0, 'restoration keeps its existing window');
  await app.command('bitfroest.refresh');
  assert.equal(panel.messages.at(-1).type, 'action');
  assert.equal(panel.messages.at(-1).action, 'refresh');
  await app.command('bitfroest.openPrototype');
  assert.equal(panel.disposed, true);
});

test('restoration renders before directory and theme loading and then initializes the same panel', async t => {
  const loading = deferred(), theme = deferred();
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise, theme: async (_attempt, icons) => { await theme.promise; return icons; } });
  const panel = app.restoredPanel();
  const restoring = app.restore(panel, null);
  assert.match(panel.webview.html, /id="host-startup"/);
  assert.equal(panel.webview.options.enableScripts, true);
  const { JSDOM } = require('jsdom'), vm = require('node:vm');
  const shell = new JSDOM(panel.webview.html, { runScripts: 'outside-only' });
  t.after(() => shell.window.close());
  const shellMessages = [];
  shell.window.acquireVsCodeApi = () => ({ postMessage: message => shellMessages.push(message) });
  const script = shell.window.document.querySelector('script');
  assert.ok(shell.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes(`'nonce-${script.nonce}'`));
  new vm.Script(script.textContent).runInContext(shell.getInternalVMContext());
  await tick();
  assert.ok(shellMessages.some(message => message.type === 'startup-diagnostic' && message.event.name === 'document-start'));
  const shellReady = shellMessages.find(message => message.type === 'host-startup-ready');
  assert.ok(shellReady);
  await panel.receive(shellReady);
  assert.match(panel.messages.at(-1).message, /Startverzeichnisse werden eingelesen/);
  shell.window.dispatchEvent(new shell.window.MessageEvent('message', { data: panel.messages.at(-1) }));
  assert.match(shell.window.document.querySelector('[role="status"]').textContent, /Startverzeichnisse werden eingelesen/);
  shell.window.document.getElementById('host-startup-copy').click();
  assert.equal(shellMessages.at(-1).type, 'startup-log-copy');
  await panel.receive(shellMessages.at(-1));
  assert.ok(app.clipboardCalls.some(call => call.action === 'writeText'));
  loading.resolve(clipboardFixture()); await tick();
  assert.match(panel.messages.at(-1).message, /Datei-Icon-Theme wird geladen/);
  theme.resolve(); await restoring;
  assert.equal(app.panels.length, 1);
  assert.doesNotMatch(panel.webview.html, /id="host-startup"/);
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  assert.equal(view.messages.filter(message => message.type === 'app-ready').length, 1);
  panel.dispose();
});

test('restoration releases the editor attachment before directory loading finishes', async t => {
  const loading = deferred();
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise });
  const panel = app.restoredPanel();
  let attached = false;
  Promise.resolve(app.serializer.deserializeWebviewPanel(panel, null)).then(() => { attached = true; });
  await tick();
  assert.equal(attached, true, 'the editor cannot attach its webview until deserialization returns');
  assert.match(panel.webview.html, /id="host-startup"/);
  loading.resolve(clipboardFixture()); await app.command('bitfroest.show');
  panel.dispose();
});

test('host startup diagnostics can be copied while directory loading blocks the webview', async t => {
  const loading = deferred(), info = [];
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise, onInfoLog: message => info.push(message) });
  const panel = app.restoredPanel();
  const opening = app.restore(panel, null);
  await tick();
  assert.ok(app.commands.has('bitfroest.copyStartupLog'));
  const contribution = manifest.contributes.commands.find(command => command.command === 'bitfroest.copyStartupLog');
  assert.ok(contribution);
  assert.equal(contribution.enablement, undefined, 'diagnostics remain available before readiness');
  await app.command('bitfroest.copyStartupLog');
  const report = JSON.parse(app.clipboardCalls.find(call => call.action === 'writeText').text);
  assert.equal(report.extensionVersion, manifest.version);
  assert.equal(report.webviewReady, false);
  assert.equal(report.startup.restored, true);
  assert.match(report.events.at(-1).message, /Startverzeichnisse werden eingelesen/);
  assert.ok(report.runtime.node);
  assert.ok(info.some(message => message.includes('Startverzeichnisse werden eingelesen')));
  assert.ok(app.information.some(message => /kopiert/.test(message)));
  loading.resolve(clipboardFixture()); await opening; await app.command('bitfroest.show'); panel.dispose();
});

test('startup document events persist with identity and reject stale or oversized messages', async t => {
  const logs = [], errors = [], loading = deferred();
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise, onInfoLog: line => logs.push(JSON.parse(line)), onLog: (_name, _config, line) => errors.push(JSON.parse(line)) });
  const panel = app.restoredPanel(); const opening = app.restore(panel, null);
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(panel.webview.html); t.after(() => dom.window.close());
  const { startupId, documentId } = dom.window.document.documentElement.dataset;
  assert.ok(documentId);
  const message = { type: 'startup-diagnostic', version: 1, startupId, documentId, sequence: 1, event: { name: 'document-start', elapsed: 3, readyState: 'loading', visibility: 'visible' } };
  await panel.receive(message);
  assert.equal(logs.filter(row => row.kind === 'webview-event').length, 1);
  await panel.receive(message);
  await panel.receive({ ...message, sequence: 2, documentId: 'old' });
  await panel.receive({ ...message, sequence: 2, event: { ...message.event, message: 'x'.repeat(40000) } });
  assert.equal(logs.filter(row => row.kind === 'webview-event').length, 1);
  assert.ok(logs.every(row => row.startupId && Number.isSafeInteger(row.sequence) && Number.isFinite(row.elapsed)));
  loading.resolve(clipboardFixture()); await opening; await app.command('bitfroest.show');
  const full = new JSDOM(panel.webview.html); t.after(() => full.window.close());
  const fullId = full.window.document.documentElement.dataset.documentId;
  assert.notEqual(fullId, documentId);
  await panel.receive({ ...message, sequence: 2 });
  assert.equal(logs.filter(row => row.kind === 'webview-event').length, 1);
  for (let sequence = 1; sequence <= 513; sequence++) await panel.receive({ ...message, documentId: fullId, sequence });
  assert.equal(logs.filter(row => row.kind === 'diagnostic-limit').length, 1);
  assert.equal(logs.filter(row => row.kind === 'webview-event').length, 513);
  await panel.receive({ ...message, documentId: fullId, sequence: 514, event: { name: 'runtime-error', elapsed: 9, message: 'late exception' } });
  assert.ok(errors.some(row => row.operation === 'webview-diagnostic' && row.message === 'late exception'));
  panel.dispose();
  const count = errors.length;
  await panel.receive({ ...message, documentId: fullId, sequence: 515, event: { name: 'runtime-error', elapsed: 10, message: 'disposed' } });
  assert.equal(errors.length, count);
});

test('host diagnostics retain layout, application and failed Git message context after readiness', async t => {
  const logs = [], errors = [];
  const app = harness(t, { onInfoLog: line => logs.push(JSON.parse(line)), onLog: (_name, _config, line) => errors.push(JSON.parse(line)) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const { JSDOM } = require('jsdom'), dom = new JSDOM(panel.webview.html); t.after(() => dom.window.close());
  const { startupId, documentId } = dom.window.document.documentElement.dataset;
  await panel.receive({ type: 'startup-diagnostic', version: 1, startupId, documentId, sequence: 1,
    event: { name: 'probe-received', elapsed: 1, requestId: 'probe-1', framePending: true,
      layout: { paneCount: 2, panes: [{ rows: 4, hit: { withinPane: false, element: { id: 'cover' } } }] },
      application: { ready: true, snapshotId: 'current' } } });
  const view = logs.findLast(row => row.kind === 'webview-event');
  assert.equal(view.event.layout.panes[0].hit.element.id, 'cover');
  assert.equal(view.event.application.snapshotId, 'current');
  await panel.receive({ type: 'startup-diagnostic', version: 1, startupId, documentId, sequence: 2,
    event: { name: 'git-protocol-error', elapsed: 2, message: 'Repository check identities are missing', directory: '/repo', requestId: 'git-2',
      protocol: { repositoryChecks: { total: 3, completed: 1 } } } });
  assert.ok(errors.some(row => row.message === 'Repository check identities are missing' && row.requestId === 'git-2'));
  await panel.receive({ type: 'startup-log-copy' });
  const report = JSON.parse(app.clipboardCalls.findLast(call => call.action === 'writeText').text);
  assert.equal(report.latestBrowserState.application.snapshotId, 'current');
  assert.equal(report.firstBrowserError.message, 'Repository check identities are missing');
  panel.dispose();
});

test('diagnostic probes distinguish missing replies and stop when their panel is disposed', async t => {
  let probe;
  const deadlines = [], logs = [], interval = { unref() {} };
  const nativeInterval = global.setInterval, nativeTimeout = global.setTimeout, nativeClearTimeout = global.clearTimeout;
  t.mock.method(global, 'setInterval', (callback, delay, ...args) => {
    if (delay === 5000) { probe = callback; return interval; }
    return nativeInterval(callback, delay, ...args);
  });
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 2000) { const timer = { callback, cleared: false, unref() {} }; deadlines.push(timer); return timer; }
    return nativeTimeout(callback, delay, ...args);
  });
  t.mock.method(global, 'clearTimeout', timer => { if (deadlines.includes(timer)) timer.cleared = true; else nativeClearTimeout(timer); });
  const app = harness(t, { onInfoLog: line => logs.push(JSON.parse(line)) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  probe(); const request = panel.messages.at(-1);
  assert.equal(request.type, 'diagnostic-probe');
  await panel.receive({ ...request, type: 'startup-diagnostic', version: 1, sequence: 1,
    event: { name: 'probe-received', requestId: request.requestId, elapsed: 1 } });
  assert.equal(deadlines[0].cleared, true);
  probe(); deadlines[1].callback();
  assert.ok(logs.some(row => row.kind === 'probe-timeout' && row.documentId === request.documentId));
  panel.dispose(); const count = panel.messages.length; probe();
  assert.equal(panel.messages.length, count);
});

test('diagnostics correlate native window states with installation and consecutive application starts', async t => {
  const firstLogs = [];
  const inspect = created => async () => ({ version: 1, readOnly: true, windows: [{ processId: process.ppid, processCreated: created, identityStable: true, handle: '42', rect: { x: -5, y: 0, width: 417, height: 279 } }], truncated: false });
  const first = harness(t, { nativeInspect: inspect('1001'), onInfoLog: line => firstLogs.push(JSON.parse(line)) });
  await first.command('bitfroest.openPrototype'); await tick();
  const recorded = first.context.globalState.get('windowDiagnosticRun');
  assert.equal(recorded.processRunOrdinal, 1);
  assert.ok(firstLogs.some(row => row.kind === 'native-window-state' && row.windows[0].rect.width === 417));
  assert.ok(firstLogs.find(row => row.kind === 'runtime').build.bundleDigest);
  first.panels[0].dispose();
  const secondLogs = [];
  const second = harness(t, { globalState: { windowDiagnosticRun: recorded }, nativeInspect: inspect('1002'), onInfoLog: line => secondLogs.push(JSON.parse(line)) });
  await second.command('bitfroest.openPrototype'); await tick();
  assert.equal(second.context.globalState.get('windowDiagnosticRun').processRunOrdinal, 2);
  assert.equal(second.context.globalState.get('windowDiagnosticRun').installationId, recorded.installationId);
  assert.ok(secondLogs.some(row => row.kind === 'diagnostic-run' && row.change === 'new-process' && row.processRunOrdinal === 2));
  second.panels[0].dispose();
  const continued = second.context.globalState.get('windowDiagnosticRun');
  const third = harness(t, { globalState: { windowDiagnosticRun: continued }, nativeInspect: inspect('1002') });
  await third.command('bitfroest.openPrototype'); await tick();
  assert.equal(third.context.globalState.get('windowDiagnosticRun').processRunOrdinal, 2);
  third.panels[0].dispose();
});

test('native diagnostics survive actual facade identities and retain the browser probe identity', async t => {
  const { createNativeApi } = require('../native-api'), { inspectWindows } = require('../native-window');
  const api = createNativeApi({ apiVersion: { major: 1, minor: 4 }, capabilities: { 'windows.inspect': { status: 'supported' } },
    openSession: () => ({ generation: 9007199254740995n, close() {}, invoke: async () => ({ version: 1, readOnly: true, windows: [], truncated: false }) }) });
  t.after(() => api.shutdown());
  const logs = [], app = harness(t, { nativeInspect: () => inspectWindows({ nativeApi: api }), onInfoLog: line => logs.push(JSON.parse(line)) });
  await app.command('bitfroest.openPrototype'); await tick();
  const sample = logs.find(row => row.kind === 'native-window-state');
  assert.ok(sample, 'The real native facade result must reach the persistent log.');
  assert.equal(sample.requestId, 'startup');
  assert.equal(sample.nativeRequestId, '1');
  assert.equal(sample.nativeGeneration, '9007199254740995');
  await app.panels[0].receive({ type: 'startup-log-copy' });
  const report = JSON.parse(app.clipboardCalls.findLast(call => call.action === 'writeText').text);
  assert.equal(report.latestNativeWindowState.nativeGeneration, '9007199254740995');
  app.panels[0].dispose();
});

test('Git diagnostics preserve plan identity before filtering progress for the webview', async t => {
  const logs = [], state = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => state, onInfoLog: line => logs.push(JSON.parse(line)),
    gitInspect: async (_directories, _settings, _creation, progress) => {
      progress({ 'C:/tmp': { ok: true, loading: true, phase: 'git-dirty-check', stage: 'inspect', repositoryChecks: { paths: ['C:/tmp/a'], total: 1, completed: 0, active: null } } });
      return { 'C:/tmp': { ok: true, repository: false, statuses: {} } };
    } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'git-plan', snapshotId: state.snapshotId, directories: ['C:/tmp'] });
  const event = logs.find(row => row.kind === 'git-progress');
  assert.equal(event.requestId, 'git-plan');
  assert.deepEqual(event.directories[0].repositoryChecks.paths, ['C:/tmp/a']);
  assert.deepEqual(event.delivered, ['C:/tmp']);
  panel.dispose();
});

test('window maximization starts during loading for new and visible restored windows', async t => {
  for (const restored of [false, true]) {
    const loading = deferred();
    const app = harness(t, { filesystemLoad: () => loading.promise });
    const panel = restored ? app.restoredPanel() : null;
    const opening = restored ? app.restore(panel, null) : app.command('bitfroest.openPrototype');
    await tick();
    assert.equal(app.nativeCalls.length, 1);
    assert.match(app.panels[0].webview.html, /id="host-startup"/);
    assert.equal(app.calls.filter(call => call.id === 'workbench.action.moveEditorToNewWindow').length, restored ? 0 : 1);
    loading.resolve(clipboardFixture()); await opening; await app.command('bitfroest.show');
    assert.equal(app.nativeCalls.length, 1);
    app.panels[0].dispose();
  }
});

test('restoring an invisible file manager does not maximize its containing window', async t => {
  const loading = deferred();
  const app = harness(t, { filesystemLoad: () => loading.promise });
  const panel = app.restoredPanel(); panel.visible = false; panel.active = false;
  const opening = app.restore(panel, null); await tick();
  assert.equal(app.nativeCalls.length, 0);
  loading.resolve(clipboardFixture()); await opening;
  assert.equal(app.nativeCalls.length, 0);
  panel.dispose();
});

for (const visible of [true, false]) test(`diagnosing a restored ${visible ? 'inactive' : 'hidden'} file manager preserves its current window behaviour`, async t => {
  const logs = [], app = harness(t, { onInfoLog: line => logs.push(JSON.parse(line)) });
  const panel = app.restoredPanel(); panel.visible = visible; panel.active = false;
  await app.restore(panel, null);
  assert.equal(app.nativeCalls.length, 0);
  const html = panel.webview.html;
  panel.active = true; panel.changeVisibility(true); await tick();
  assert.equal(app.nativeCalls.length, 0);
  assert.ok(logs.some(row => row.kind === 'window-setup-deferred'));
  assert.equal(panel.webview.html, html);
  panel.active = false; panel.changeVisibility(false);
  panel.active = true; panel.changeVisibility(true); await tick();
  assert.equal(app.nativeCalls.length, 0);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  assert.equal(logs.some(row => row.kind === 'window-maximize-complete'), false);
  panel.dispose();
});

test('the full startup view copies host diagnostics before readiness and after failure', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const messages = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  dom.window.eval(dom.window.document.querySelector('script').textContent);
  const copy = dom.window.document.querySelector('#startup-log-copy');
  assert.ok(copy);
  copy.click();
  assert.equal(messages.at(-1).type, 'startup-log-copy');
  await panel.receive({ type: 'app-startup-error', diagnostic: { message: 'render failed' } });
  await panel.receive({ type: 'startup-log-copy' });
  const report = JSON.parse(app.clipboardCalls.find(call => call.action === 'writeText').text);
  assert.ok(report.events.some(event => event.message === 'render failed'));
  panel.dispose();
});

test('a startup without readiness offers host diagnostics even when no webview message arrives', async t => {
  const loading = deferred(); let watchdog;
  const original = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 15000) { watchdog = callback; return { unref() {} }; }
    return original(callback, delay, ...args);
  });
  const app = harness(t, { manualReadiness: true, filesystemLoad: () => loading.promise, showWarningMessage: (_message, action) => action });
  const panel = app.restoredPanel();
  app.serializer.deserializeWebviewPanel(panel, null);
  await tick(); watchdog(); await tick();
  assert.ok(app.errors.some(message => /noch keine Bereitschaft/.test(message)));
  const report = JSON.parse(app.clipboardCalls.find(call => call.action === 'writeText').text);
  assert.equal(report.webviewReady, false);
  assert.ok(report.events.some(event => /Startverzeichnisse werden eingelesen/.test(event.message)));
  loading.resolve(clipboardFixture()); await app.command('bitfroest.show'); panel.dispose();
});

test('startup diagnostics retain host failures and clipboard rejection never reports success', async t => {
  const app = harness(t, { theme: async () => { throw new Error('Theme fixture failed'); } });
  const panel = app.restoredPanel();
  await assert.rejects(app.restore(panel, null), /Theme fixture failed/);
  await app.command('bitfroest.copyStartupLog');
  const report = JSON.parse(app.clipboardCalls.find(call => call.action === 'writeText').text);
  assert.ok(report.events.some(event => event.kind === 'error' && event.message === 'Theme fixture failed' && event.stack));
  const failure = harness(t, { writeClipboardText: async () => { throw new Error('Clipboard busy'); } });
  assert.equal(await failure.command('bitfroest.copyStartupLog'), false);
  assert.equal(failure.information.length, 0);
  assert.match(failure.errors.at(-1), /Clipboard busy/);
});

test('closing a restored panel while directories load does not reopen it', async t => {
  const loading = deferred();
  const app = harness(t, { filesystemLoad: () => loading.promise });
  const panel = app.restoredPanel();
  assert.ok(app.serializer);
  const restoring = app.restore(panel, clipboardFixture());
  await tick(); const loadingHtml = panel.webview.html; panel.dispose(); loading.resolve(clipboardFixture()); await restoring;
  assert.equal(app.panels.length, 1);
  assert.equal(panel.webview.html, loadingHtml);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2);
});

test('failed restoration closes the unusable panel and permits a manual retry', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { if (++loads === 1) throw new Error('Unavailable'); return clipboardFixture(); } });
  const panel = app.restoredPanel();
  assert.ok(app.serializer);
  await app.restore(panel, null);
  assert.equal(panel.disposed, true);
  assert.equal(app.errors.length, 1);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
});

test('a restore delivered during manual opening leaves one initialized owner', async t => {
  const loading = deferred();
  const app = harness(t, { filesystemLoad: () => loading.promise });
  const opening = app.command('bitfroest.openPrototype');
  const restored = app.restoredPanel();
  const restoring = app.restore(restored, null);
  loading.resolve(clipboardFixture()); await opening; await restoring;
  const remaining = app.panels.filter(panel => !panel.disposed);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].webview.html, /Content-Security-Policy/);
});

test('a resource initialization failure releases the restored panel and opening guard', async t => {
  const app = harness(t, { theme: async (attempt, icons) => { if (attempt === 1) throw new Error('Theme unavailable'); return icons; } });
  const panel = app.restoredPanel();
  await assert.rejects(app.restore(panel, null), /Theme unavailable/);
  assert.equal(panel.disposed, true);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2);
});

test('native icon requests map known mock paths and return their keyed image results', async t => {
  let captured;
  const icon = 'data:image/png;base64,AA==';
  const app = harness(t, { filesystemIcons: async requests => { captured = requests; return { '/workspace/bitfroest/README.md': icon }; } });
  await app.command('bitfroest.openPrototype');
  const requests = [
    { key: '/workspace/bitfroest/README.md', path: '/workspace/bitfroest/README.md', name: 'README.md', type: 'file' },
    { key: '/home/demo/Downloads', path: '/home/demo/Downloads', name: 'Downloads', type: 'folder' },
    { key: '/home/demo/Backups/archive.zip', path: '/home/demo/Backups/archive.zip', name: 'archive.zip', type: 'file' },
    { key: '/home/demo/Downloads/demo.zip!/README.md', path: '/home/demo/Downloads/demo.zip!/README.md', name: 'README.md', type: 'file' }
  ];
  await app.panels[0].receive({ type: 'icons', requests });
  assert.ok(captured, 'The native icon provider must receive the request.');
  assert.equal(captured[0].path, path.join(root, 'workspace', 'README.md'));
  assert.equal(captured[1].path, path.join(os.homedir(), 'Downloads'));
  assert.equal(captured[2].path, path.join(os.homedir(), 'Backups', 'archive.zip'));
  assert.equal(captured[3].path, '');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'icons', icons: { '/workspace/bitfroest/README.md': icon } });
});

test('native folder icon responses retain the view generation and refresh clears cached metadata', async t => {
  let cleared = 0;
  const state = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => structuredClone(state), clearFilesystemIconCache: () => { cleared++; } });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  await panel.receive({ type: 'icons', iconGeneration: 7, requests: [{ key: 'folder', path: '/home/demo/Downloads', name: 'Downloads', type: 'folder' }] });
  assert.equal(panel.messages.at(-1).iconGeneration, 7);
  await panel.receive({ type: 'filesystem-refresh', state });
  assert.equal(cleared, 1);
});

test('native icons cannot turn remote workspace paths or arbitrary supplied paths into local reads', async t => {
  let captured;
  const app = harness(t, { workspaceScheme: 'vscode-remote', filesystemIcons: async requests => { captured = requests; return {}; } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'icons', requests: [
    { key: '/workspace/bitfroest/README.md', path: '/workspace/bitfroest/README.md', name: 'README.md', type: 'file' },
    { key: 'foreign', path: path.join(os.homedir(), 'private.txt'), name: 'private.txt', type: 'file' }
  ] });
  assert.ok(captured);
  assert.ok(captured.every(request => request.path === ''));
});

test('native icon request limits and malformed rows do not reach the provider', async t => {
  const providerCalls = [];
  const app = harness(t, { filesystemIcons: async requests => { providerCalls.push(requests); return {}; } });
  await app.command('bitfroest.openPrototype');
  const valid = { key: '/workspace/bitfroest/a.txt', path: '/workspace/bitfroest/a.txt', name: 'a.txt', type: 'file' };
  await app.panels[0].receive({ type: 'icons', requests: Array.from({ length: 129 }, () => valid) });
  await app.panels[0].receive({ type: 'icons', requests: 'invalid' });
  assert.equal(providerCalls.length, 0);
  await app.panels[0].receive({ type: 'icons', requests: [
    null, {}, { ...valid, key: 12 }, { ...valid, path: 12 }, { ...valid, name: 12 }, { ...valid, type: 'device' },
    { ...valid, name: 'x'.repeat(100000) }, { ...valid, path: 'x'.repeat(100000) }, valid
  ] });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].length, 1);
  assert.equal(providerCalls[0][0].key, valid.key);
});

test('closing or replacing the panel during lookup cannot deliver stale icon results', async t => {
  const barrier = deferred(); let started = false;
  const app = harness(t, { filesystemIcons: async () => { started = true; return barrier.promise; } });
  await app.command('bitfroest.openPrototype');
  const first = app.panels[0];
  const lookup = first.receive({ type: 'icons', requests: [{ key: '/workspace/bitfroest/a.txt', path: '/workspace/bitfroest/a.txt', name: 'a.txt', type: 'file' }] });
  await tick();
  assert.equal(started, true);
  first.dispose();
  await app.command('bitfroest.openPrototype');
  barrier.resolve({ '/workspace/bitfroest/a.txt': 'data:image/png;base64,AA==' });
  await lookup;
  assert.equal(first.messages.some(message => message.type === 'icons'), false);
  assert.equal(app.panels[1].messages.some(message => message.type === 'icons'), false);
});

test('failed icon lookup preserves fallback rendering through an empty response', async t => {
  const app = harness(t, { filesystemIcons: async () => { throw new Error('Native icon unavailable'); } });
  await app.command('bitfroest.openPrototype');
  await assert.doesNotReject(app.panels[0].receive({ type: 'icons', requests: [{ key: '/workspace/bitfroest/a.txt', path: '/workspace/bitfroest/a.txt', name: 'a.txt', type: 'file' }] }));
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'icons', icons: {} });
});

test('column settings and UI language are injected and settings changes are broadcast', async t => {
  const configuration = { 'columns.activeSet': 'custom', 'columns.sets': [{ id: 'custom', name: 'Custom', columns: [{ id: 'full', title: 'Filename', field: '[=tc.fullname]', width: 330 }] }] };
  const app = harness(t, { language: 'en-US', configuration });
  await app.command('bitfroest.openPrototype');
  const html = app.panels[0].webview.html;
  assert.match(html, /data-language="en-US"/);
  assert.match(html, /data-column-settings=/);
  assert.equal(JSON.parse(decodeURIComponent(/data-column-settings="([^"]+)"/.exec(html)[1])).sets[0].columns[0].title, 'Full filename');
  await app.configuration('bitfroest.columns');
  assert.equal(app.panels[0].messages.at(-1).type, 'column-settings');
  assert.equal(app.panels[0].messages.at(-1).settings.activeSet, 'custom');
});

test('native column tables reach the webview on startup and after configuration changes', async t => {
  const configuration = { 'columns.names': { reports: 'Reports' }, 'columns.fields': { 'reports.file': '[=tc.fullname]' }, 'columns.titles': { 'reports.file': 'My heading' }, 'columns.widths': { 'reports.file': 350 }, 'columns.activeSet': 'reports' };
  const app = harness(t, { language: 'en', configuration });
  await app.command('bitfroest.openPrototype');
  const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
  const settings = JSON.parse(decodeURIComponent(encoded));
  assert.equal(settings.sets[0].columns[0].title, 'Full filename');
  assert.equal(settings.sets[0].columns[0].width, 120);
  const { createApp } = require('./support/webview.cjs');
  const view = createApp(t, null, { html: app.panels[0].webview.html });
  assert.equal(view.document.querySelector('[data-sort="file"]').textContent, 'Full filename');
  const automaticWidth = view.grid().getColumn('file').getActualWidth();
  assert.ok(automaticWidth > 0);
  configuration['columns.widths']['reports.file'] = 450;
  await app.configuration('bitfroest.columns');
  assert.equal(app.panels[0].messages.at(-1).settings.sets[0].columns[0].width, 120);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: app.panels[0].messages.at(-1) }));
  assert.ok(view.grid().getColumn('file').getActualWidth() > 0);
  assert.equal(app.updateCalls.filter(call => call.store === 'configuration').length, 0);
});

test('short default column headers reach generated host HTML in both settings paths', async t => {
  const layout = require('../media/commander-column-settings').catalog.map(column => ({ id: column.id, title: 'Old custom title', align: column.align, visible: column.visible }));
  for (const configuration of [{}, { 'columns.visibility': { 'standard.name': true } }, { 'columns.layout': layout }]) {
    const app = harness(t, { language: 'en', configuration });
    await app.command('bitfroest.openPrototype');
    const { createApp } = require('./support/webview.cjs');
    const view = createApp(t, null, { html: app.panels[0].webview.html });
    assert.equal(view.document.querySelector('[data-sort="type"]').textContent, 'Ext.');
    assert.equal(view.document.querySelector('[data-sort="attributes"]'), null);
    assert.equal(view.state().panes[0].columns.find(column => column.key === 'attributes').label, 'Attr.');
  }
});

test('default column tables follow the extension language and ignore saved headings', async t => {
  for (const [language, expected] of [['de', 'Größe'], ['en', 'Size']]) {
    const app = harness(t, { language: 'en', configuration: { language } });
    await app.command('bitfroest.openPrototype');
    const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
    assert.equal(JSON.parse(decodeURIComponent(encoded)).sets[0].columns.find(column => column.id === 'size').title, expected);
  }
  const app = harness(t, { language: 'en', configuration: { 'columns.titles': { 'standard.size': 'Eigene Größe' } } });
  await app.command('bitfroest.openPrototype');
  const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).sets[0].columns.find(column => column.id === 'size').title, 'Size');
});

test('default tables do not replace saved legacy sets until a new table is explicitly configured', async t => {
  const configurationDefaults = Object.fromEntries(Object.entries(Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties))).filter(([key]) => key.startsWith('bitfroest.columns.')).map(([key, schema]) => [key.slice('bitfroest.'.length), schema.default]));
  const configuration = { 'columns.sets': [{ id: 'legacy', name: 'Legacy', columns: [{ id: 'own', title: 'Saved title', field: '[=tc.name]' }] }] };
  const app = harness(t, { configuration, configurationDefaults });
  await app.command('bitfroest.openPrototype');
  const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).sets[0].id, 'legacy');
  configuration['columns.names'] = { standard: 'Standard' };
  await app.configuration('bitfroest.columns');
  assert.equal(app.panels[0].messages.at(-1).settings.sets[0].id, 'standard');
  assert.equal(configuration['columns.sets'][0].columns[0].title, 'Saved title');
});

test('real editor requests open the source URI and reject untrusted paths without dummy documents', async t => {
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [{ id: 'source', name: 'real.txt', type: 'text', fsSource: 'C:/tmp/real.txt' }], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'edit', path: 'C:/tmp/real.txt', content: '' });
  assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/real.txt');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
  for (const bad of ['C:/secret.txt', 'C:/tmp/not-in-snapshot.txt', undefined]) {
    await app.panels[0].receive({ type: 'edit', path: bad, content: 'dummy' });
  }
  assert.equal(app.textDocuments.length, 1);
});

test('host errors use the selected display language', async t => {
  const app = harness(t, { language: 'en', filesystemLoad: async () => { throw new Error('ENOENT'); } });
  await app.command('bitfroest.openPrototype');
  assert.match(app.errors[0], /Test directories could not be loaded/);
});

test('real filesystem persistence stores the layout without file contents or source snapshots', async t => {
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'sensitive-snapshot', folders: { 'C:/tmp': [{ id: 'a', name: 'secret.txt', content: 'sensitive-content', fsSource: 'C:/tmp/secret.txt' }], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => structuredClone(real) });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'state', state: real });
  const persisted = app.context.workspaceState.values.get('fileManagerState');
  assert.deepEqual(persisted.panes, real.panes); assert.equal(persisted.realFilesystem, true);
  assert.equal(persisted.folders, undefined); assert.equal(persisted.snapshotId, undefined);
  assert.equal(JSON.stringify(persisted).includes('sensitive-content'), false);
});

test('real URI editor requests accept large text previews without applying the mock document limit', async t => {
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [{ id: 'source', name: 'large.txt', fsSource: 'C:/tmp/large.txt' }], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real }); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'edit', path: 'C:/tmp/large.txt', content: 'x'.repeat(100001) });
  assert.equal(app.textDocuments.length, 1); assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/large.txt');
});

function lazyState() {
  return {version:1,realFilesystem:true,snapshotId:'one',active:0,unloadedFolders:['C:/tmp/docs'],folders:{'C:/tmp':[{id:'docs',name:'docs',type:'folder',fsSource:'C:/tmp/docs'}],'C:/tmp/docs':[],'C:/temp':[]},panes:[{tabs:['C:/tmp'],tab:0,selected:['docs'],cursor:'docs'},{tabs:['C:/temp'],tab:0,selected:[]}]};
}

test('initial view without saved tabs loads the configured roots instead of deferring them', async t => {
  const loads = [];
  const app = harness(t, { filesystemLoad: async settings => { loads.push(settings); return lazyState(); } });
  await app.command('bitfroest.openPrototype');
  assert.equal(loads[0]?.visibleOnly, undefined);
});
test('lazy navigation prepares only its requested directory and resumes the original pane', async t => {
  const state = lazyState(), preparations=[];
  const app = harness(t,{filesystemLoad:async()=>state,filesystemPrepare:async(before,options)=>{preparations.push({before,options});await options.onDirectory({path:'C:/tmp/docs',names:['a.txt'],rows:[],completed:0,total:1});await options.onDirectory({path:'C:/tmp/docs',rows:[{id:'a',name:'a.txt'}],completed:1,total:1});return {...state,snapshotId:'two',unloadedFolders:[],folders:{...state.folders,'C:/tmp/docs':[{id:'a',name:'a.txt'}]}};}});
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({type:'filesystem-navigate',navigationRequestId:'directory-progress-1',path:'C:/tmp/docs',side:0,state});
  const {onDirectory,getVisibleDirectories,...settings}=preparations[0].options;
  assert.equal(typeof onDirectory,'function');
  assert.deepEqual(getVisibleDirectories(), ['C:/tmp/docs','C:/temp']);
  assert.deepEqual(settings,{directories:['C:/tmp/docs'],recursive:false,navigation:true,visibleDirectories:['C:/tmp/docs','C:/temp']});
  const progress=app.panels[0].messages.filter(message=>message.type==='filesystem-directory');
  assert.deepEqual(progress.map(message=>[message.completed,message.total]),[[0,1],[1,1]]);
  assert.equal(preparations[0].before.snapshotId,'one');
  const response=app.panels[0].messages.at(-1); assert.equal(response.ok,true); assert.deepEqual(response.resumeNavigation,{path:'C:/tmp/docs',side:0}); assert.equal(response.state.snapshotId,'two');
});
test('folder action preparation is recursive and preserves the pending action without mutating', async t => {
  const state=lazyState(), preparations=[]; let applied=false;
  const app=harness(t,{filesystemLoad:async()=>state,filesystemPrepare:async(before,options)=>{preparations.push(options);return {...before,snapshotId:'two',unloadedFolders:[]};},filesystemApply:async()=>{applied=true;}});
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({type:'filesystem-prepare',paths:['C:/tmp/docs'],action:'delete',state});
  assert.deepEqual(preparations,[{directories:['C:/tmp/docs'],recursive:true}]); assert.equal(applied,false); assert.equal(app.panels[0].messages.at(-1).resumeAction,'delete');
});
test('refresh reloads only active folder tabs and defers inactive tabs without reading them', async t => {
  const state=lazyState(); state.panes[0].tabs.push('C:/tmp/docs'); const loads=[];
  const app=harness(t,{filesystemLoad:async options=>{loads.push(options);return state;}});
  await app.command('bitfroest.openPrototype'); await app.panels[0].receive({type:'filesystem-refresh',state});
  const options = loads.at(-1);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(options,{signal:options.signal,directories:['C:/tmp','C:/temp'],deferredDirectories:['C:/tmp/docs'],visibleOnly:true});
});

test('disposing the panel aborts its active refresh without publishing a late filesystem result', { timeout: 5000 }, async t => {
  const state = lazyState(), entered = deferred();
  let signal;
  const app = harness(t, { filesystemLoad: async options => {
    if (!options?.signal) return state;
    signal = options.signal;
    const cancelled = new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Refresh cancelled'), { name: 'AbortError' })), { once: true }));
    entered.resolve();
    await cancelled;
    return state;
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  t.after(() => panel.dispose());
  const start = panel.messages.length;
  const pending = panel.receive({ type: 'filesystem-refresh', state });
  await entered.promise;
  assert.equal(signal.aborted, false);
  panel.dispose(); await pending;
  assert.equal(signal.aborted, true);
  assert.equal(panel.messages.slice(start).filter(message => message.type === 'filesystem-result').length, 0);
  assert.deepEqual(app.errors, []);
});


test('tab scope picker uses the selected display language',async t=>{
 const app=harness(t,{language:'en'});await app.command('bitfroest.chooseTabMode');
 assert.equal(app.quickPicks[0].items[0].label,'Workspace');assert.equal(app.quickPicks[0].items[0].description,'Active');assert.equal(app.quickPicks[0].options.title,'Save folder tabs');
});

test('reopening waits for an in-flight preparation before loading the replacement window snapshot',async t=>{
 const state=lazyState(),pending=deferred();let loads=0;
 const app=harness(t,{filesystemLoad:async()=>({...state,snapshotId:`load-${++loads}`}),filesystemPrepare:()=>pending.promise});
 await app.command('bitfroest.openPrototype');const old=app.panels[0];const preparing=old.receive({type:'filesystem-prepare',paths:['C:/tmp/docs'],action:'copy',state});await tick();old.dispose();
 const reopening=app.command('bitfroest.openPrototype');await tick();assert.equal(loads,1);assert.equal(app.panels.length,2);assert.match(app.panels[1].webview.html,/host-startup/);
 pending.resolve({...state,snapshotId:'prepared',unloadedFolders:[]});await preparing;await reopening;
 assert.equal(loads,2);assert.equal(old.messages.some(message=>message.type==='filesystem-result'),false);assert.match(app.panels[1].webview.html,/load-2/);
});


test('generated host HTML exposes confirmed context deletion without a trash preference', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], html = panel.webview.html;
  assert.match(html, /Content-Security-Policy/); assert.match(html, /script-src 'nonce-[^']+'/);
  const settings = JSON.parse(decodeURIComponent(/data-file-settings="([^"]+)"/.exec(html)[1]));
  assert.equal(Object.hasOwn(settings, 'deleteToTrash'), false);
  const view = require('./support/webview.cjs').createApp(t, initial, { html });
  view.row('a.txt').dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  view.click(view.document.querySelector('[data-context-action="delete"]'));
  assert.equal(view.document.querySelector('#modal').open, true);
  assert.equal(view.messages.some(message => message.type === 'filesystem-delete'), false);
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = view.messages.find(message => message.type === 'filesystem-delete');
  assert.equal(request.useTrash, true); assert.deepEqual(Array.from(request.paths), ['C:/tmp/a.txt']);
});

test('generated host HTML confirms mapped network deletion permanently before preparation', async t => {
  const initial = clipboardFixture(); initial.networkDirectories = ['C:/tmp'];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial,
    resolveUncPaths: async paths => paths.map(value => value.startsWith('Z:') ? '//server/share' : value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.deepEqual(await app.providerOptions.networkPaths(['Z:/', 'C:/']), ['Z:/']);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt'));
  view.key('Delete');
  assert.equal(view.document.querySelector('#modal-confirm').textContent, 'Endgültig löschen');
  assert.match(view.document.querySelector('#modal-description').textContent, /Netzwerk/);
  assert.equal(view.messages.some(message => message.type === 'filesystem-prepare'), false);
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(view.messages.find(message => message.type === 'filesystem-delete').useTrash, false);
});

test('network delete offers a localized permanent confirmation and cancellation', async t => {
  let accept = false;
  const app = harness(t, { language: 'en',
    resolveUncPaths: async paths => paths.map(value => value.startsWith('Z:') ? '//server/share/file' : value),
    showWarningMessage: (message, options, action) => {
      assert.equal(message, 'These network paths cannot be moved to the local Recycle Bin. Delete them permanently?');
      assert.equal(options.modal, true); assert.equal(options.detail, 'Z:/file');
      assert.equal(action, 'Delete permanently'); return accept ? action : undefined;
    }
  });
  const paths = ['Z:/file', 'C:/file'];
  await assert.rejects(app.providerOptions.prepareDelete(paths, true), { name: 'AbortError' });
  accept = true;
  assert.deepEqual(await app.providerOptions.prepareDelete(paths, true), ['Z:/file']);
});

test('real delete passes useTrash explicitly to the VS Code filesystem adapter', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'delete', folders: { 'C:/tmp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real, filesystemRemove: async (before, request, options) => { await options.deletePath(request.paths[0], { useTrash: request.useTrash, recursive: true }); return real; } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-delete', paths: ['C:/tmp/a.txt'], useTrash: true, state: real });
  assert.equal(app.deleteCalls.length, 1);
  assert.equal(app.deleteCalls[0].uri.fsPath, 'C:/tmp/a.txt');
  assert.deepEqual(app.deleteCalls[0].options, { recursive: true, useTrash: true });
  assert.equal(app.panels[0].messages.at(-1).ok, true);
});

test('a partial native delete failure reports its completed count in the interface language', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'delete', folders: { 'C:/tmp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { language: 'en', filesystemLoad: async () => real, filesystemRemove: async () => {
    const error = new Error('internal', { cause: new Error('Die native Löschfunktion ist nicht verfügbar.') }); error.deletedCount = 1; throw error;
  } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-delete', paths: ['C:/tmp/a.txt'], useTrash: true, state: real });
  assert.match(app.panels[0].messages.at(-1).error, /Deletion failed after 1 items: Native file deletion is not available\./);
  assert.deepEqual(app.errors, []);
  assert.equal(app.panels[0].messages.at(-1).ok, false);
});

test('conflict comparison opens validated real resources in the existing diff group without preview documents',async t=>{
 const state=lazyState();state.folders['C:/tmp'].push({id:'source',name:'source.bin',fsSource:'C:/tmp/source.bin',type:'binary'});state.folders['C:/temp']=[{id:'target',name:'target.bin',fsSource:'C:/temp/target.bin',type:'binary'}];
 const app=harness(t,{filesystemLoad:async()=>state});await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'compare',sourcePath:'C:/tmp/source.bin',targetPath:'C:/temp/target.bin'});
 const command=app.calls.find(call=>call.id==='vscode.diff');assert.ok(command);assert.equal(command.args[0].scheme,'bitfroest-conflict');assert.equal(command.args[1].scheme,'bitfroest-conflict');assert.deepEqual(app.readonlyPaths,['C:/temp/target.bin','C:/tmp/source.bin']);assert.deepEqual(command.args[3],{viewColumn:3,preview:false});assert.equal(app.textDocuments.length,0);
 for(const message of [{type:'compare',sourcePath:'C:/secret',targetPath:'C:/temp/target.bin'},{type:'compare',sourcePath:'C:/tmp/missing',targetPath:'C:/temp/target.bin'},{type:'compare',sourcePath:'C:/tmp/docs',targetPath:'C:/temp/target.bin'}])await app.panels[0].receive(message);
 assert.equal(app.calls.filter(call=>call.id==='vscode.diff').length,1);
});
test('conflict shortcut context is distinct from list focus and is cleared when the panel closes',async t=>{
 const app=harness(t);await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'inputFocus',value:true,list:false,conflict:true});assert.equal(app.contexts.get('bitfroest.conflictDialog'),true);app.panels[0].dispose();assert.equal(app.contexts.get('bitfroest.conflictDialog'),false);
 const binding=manifest.contributes.keybindings.find(item=>item.command==='bitfroest.conflict-compare');assert.ok(binding);assert.match(binding.when,/bitfroest.conflictDialog/);assert.doesNotMatch(binding.when,/listFocus|!bitfroest.textInput/);
});
test('transfer name shortcuts have a separate text-field context and clear it on disposal', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false, transferName: true });
  assert.equal(app.contexts.get('bitfroest.transferNameInput'), true);
  for (const key of ['f5', 'f6']) {
    const binding = manifest.contributes.keybindings.find(item => item.key === key && item.command === 'bitfroest.transfer-name-parts');
    assert.ok(binding);
    assert.equal(binding.when.replace(/ && !bitfroest\.shortcutOverride\.[a-z0-9]+$/, ''), 'activeWebviewPanelId == bitfroestPrototype && webviewFocus && bitfroest.transferNameInput && bitfroest.textInput');
    assert.match(binding.when, / && !bitfroest\.shortcutOverride\.[a-z0-9]+$/);
  }
  app.command('bitfroest.transfer-name-parts');
  assert.ok(app.panels[0].messages.some(item => item.type === 'action' && item.action === 'transfer-name-parts'));
  const startBinding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.transfer-name-start');
  assert.equal(startBinding?.key, 'ctrl+home'); assert.match(startBinding.when, /bitfroest.transferNameInput/);
  app.command('bitfroest.transfer-name-start'); assert.equal(app.panels[0].messages.at(-1).action, 'transfer-name-start');
  app.panels[0].dispose(); assert.equal(app.contexts.get('bitfroest.transferNameInput'), false);
});
test('other file-dialog fields consume plain function keys only inside their own webview', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false, dialog: true, transferName: false });
  assert.equal(app.contexts.get('bitfroest.fileDialog'), true);
  for (const key of ['f5', 'f6']) {
    const binding = manifest.contributes.keybindings.find(item => item.key === key && item.command === 'bitfroest.ignore-dialog-function-key');
    assert.equal(binding?.when, 'activeWebviewPanelId == bitfroestPrototype && webviewFocus && bitfroest.fileDialog && !bitfroest.transferNameInput');
  }
  await app.command('bitfroest.ignore-dialog-function-key');
  app.panels[0].dispose(); assert.equal(app.contexts.get('bitfroest.fileDialog'), false);
});
test('inline Shift F6 has its own text-input context and is cleared on disposal', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false, inlineRename: true });
  assert.equal(app.contexts.get('bitfroest.inlineRenameInput'), true);
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.rename-one' && item.when.includes('inlineRenameInput'));
  assert.equal(binding?.key, 'shift+f6'); assert.match(binding.when, /activeWebviewPanelId == bitfroestPrototype && webviewFocus/);
  app.panels[0].dispose(); assert.equal(app.contexts.get('bitfroest.inlineRenameInput'), false);
});
test('trash opening is requested only by the current visible panel without filesystem mutations', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'open-trash', path: 'C:/untrusted' }); assert.deepEqual(app.trashCalls, ['open']);
  assert.equal(panel.messages.at(-1).type, 'open-trash-result'); assert.equal(panel.messages.at(-1).ok, true); assert.equal(app.deleteCalls.length, 0);
  panel.visible = false; await panel.receive({ type: 'open-trash' }); assert.equal(app.trashCalls.length, 1);
  panel.dispose(); await panel.receive({ type: 'open-trash' }); assert.equal(app.trashCalls.length, 1);
});
test('trash opening errors are localized and forwarded as persistent UI failures', async t => {
  const app = harness(t, { language: 'en', trashError: 'Der Papierkorb konnte nicht geöffnet werden.' }); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'open-trash' });
  assert.equal(app.panels[0].messages.at(-1).ok, false); assert.equal(app.panels[0].messages.at(-1).error, 'The trash could not be opened.');
  assert.equal(app.errors.at(-1), 'The trash could not be opened.');
});
test('closing the requesting panel prevents late trash-launch results from reviving its UI', async t => {
  for (const ok of [true, false]) {
    const pending = deferred(), app = harness(t, { trashOpen: () => pending.promise }); await app.command('bitfroest.openPrototype');
    const panel = app.panels[0], request = panel.receive({ type: 'open-trash' }); panel.dispose();
    if (ok) pending.resolve({ requested: true }); else pending.reject(new Error('Blocked'));
    await request; assert.equal(panel.messages.some(item => item.type === 'open-trash-result'), false); assert.equal(app.errors.length, 0);
  }
});
test('right-drop choices use a native localized picker with only copy, move and cancellation', async t => {
  for (const action of ['copy', 'move', 'cancel', undefined]) {
    const app = harness(t, { language: 'en', choices: [action] }); await app.command('bitfroest.openPrototype');
    await app.panels[0].receive({ type: 'choose-drop-action', requestId: 'right-drop-1' });
    assert.deepEqual(app.quickPicks.at(-1).items.map(item => item.label), ['Copy here', 'Move here', 'Cancel']);
    assert.deepEqual(app.panels[0].messages.at(-1), { type: 'drop-action-result', requestId: 'right-drop-1', action: action || 'cancel' });
    assert.equal(app.deleteCalls.length, 0);
    const count = app.quickPicks.length; await app.panels[0].receive({ type: 'choose-drop-action', requestId: '../bad' }); assert.equal(app.quickPicks.length, count);
  }
});

test('file clipboard writes only snapshot-backed paths and returns its native ticket', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'one', paths: ['C:/outside/private.txt'], mode: 'copy' });
  assert.equal(app.clipboardCalls.length, 0);
  await panel.receive({ type: 'clipboard-write', requestId: 'two', paths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(app.clipboardCalls.length, 1);
  assert.equal(panel.messages.at(-1).selection.token, 'clip-1');
  assert.equal(panel.messages.at(-1).requestId, 'two');
});

test('file clipboard cut acknowledgement requires a real host commit and exact remaining sources', async t => {
  const state = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => state, clipboardSelection: { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'native-one' }, filesystemApply: async (before, after) => after });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-read', requestId: 'read' });
  const request = { type: 'clipboard-ack', requestId: 'ack', token: 'native-one', paths: ['C:/tmp/a.txt'], mode: 'move', remainingPaths: [] };
  await panel.receive(request);
  assert.equal(app.clipboardCalls.filter(call => call.action === 'ack').length, 0);
  const after = structuredClone(state); after.folders['C:/tmp'] = []; after.folders['C:/temp'] = [{ id: 'copy', name: 'a.txt', type: 'text', fsSource: 'C:/temp/a.txt' }];
  await panel.receive({ type: 'filesystem-apply', state: after });
  await panel.receive(request);
  assert.equal(app.clipboardCalls.filter(call => call.action === 'ack').length, 1);
  assert.equal(panel.messages.at(-1).matched, true);
});

test('file clipboard errors cannot report successful system export', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), clipboardError: 'Clipboard busy' });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'clipboard-write', requestId: 'busy', paths: ['C:/tmp/a.txt'], mode: 'copy' });
  assert.equal(app.panels[0].messages.at(-1).ok, false);
  assert.match(app.panels[0].messages.at(-1).error, /Clipboard busy/);
});

for (const includeMode of [false, true]) test(`copy errors preserve the exact rejected source identity in host diagnostics (mode: ${includeMode})`, async t => {
  const expected = { dev: '1', ino: '2', ...(includeMode ? { mode: '33206' } : {}), size: '1024', mtimeNs: '100', ctimeNs: '200' }, observed = { ...expected, ...(includeMode ? { mode: '33060' } : {}), ctimeNs: '300' };
  const failure = Object.assign(new Error('The source changed before copying.'), { code: 'IdentityChanged', outcome: { status: 'unchanged', copied: false, sourceIdentity: { expected, observed } } });
  const initial = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => initial, filesystemApply: async () => { throw failure; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt').querySelector('[data-filename]')); view.action('copy');
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const request = view.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
  await panel.receive(request);
  const response = panel.messages.findLast(message => message.type === 'filesystem-result');
  assert.equal(response.ok, false);
  assert.deepEqual(response.diagnostic.failure.sourceIdentity, { expected, observed, differingFields: [...(includeMode ? ['mode'] : []), 'ctimeNs'] });
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response })); await tick();
  for (const key of Object.keys(expected)) assert.ok(view.document.querySelector('.operation-error-text').value.includes(`${key}: Erwartet=${expected[key]}, Gelesen=${observed[key]}`));
  assert.match(view.document.querySelector('.operation-error-text').value, /ctimeNs: Erwartet=200, Gelesen=300/);
  assert.ok(view.row('a.txt'));
});

test('native file clipboard failures retain the operation and error code for diagnostics', async t => {
  const failure = Object.assign(new Error('Windows file clipboard operation failed.'), { code: 'InvalidRequest', nativeCode: -2147024809, operation: 'clipboard.writeFiles' });
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), clipboardFactory: () => ({ write: async () => { throw failure; }, dispose() {} }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'native-clipboard-error', paths: ['C:/tmp/a.txt'], mode: 'copy' });
  const response = panel.messages.at(-1);
  assert.equal(response.ok, false);
  assert.equal(response.diagnostic.failure.nativeCode, '-2147024809');
  assert.equal(response.diagnostic.failure.operation, 'clipboard.writeFiles');
  assert.equal(response.diagnostic.failure.code, 'InvalidRequest');
});

test('clipboard commands and shortcuts are registered only for focused file lists', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  for (const [action,key] of [['clipboard-copy','c'],['clipboard-cut','x'],['clipboard-paste','v']]) {
    const binding = manifest.contributes.keybindings.find(item => item.command === `bitfroest.${action}`);
    assert.equal(binding.key, `ctrl+${key}`); assert.equal(binding.mac, `cmd+${key}`);
    assert.match(binding.when, /bitfroest.listFocus/); assert.match(binding.when, /!bitfroest.textInput/);
    await app.command(`bitfroest.${action}`);
    assert.equal(app.panels[0].messages.at(-1).action, action);
  }
});

test('conflict previews and diff use read-only filesystem resources instead of editable original URIs',async t=>{
 const state=lazyState();state.folders['C:/tmp'].push({id:'file',name:'file.txt',type:'text',fsSource:'C:/tmp/file.txt'});state.folders['C:/temp']=[{id:'target',name:'target.txt',type:'text',fsSource:'C:/temp/target.txt'}];
 const app=harness(t,{filesystemLoad:async()=>state});await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'conflict-preview',path:'C:/tmp/file.txt',language:'plaintext'});assert.equal(app.calls.find(call=>call.id==='vscode.open').args[0].scheme,'bitfroest-conflict');assert.equal(app.textDocuments.length,0);
 await app.panels[0].receive({type:'compare',sourcePath:'C:/tmp/file.txt',targetPath:'C:/temp/target.txt'});const command=app.calls.find(call=>call.id==='vscode.diff');assert.equal(command.args[0].scheme,'bitfroest-conflict');assert.equal(command.args[1].scheme,'bitfroest-conflict');assert.deepEqual(app.readonlyPaths,['C:/tmp/file.txt','C:/temp/target.txt','C:/tmp/file.txt']);
});

test('binary conflict previews use the native resource opener rather than forcing text documents',async t=>{
 const state=lazyState();state.folders['C:/tmp'].push({id:'binary',name:'file.bin',type:'binary',fsSource:'C:/tmp/file.bin'});const app=harness(t,{filesystemLoad:async()=>state});await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'conflict-preview',path:'C:/tmp/file.bin',language:'plaintext'});
 const opened=app.calls.find(call=>call.id==='vscode.open');assert.ok(opened);assert.equal(opened.args[0].scheme,'bitfroest-conflict');assert.deepEqual(opened.args[1],{viewColumn:3,preview:false});assert.equal(app.textDocuments.length,0);
});

test('transfer cancellation interrupts the running job and forwards only its actual outcome', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  let operation, release;
  const outcome = { cancelled: true, completedIds: ['one'], completedSourcePaths: ['C:/tmp/a'] };
  const app = harness(t, { filesystemLoad: async () => real, filesystemApply: async (_before, after, options) => { operation = options; options?.onProgress?.(progressSample({ completedBytes: 3, totalBytes: 10 })); await new Promise(resolve => { release = resolve; }); return { ...after, operationOutcome: outcome }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-apply', operationId: 'job-1', transfer: { mode: 'copy', sourcePath: 'C:/tmp', ids: ['one'], sourceSide: 0 }, state: real });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(operation?.signal);
  await panel.receive({ type: 'filesystem-cancel', operationId: 'old-job' }); assert.equal(operation.signal.aborted, false);
  await panel.receive({ type: 'filesystem-cancel', operationId: 'job-1' }); assert.equal(operation.signal.aborted, true);
  release(); await pending;
  assert.deepEqual(panel.messages.at(-1).operationOutcome, outcome);
  assert.equal(panel.messages.at(-1).operationId, 'job-1');
  const count = panel.messages.length; operation.onProgress({ completedBytes: 9 }); assert.equal(panel.messages.length, count);
});

test('preparation has progress and a cancellable job before applying any mutation', async t => {
  let operation;
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemPrepare: async (_before, settings) => {
    operation = settings;
    settings.onProgress?.(progressSample({ phase: 'preparing', filesScanned: 3 }));
    await new Promise((resolve, reject) => settings.signal?.addEventListener('abort', () => { const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }));
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-prepare', operationId: 'prepare-1', paths: ['C:/tmp'], action: 'copy', state: clipboardFixture() });
  await tick();
  assert.ok(operation.signal);
  assert.equal(panel.messages.at(-1).type, 'filesystem-progress');
  await panel.receive({ type: 'filesystem-cancel', operationId: 'prepare-1' }); await pending;
  const result = panel.messages.at(-1);
  assert.equal(result.cancelled, true); assert.equal(result.ok, true);
  assert.equal(result.resumeAction, undefined); assert.deepEqual(app.errors, []);
});

test('failed preparation acknowledges and releases the filesystem queue without a blocking native popup', async t => {
  let releaseError;
  const failure = Object.assign(new Error('Preparation failed'), { code: 'FolderChangedDuringScan', path: 'C:/tmp', scanPhase: 'readdir', expectedDirectory: '{"ino":"1"}', observedDirectory: '{"ino":"2"}', changedFields: 'ino', cause: Object.assign(new Error('Directory changed'), { code: 'ESTALE', path: 'C:/tmp', scanPhase: 'stat', stack: 'cause stack' }) });
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemPrepare: async () => { throw failure; }, showErrorMessage: () => new Promise(resolve => { releaseError = resolve; }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-prepare', operationId: 'prepare-failure', snapshotId: 'clipboard', paths: ['C:/tmp'], action: 'copy', state: clipboardFixture() });
  await tick();
  assert.equal(panel.messages.at(-1)?.type, 'filesystem-result');
  assert.equal(panel.messages.at(-1)?.operationId, 'prepare-failure');
  assert.deepEqual(panel.messages.at(-1)?.diagnostic.request, { type: 'filesystem-prepare', paths: ['C:/tmp'], action: 'copy', operationId: 'prepare-failure', snapshotId: 'clipboard' });
  assert.deepEqual(panel.messages.at(-1)?.diagnostic.panelPaths, ['C:/tmp', 'C:/temp']);
  assert.ok(Number.isFinite(Date.parse(panel.messages.at(-1)?.diagnostic.timestamp)));
  assert.equal(panel.messages.at(-1)?.diagnostic.architecture, process.arch);
  assert.equal(panel.messages.at(-1)?.diagnostic.osRelease, require('node:os').release());
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.code, 'FolderChangedDuringScan');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.scanPhase, 'readdir');
  for (const key of ['expectedDirectory', 'observedDirectory', 'changedFields']) assert.equal(panel.messages.at(-1)?.diagnostic.failure[key], failure[key]);
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.cause.code, 'ESTALE');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.cause.path, 'C:/tmp');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.cause.stack, 'cause stack');
  assert.equal(panel.messages.at(-1)?.diagnostic.runtimeVersion, process.version);
  assert.equal(app.errors.length, 0, 'the webview owns persistent operation error reporting');
  const refresh = panel.receive({ type: 'filesystem-refresh', state: clipboardFixture() });
  await refresh;
  releaseError?.();
  await pending;
});

test('host progress bounds intermediate messages and always forwards the completed byte count', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemApply: async (_before, after, operation) => {
    for (let completedBytes = 0; completedBytes < 1000; completedBytes++) operation.onProgress(progressSample({ phase: 'copying', completedBytes, totalBytes: 1000 }));
    operation.onProgress(progressSample({ phase: 'published', completedBytes: 1000, totalBytes: 1000 }));
    return after;
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'filesystem-apply', operationId: 'progress-1', transfer: { mode: 'copy' }, state: clipboardFixture() });
  const progress = panel.messages.filter(message => message.type === 'filesystem-progress');
  assert.ok(progress.length <= 3, `unbounded messages: ${progress.length}`);
  assert.equal(progress[0].progress.completedBytes, 0);
  assert.equal(progress.at(-1).progress.completedBytes, 1000);
});

test('Unix folder inspection is enabled and uses validated direct selection without a Windows shell popup', async t => {
  const command = manifest.contributes.commands.find(command => command.command === 'bitfroest.inspect-folder-locks');
  assert.ok(command.enablement.includes('isLinux') && command.enablement.includes('isMac'));
  assert.ok(manifest.contributes.menus['webview/context'].some(item => item.command === command.command && item.when.includes('webviewSection == folder')));
  const opened = [];
  const app = harness(t, { platform: 'linux', filesystemLoad: async () => { const state = clipboardFixture(); state.folders['C:/tmp'][0] = { id: 'a', name: 'target', type: 'folder', fsSource: 'C:/tmp/target' }; return state; }, lockInspectorOpen: folder => opened.push(folder) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /data-platform="linux"/);
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard', inspectLocks: true });
  assert.deepEqual(opened, ['C:/tmp/target']); assert.equal(app.shellCalls.length, 0);
});

test('folder lock menu choice opens the integrated inspector for the snapshot directory without a shell refresh', async t => {
  const opened = []; let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; const state = clipboardFixture(); state.folders['C:/tmp'][0] = { id: 'a', name: 'target', type: 'folder', fsSource: 'C:/tmp/target' }; return state; }, lockInspectorOpen: folder => opened.push(folder), shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false, action: 'inspect-locks' }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.deepEqual(opened, ['C:/tmp/target']); assert.equal(loads, 1);
  assert.equal(panel.messages.at(-1).refreshed, false);
});

test('native shell menus resolve only a current frozen selection and refresh after an invoked action', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { const state = clipboardFixture(); if (++loads > 1) { state.snapshotId = 'fresh'; state.folders['C:/tmp'][0].size = 42; } return state; }, shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard', keyboard: true, paths: ['C:/private/arbitrary'] });
  assert.equal(app.shellCalls.length, 1); assert.deepEqual(app.shellCalls[0].paths, ['C:/tmp/a.txt']);
  assert.equal(app.shellCalls[0].settings.keyboard, true);
  assert.deepEqual(app.shellCalls[0].configuration.roots, ['C:/tmp', 'C:/temp']);
  assert.equal(loads, 2);
  assert.equal(panel.messages.find(message => message.type === 'restore').state.folders['C:/tmp'][0].size, 42);
  assert.deepEqual(panel.messages.at(-1), { type: 'shell-context-menu-result', requestId: 'shell-menu-1', ok: true, invoked: true, cancelled: false, refreshed: true, clipboardInvalidated: true });
  panel.dispose(); assert.equal(app.shellDisposals.length, 1);
});

test('native shell menus accept root children and reject mismatched source paths', async t => {
  const initial = clipboardFixture();
  initial.panes[0].tabs = ['C:/'];
  initial.folders['C:/'] = [
    { id: 'dell', name: 'Dell', type: 'folder', fsSource: 'C:/Dell' },
    { id: 'file', name: 'file.txt', type: 'text', fsSource: 'C:/file.txt' },
    { id: 'foreign', name: 'other', type: 'folder', fsSource: 'C:/private/other' }
  ];
  const app = harness(t, { filesystemLoad: async () => initial, containsPath: target => target.startsWith('C:/') });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const message = { type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/', snapshotId: 'clipboard' };
  await panel.receive({ ...message, ids: ['dell', 'file'] });
  assert.equal(panel.messages.at(-1).ok, true);
  assert.deepEqual(app.shellCalls[0].paths, ['C:/Dell', 'C:/file.txt']);
  await panel.receive({ ...message, requestId: 'shell-menu-2', ids: ['foreign'] });
  assert.equal(panel.messages.at(-1).ok, false);
  const diagnostic = panel.messages.at(-1).diagnostic;
  assert.equal(diagnostic.request.directory, 'C:/');
  assert.deepEqual(diagnostic.request.ids, ['foreign']);
  assert.equal(diagnostic.request.requestId, 'shell-menu-2');
  assert.equal(diagnostic.request.snapshotId, 'clipboard');
  assert.deepEqual(diagnostic.request.paths, ['C:/private/other']);
  assert.equal(diagnostic.platform, 'win32');
  assert.ok(diagnostic.failure.stack);
  assert.equal(app.shellCalls.length, 1);
});

test('native shell menus classify archive entries as unavailable without calling a native popup', async t => {
  const app = harness(t, { language: 'en', filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'zip:C%3A%2Ftmp%2Fsample.zip!/folder', ids: ['zip-entry'], snapshotId: 'clipboard' });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.equal(panel.messages.at(-1).unsupported, true);
  assert.equal(panel.messages.at(-1).error, 'This action is unavailable inside a ZIP archive.');
  assert.equal(app.shellCalls.length, 0);
});

test('native shell menus reject invalid, stale and busy requests without calling a native popup', async t => {
  const pending = deferred();
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemApply: () => pending.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const message = { type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' };
  for (const patch of [{ ids: null }, { ids: {} }, { ids: [] }, { ids: ['a', 'a'] }, { ids: ['foreign'] }, { ids: Array.from({ length: 257 }, (_, index) => String(index)) }, { directory: 'C:/private' }, { snapshotId: 'stale' }]) {
    await panel.receive({ ...message, ...patch }); assert.equal(panel.messages.at(-1).ok, false);
  }
  assert.equal(app.shellCalls.length, 0);
  const applying = panel.receive({ type: 'filesystem-apply', operationId: 'copy-1', transfer: { mode: 'copy' }, state: clipboardFixture() }); await tick();
  await panel.receive(message); assert.equal(panel.messages.at(-1).ok, false); assert.equal(app.shellCalls.length, 0);
  pending.resolve(clipboardFixture()); await applying;
  await panel.receive(message); assert.equal(app.shellCalls.length, 1); assert.equal(panel.messages.at(-1).refreshed, false);
  panel.dispose(); const count = app.shellCalls.length; await panel.receive(message); assert.equal(app.shellCalls.length, count);
});

test('native shell menus refuse remote extension execution and non-file extension resources', async t => {
  for (const options of [{ remoteName: 'ssh-remote', extensionKind: 2 }, { extensionScheme: 'vscode-remote' }]) {
    const app = harness(t, { ...options, filesystemLoad: async () => clipboardFixture() });
    await app.command('bitfroest.openPrototype');
    await app.panels[0].receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
    assert.equal(app.shellCalls.length, 0); assert.equal(app.panels[0].messages.at(-1).ok, false);
  }
});

test('the native menu keyboard command is confined to the ready Windows file list', async t => {
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.shell-context-menu');
  assert.equal(binding?.key, 'shift+f10');
  for (const guard of ['isWindows', 'bitfroest.ready', 'bitfroest.listFocus', '!bitfroest.textInput', 'webviewFocus']) assert.ok(binding.when.includes(guard));
  const app = harness(t); await app.command('bitfroest.openPrototype'); await app.command('bitfroest.shell-context-menu');
  assert.equal(app.panels[0].messages.at(-1).action, 'shell-context-menu');
});

test('native menu paths and reply identity stay frozen while a popup is pending', async t => {
  const choice = deferred();
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: async paths => { assert.equal(Object.isFrozen(paths), true); return choice.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const message = { type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard', keyboard: true };
  const pending = panel.receive(message); message.requestId = 'shell-menu-9'; message.ids[0] = 'other'; message.keyboard = false;
  choice.resolve({ ok: true, displayed: true, invoked: false, cancelled: true }); await pending;
  assert.deepEqual(app.shellCalls[0].paths, ['C:/tmp/a.txt']); assert.equal(panel.messages.at(-1).requestId, 'shell-menu-1');
  assert.equal(app.shellCalls[0].settings.keyboard, true);
});

test('native invocation invalidates a previous internal move ticket without reading the clipboard', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'export', paths: ['C:/tmp/a.txt'], mode: 'move' });
  await panel.receive({ type: 'filesystem-apply', state: clipboardFixture() });
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  await panel.receive({ type: 'clipboard-ack', requestId: 'old-ack', token: 'clip-1', paths: ['C:/tmp/a.txt'], remainingPaths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.deepEqual(app.clipboardCalls.map(call => call.action), ['write']);
});

test('an uncertain native menu failure refreshes metadata and cannot report an invoked action as success', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, shellMenuShow: async () => { throw new Error('Native process failed after invocation'); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.equal(loads, 2); assert.equal(panel.messages.at(-1).ok, false);
  assert.equal(panel.messages.at(-1).refreshed, true); assert.equal(panel.messages.at(-1).clipboardInvalidated, true);
  assert.match(panel.messages.at(-1).error, /Native process failed/);
});

test('a cancelled native command refreshes possible partial changes without reporting failure', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, shellMenuShow: async () => ({ ok: true, displayed: true, invoked: false, cancelled: true, refreshRequired: true }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-2', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  const reply = panel.messages.at(-1);
  assert.equal(loads, 2);
  assert.equal(reply.ok, true);
  assert.equal(reply.cancelled, true);
  assert.equal(reply.invoked, false);
  assert.equal(reply.refreshed, true);
  assert.equal(reply.clipboardInvalidated, true);
  assert.equal(reply.error, undefined);
});

test('native menu diagnostics retain system codes and native request identities through causes', async t => {
  const cause = Object.assign(new Error('Native shell context menu failed.'), { code: 'NativeFailure', nativeCode: 31, nativeStage: 'IContextMenu.InvokeCommand', hresult: '0x80004005', nativeCommand: 'delete', nativeCommandId: 0 });
  const failure = Object.assign(new Error(cause.message), { code: cause.code, nativeCode: 31, operation: 'shell.showContextMenu', requestId: 2n, generation: 7n, cause });
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: async () => { throw failure; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-2', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  const diagnostic = panel.messages.at(-1).diagnostic;
  assert.equal(diagnostic.failure.nativeCode, '31');
  assert.equal(diagnostic.failure.operation, 'shell.showContextMenu');
  assert.equal(diagnostic.failure.requestId, '2');
  assert.equal(diagnostic.failure.generation, '7');
  assert.equal(diagnostic.failure.cause.nativeCode, '31');
  assert.equal(diagnostic.failure.cause.nativeStage, 'IContextMenu.InvokeCommand');
  assert.equal(diagnostic.failure.cause.hresult, '0x80004005');
  assert.equal(diagnostic.failure.cause.nativeCommand, 'delete');
  assert.equal(diagnostic.failure.cause.nativeCommandId, '0');
  assert.doesNotThrow(() => JSON.stringify(diagnostic));
});

test('delayed startup creates one initialized panel and allows retry after a loading failure', async t => {
  const loading = deferred(); let attempts = 0;
  const app = harness(t, { filesystemLoad: async () => { attempts++; if (attempts === 1) return loading.promise; return clipboardFixture(); } });
  const opening = app.command('bitfroest.openPrototype'); await tick();
  await app.command('bitfroest.openPrototype'); assert.equal(app.panels.length, 1);
  assert.match(app.panels[0].webview.html, /id="host-startup"/);
  assert.match(app.panels[0].webview.html, /id="host-startup-copy"/);
  loading.reject(new Error('Temporary load failure')); await opening;
  assert.equal(app.panels[0].disposed, true); assert.equal(app.errors.length, 1);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2); assert.match(app.panels[1].webview.html, /a.txt/);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
});

test('panel disposal aborts preparation and a replacement ignores the previous job response', async t => {
  let signal, loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, filesystemPrepare: async (_state, options) => {
    signal = options.signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }));
  } });
  await app.command('bitfroest.openPrototype'); const old = app.panels[0];
  const pending = old.receive({ type: 'filesystem-prepare', operationId: 'old-prepare', paths: ['C:/tmp'], action: 'copy', state: clipboardFixture() }); await tick();
  old.dispose(); assert.equal(signal.aborted, true);
  const reopening = app.command('bitfroest.openPrototype'); await pending; await reopening;
  assert.equal(loads, 2); assert.equal(app.panels.length, 2); assert.deepEqual(app.errors, []);
  assert.equal(old.messages.some(message => message.type === 'filesystem-result'), false);
  assert.equal(app.panels[1].messages.some(message => message.operationId === 'old-prepare'), false);
});

test('a disposed native-menu owner cannot refresh or reply into the replacement panel', async t => {
  const choice = deferred(); let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, shellMenuShow: () => choice.promise });
  await app.command('bitfroest.openPrototype'); const old = app.panels[0];
  const pending = old.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' }); await tick();
  old.dispose(); await app.command('bitfroest.openPrototype');
  choice.resolve({ ok: true, displayed: true, invoked: true, cancelled: false }); await pending;
  assert.equal(app.shellDisposals.length, 1); assert.equal(loads, 2);
  assert.equal(old.messages.some(message => message.type === 'shell-context-menu-result'), false);
  assert.equal(app.panels[1].messages.some(message => message.type === 'restore'), false);
});

test('an open native menu serializes file changes and clipboard access until it closes', async t => {
  const choice = deferred(); let applies = 0;
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: () => choice.promise, filesystemApply: async (_before, after) => { applies++; return after; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' }); await tick();
  await panel.receive({ type: 'filesystem-apply', operationId: 'blocked', state: clipboardFixture() });
  assert.equal(panel.messages.at(-1).ok, false); assert.equal(applies, 0);
  await panel.receive({ type: 'clipboard-read', requestId: 'blocked-read' });
  assert.equal(panel.messages.at(-1).ok, false); assert.deepEqual(app.clipboardCalls, []);
  choice.resolve({ ok: true, displayed: true, invoked: false, cancelled: true }); await pending;
  await panel.receive({ type: 'filesystem-apply', state: clipboardFixture() }); assert.equal(applies, 1);
});

test('a failed post-invocation reread retains the confirmed snapshot and reports the refresh failure in English', async t => {
  let loads = 0;
  const app = harness(t, { language: 'en', filesystemLoad: async () => { if (++loads > 1) throw new Error('Permission denied'); return clipboardFixture(); }, shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  const result = panel.messages.at(-1);
  assert.equal(result.ok, false); assert.equal(result.invoked, true); assert.equal(result.refreshed, false);
  assert.equal(result.clipboardInvalidated, true); assert.equal(loads, 2);
  assert.match(result.error, /Permission denied/); assert.doesNotMatch(result.error, /Systemmenü|Dateibestand|aktualisiert/);
  assert.equal(panel.messages.some(message => message.type === 'restore'), false);
});

test('language picker marks the VS Code default and reloads host HTML with the selected language', async t => {
  const app = harness(t, { language: 'de-CH', choices: ['en', 'de'] });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'choose-language' });
  const items = app.quickPicks[0].items;
  assert.equal(items.length, 2);
  assert.match(items.find(item => item.value === 'de').description, /Standard.*Visual Studio Code/);
  assert.match(items.find(item => item.value === 'de').label, /star/);
  assert.equal(app.updateCalls.at(-1).key, 'language');
  assert.equal(app.updateCalls.at(-1).value, 'en');
  await app.panels[0].receive({ type: 'language-reload' });
  assert.match(app.panels[0].webview.html, /data-language="en"/);
  assert.match(app.panels[0].webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html });
  assert.equal(view.document.documentElement.lang, 'en');
  assert.equal(view.document.querySelector('#language-toggle').getAttribute('aria-label'), 'Switch language');
  assert.equal(view.document.querySelector('#notifications-toggle').getAttribute('aria-label'), 'Notifications (0)');
  assert.ok([...view.document.scripts].every(script => script.nonce));
  await app.panels[0].receive({ type: 'app-ready' });
  await app.command('bitfroest.chooseLanguage');
  assert.equal(app.updateCalls.at(-1).value, 'auto');
});

test('saved language overrides VS Code language and picker cancellation leaves settings intact', async t => {
  const app = harness(t, { language: 'en-US', configuration: { language: 'de' } });
  await app.command('bitfroest.openPrototype');
  assert.match(app.panels[0].webview.html, /data-language="de"/);
  await app.command('bitfroest.chooseLanguage');
  assert.equal(app.updateCalls.some(call => call.store === 'configuration'), false);
  assert.match(app.quickPicks[0].items.find(item => item.value === 'en').description, /Standard/);
});

test('unsupported display languages default to English and external setting changes notify the open view', async t => {
  const configuration = {};
  const app = harness(t, { language: 'fr', configuration });
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.chooseLanguage');
  assert.match(app.quickPicks[0].items.find(item => item.value === 'en').description, /Default.*Visual Studio Code/);
  configuration.language = 'de';
  await app.configuration('bitfroest.language');
  assert.equal(app.panels[0].messages.at(-1).type, 'language-changed');
  await app.panels[0].receive({ type: 'language-reload' });
  assert.match(app.panels[0].webview.html, /data-language="de"/);
});

test('file color settings expose scalar controls and a localized table of colors', () => {
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
  const fs = require('node:fs'), path = require('node:path');
  for (const key of ['fileTypes', 'gitStatus', 'rules']) {
    const setting = properties[`bitfroest.colors.${key}`];
    assert.equal(setting.scope, 'window');
    if (key === 'rules') { assert.equal(setting.type, 'object'); assert.equal(setting.additionalProperties.type, 'string'); }
    else assert.equal(setting.type, 'boolean');
    for (const language of ['package.nls.json', 'package.nls.de.json']) assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '..', language), 'utf8'))[setting.description.replaceAll('%', '')]);
  }
});

test('branch list retains unborn and detached identities on dismissal', async t => {
  for (const result of [
    { ok: true, branch: 'future', unborn: true, names: [], remoteNames: [] },
    { ok: true, branch: null, detached: true, head: '123456789abcdef', names: ['main'], remoteNames: [] }
  ]) {
    const initial = clipboardFixture(); let writes = 0;
    const app = harness(t, { filesystemLoad: async () => initial, gitBranches: async () => result,
      filesystemApply: async before => { writes++; return before; } });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    await panel.receive({ type: 'git-status', requestId: 'branches', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
    await panel.receive({ type: 'git-branches', path: 'C:/tmp', snapshotId: initial.snapshotId });
    const pick = app.quickPicks.at(-1); assert.ok(pick);
    assert.equal(pick.items[0].label, result.branch || 'Detached HEAD 12345678');
    assert.equal(writes, 0);
    assert.equal(app.errors.length, 0);
    panel.dispose();
  }
});

test('Git host HTML limits loading placeholders to confirmed repository entries', async t => {
  const initial = clipboardFixture(), work = deferred(); let progress;
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  initial.folders['C:/tmp'].push({ id: 'repo', name: 'project', type: 'folder', fsSource: 'C:/tmp/project' });
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: (_directories, _settings, _creation, onProgress) => { progress = onProgress; return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.equal(view.document.querySelector('[data-git-placeholder]'), null);
  const pending = panel.receive(view.messages.find(message => message.type === 'git-status'));
  progress({ 'C:/tmp': { ok: true, repository: false, loading: true, loadingRepositories: ['project'], statuses: {} } });
  const deliver = message => view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
  deliver(panel.messages.filter(message => message.partial).at(-1));
  assert.ok(view.row('project').querySelector('[data-git-placeholder]'));
  assert.equal(view.row('a.txt').querySelector('[data-git-placeholder]'), null);
  work.resolve({ 'C:/tmp': { ok: true, repository: false, statuses: { project: 'clean' } } });
  await pending;
  deliver(panel.messages.filter(message => message.type === 'git-status-result' && !message.partial).at(-1));
  assert.ok(view.row('project').querySelector('[data-git-status="clean"].git-status-enter'));
  assert.equal(view.document.querySelector('[data-git-branch]'), null);
  panel.dispose();
});

test('Git host forwards early branch updates and rejects stale progress after navigation', async t => {
  const initial = clipboardFixture(), work = deferred(); let progress;
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: (_directories, _settings, _creation, onProgress) => { progress = onProgress; return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'git-status', requestId: 'early', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  assert.equal(typeof progress, 'function');
  progress({ 'C:/tmp': { ok: true, repository: true, branch: 'main', loading: true, statuses: {} } });
  assert.equal(panel.messages.find(message => message.partial)?.directories['C:/tmp'].branch, 'main');
  const count = panel.messages.filter(message => message.partial).length;
  const staleProgress = progress;
  const next = panel.receive({ type: 'git-status', requestId: 'next', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  staleProgress({ 'C:/tmp': { ok: true, repository: true, branch: 'stale', loading: true } });
  assert.equal(panel.messages.filter(message => message.partial).length, count);
  work.resolve({}); await Promise.all([pending, next]); panel.dispose();
});

test('Git host requests new directory metadata while the previous status is pending', async t => {
  const initial = clipboardFixture(), work = deferred(), requested = [];
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: (directories, _settings, _creation, progress) => { requested.push(directories); progress?.(Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, branch: 'main', loading: true }]))); return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const first = panel.receive({ type: 'git-status', requestId: 'first', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  const next = panel.receive({ type: 'git-status', requestId: 'next', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  assert.equal(requested.length, 2);
  assert.ok(panel.messages.some(message => message.partial && message.requestId === 'next'));
  work.resolve({}); await Promise.all([first, next]); panel.dispose();
});

test('F9 terminal command uses the generated host protocol and validates directories', async t => {
  const opened = [];
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial, terminalOpen: async directory => opened.push(directory) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await app.command('bitfroest.open-terminal');
  assert.ok(panel.messages.some(message => message.type === 'action' && message.action === 'open-terminal'));
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.document.querySelector('.list').focus(); view.key('F9');
  const request = view.messages.find(message => message.type === 'open-terminal'); assert.ok(request);
  await panel.receive(request);
  assert.deepEqual(opened, ['C:/tmp']);
  assert.ok(panel.messages.some(message => message.type === 'ui-action-result' && message.requestId === request.requestId && message.ok));
  for (const directory of ['C:/outside', 'zip:C:/file.zip!/', 'C:/tmp/file.txt', undefined]) {
    await panel.receive({ type: 'open-terminal', requestId: 'ui-action-20', path: directory });
    assert.equal(panel.messages.at(-1).ok, false);
  }
  assert.equal(opened.length, 1);
});

test('terminal launch failure replies without a notification dialog', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'open-terminal', path: 'C:/tmp', requestId: 'ui-action-1' });
  assert.equal(app.panels[0].messages.at(-1).ok, false);
  assert.match(app.panels[0].messages.at(-1).error, /Terminal unavailable/);
  assert.equal(app.errors.length, 0);
});

test('system context menu setting reaches host HTML, live updates and frozen clipboard commands', async t => {
  const configuration = {};
  const app = harness(t, { configuration });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const encoded = /data-file-settings="([^"]+)"/.exec(panel.webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).useSystemContextMenu, false);
  configuration['files.useSystemContextMenu'] = true;
  await app.configuration('bitfroest.files');
  assert.equal(panel.messages.filter(message => message.type === 'file-settings').at(-1).settings.useSystemContextMenu, true);
  await panel.receive({ type: 'app-ready' });
  const selection = { webviewSection: 'files', directory: 'C:/tmp', ids: ['a'], snapshotId: 'frozen' };
  await app.command('bitfroest.clipboard-copy', selection);
  assert.deepEqual(panel.messages.at(-1).contextSelection, { directory: 'C:/tmp', ids: ['a'], snapshotId: 'frozen' });
  panel.dispose();
});

test('switching from English restores German column headings across saved layouts and both panels', async t => {
  const { createApp } = require('./support/webview.cjs');
  const columns = require('../media/commander-column-settings').catalog.slice(0, 5).map(column => ({ ...column, title: ({ name: 'Name', type: 'Extension', size: 'Size', date: 'Date', attributes: 'Attributes' })[column.id] }));
  const savedLayout = columns.map(({ id, title, width, align, visible }) => ({ id, title, width, align, visible }));
  const savedTables = { 'columns.names': { standard: 'Standard' }, 'columns.fields': Object.fromEntries(columns.map(column => [`standard.${column.id}`, column.field])), 'columns.titles': Object.fromEntries(columns.map(column => [`standard.${column.id}`, column.title])) };
  for (const source of [{}, { 'columns.layout': columns }, { 'columns.layout': savedLayout }, savedTables, { 'columns.sets': [{ id: 'legacy', name: 'Legacy', columns }], 'columns.activeSet': 'legacy' }]) {
    const configuration = { ...source, language: 'en' };
    const app = harness(t, { language: 'en', configuration });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    const before = createApp(t, undefined, { html: panel.webview.html });
    assert.equal(before.document.querySelector('[data-sort="size"]').textContent, 'Size');
    const saved = before.state();
    configuration.language = 'de';
    await app.configuration('bitfroest.language');
    await panel.receive({ type: 'language-reload', state: saved });
    assert.match(panel.webview.html, /Content-Security-Policy/);
    const after = createApp(t, saved, { html: panel.webview.html });
    assert.equal(after.document.documentElement.lang, 'de');
    for (const pane of after.document.querySelectorAll('.pane')) {
      assert.deepEqual([...pane.querySelectorAll('.ag-header .ag-header-cell')].map(header => header.dataset.column), ['name', 'type', 'size', 'date']);
      assert.deepEqual([...pane.querySelectorAll('.ag-header [data-sort]')].map(button => button.textContent.replace(/ [↑↓]$/, '')), ['Name', 'Erw.', 'Größe', 'Datum']);
      const history = [...pane.querySelectorAll('.ag-header button[data-history]')];
      assert.deepEqual(history.map(button => [button.dataset.history, button.getAttribute('aria-label')]), [['back', 'Zurück'], ['forward', 'Vorwärts']]);
      assert.equal(pane.querySelectorAll('.ag-header [data-sort]').length, 4);
      assert.equal(pane.querySelectorAll('.ag-header button[data-history]').length, 2);
      assert.ok(history.every(button => !button.hasAttribute('data-sort')));
    }
    assert.equal(configuration.language, 'de');
    if (source['columns.layout']) assert.deepEqual(configuration['columns.layout'], source['columns.layout']);
    if (source['columns.titles']) assert.deepEqual(configuration['columns.titles'], source['columns.titles']);
    panel.dispose();
  }
});

test('address breadcrumbs and flat editing operate in generated host HTML with its CSP', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const section = view.document.querySelector('[data-pane="1"]');
  assert.ok(section.querySelector('[data-refresh][aria-busy="true"] .codicon-loading.codicon-modifier-spin'));
  view.click(section.querySelector('[data-path-edit]'));
  const input = view.document.activeElement;
  assert.equal(input.value, 'C:\\temp');
  assert.ok(input.closest('.path-address').classList.contains('is-editing'));
  view.key('Escape', {}, input);
  view.click(section.querySelector('[data-breadcrumb="C:/"]'), { ctrlKey: true });
  const request = view.messages.find(message => message.type === 'filesystem-navigate');
  assert.equal(request.path, 'C:/'); assert.equal(request.side, 1);
  assert.equal(view.state().panes[1].tabs.length, 1);
  panel.dispose();
});

test('column separator double-click fits the filename in generated host HTML without navigation', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const section = view.document.querySelector('[data-pane="0"]');
  for (let attempt = 0; attempt < 100 && view.grid().getGridOption('rowBuffer') !== 10; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  view.grid().setColumnWidths([{ key: 'name', newWidth: 390 }], true, 'uiColumnResized');
  section.querySelector('[col-id="name"] .ag-header-cell-resize').dispatchEvent(new view.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  for (let attempt = 0; attempt < 100 && view.grid().getGridOption('rowBuffer') !== 10; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(view.grid().getColumn('name').getActualWidth() > 0);
  assert.equal(view.messages.some(message => message.type === 'filesystem-navigate'), false);
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp');
  panel.dispose();
});

test('clipboard status uses a separate provider and preserves the active cut acknowledgement', async t => {
  const state = clipboardFixture(), instances = [];
  const app = harness(t, { filesystemLoad: async () => state, filesystemApply: async (before, after) => after,
    clipboardFactory: () => {
      const instance = { token: null, reads: 0,
        async read() { this.token = `provider-${instances.indexOf(this)}-${++this.reads}`; return { paths: ['C:/tmp/a.txt'], mode: 'move', token: this.token, source: 'system' }; },
        async ack(request) { assert.equal(request.token, this.token); return true; }, dispose() { this.disposed = true; } };
      instances.push(instance); return instance;
    } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-read', requestId: 'read' });
  const ticket = panel.messages.at(-1).selection;
  await panel.receive({ type: 'clipboard-status', requestId: 'status' });
  assert.deepEqual(panel.messages.at(-1), { type: 'clipboard-result', requestId: 'status', ok: true, available: true });
  assert.equal(instances.length, 2); assert.equal(instances[0].reads, 1); assert.equal(instances[1].reads, 1);
  assert.equal(instances[1].disposed, true); assert.equal(instances[0].disposed, undefined);
  const after = structuredClone(state); after.folders['C:/tmp'] = []; after.folders['C:/temp'] = [{ id: 'copy', name: 'a.txt', type: 'text', fsSource: 'C:/temp/a.txt' }];
  await panel.receive({ type: 'filesystem-apply', state: after });
  await panel.receive({ type: 'clipboard-ack', requestId: 'ack', ...ticket, remainingPaths: [] });
  assert.equal(panel.messages.at(-1).matched, true);
});

test('clipboard status reports an empty clipboard without a notification or command activation', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-status', requestId: 'empty' });
  assert.deepEqual(panel.messages.at(-1), { type: 'clipboard-result', requestId: 'empty', ok: true, available: false });
  assert.deepEqual(app.errors, []);
  await panel.receive({ type: 'inputFocus', list: true, paste: false });
  assert.equal(app.contexts.get('bitfroest.canPasteFiles'), false);
  await panel.receive({ type: 'inputFocus', list: true, paste: true });
  assert.equal(app.contexts.get('bitfroest.canPasteFiles'), true);
  panel.dispose(); assert.equal(app.contexts.get('bitfroest.canPasteFiles'), false);
});

test('writing copied names as text invalidates file paste availability in the existing view', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'selection-io', requestId: 'selection-1', action: 'copy', text: 'plain text' });
  assert.ok(panel.messages.some(message => message.type === 'clipboard-changed'));
});

test('right copy and left paste retain native command availability through focus and a late status reply', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  initial.folders['C:/temp'] = [{ id: 'b', name: 'right.txt', type: 'text', size: 5, content: 'right', fsSource: 'C:/temp/right.txt' }];
  const options = { filesystemLoad: async () => structuredClone(initial) };
  const app = harness(t, options);
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, structuredClone(initial), { html: panel.webview.html });
  const deliver = data => view.window.dispatchEvent(new view.window.MessageEvent('message', { data }));
  const startup = view.messages.find(message => message.type === 'clipboard-status');
  await panel.receive(startup);
  const oldStatus = panel.messages.find(message => message.type === 'clipboard-result' && message.requestId === startup.requestId);
  view.click(view.document.querySelector('[data-pane="1"] [data-file-row][data-id="b"] [data-filename]'));
  view.action('clipboard-copy');
  const write = view.messages.find(message => message.type === 'clipboard-write');
  await panel.receive(write);
  const written = panel.messages.find(message => message.type === 'clipboard-result' && message.requestId === write.requestId);
  options.clipboardSelection = written.selection;
  deliver(written);
  view.window.dispatchEvent(new view.window.Event('focus'));
  deliver({ type: 'filesystem-result', ok: true, state: structuredClone(initial) });
  const target = view.document.querySelector('[data-pane="0"] .list');
  target.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await panel.receive(view.messages.filter(message => message.type === 'inputFocus').at(-1));
  assert.equal(app.contexts.get('bitfroest.canPasteFiles'), true);
  deliver(oldStatus);
  await panel.receive(view.messages.filter(message => message.type === 'inputFocus').at(-1));
  assert.equal(app.contexts.get('bitfroest.canPasteFiles'), true);
  const refreshed = view.messages.filter(message => message.type === 'clipboard-status').at(-1);
  assert.notEqual(refreshed.requestId, startup.requestId);
  await panel.receive(refreshed);
  deliver(panel.messages.find(message => message.type === 'clipboard-result' && message.requestId === refreshed.requestId));
  await app.command('bitfroest.clipboard-paste', JSON.parse(target.dataset.vscodeContext));
  deliver(panel.messages.filter(message => message.type === 'action').at(-1));
  const read = view.messages.find(message => message.type === 'clipboard-read'); assert.ok(read);
  await panel.receive(read);
  const focusRefresh = view.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  if (view.document.querySelector('#panes').inert && focusRefresh) { await panel.receive(focusRefresh); deliver(panel.messages.filter(message => message.type === 'filesystem-result').at(-1)); }
  deliver(panel.messages.find(message => message.type === 'clipboard-result' && message.requestId === read.requestId));
  assert.equal(view.document.querySelector('#modal').open, false);
  await tick();
  const apply = view.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply, JSON.stringify({ messages: view.messages.slice(-5), status: view.document.querySelector('#status-message').textContent, dialog: view.document.querySelector('#modal-body').textContent }));
  assert.ok(apply.state.folders['C:/tmp'].some(file => file.name === 'right.txt'));
  await panel.receive(apply);
  deliver(panel.messages.filter(message => message.type === 'filesystem-result').at(-1)); await tick();
  assert.ok(view.state().folders['C:/tmp'].some(file => file.name === 'right.txt'));
  assert.equal(view.document.querySelector('#modal').open, false);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.deepEqual(app.errors, []);
  panel.dispose();
});

test('header actions and typed status operate in generated host HTML with its CSP', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const header = view.document.querySelector('.commander-header');
  assert.equal(header.querySelectorAll('#functionbar button').length, 7);
  assert.equal(header.querySelector('#functionbar').closest('[role="menubar"]'), null);
  const language = header.querySelector('#language-toggle'); language.focus(); view.key('Enter', {}, language);
  assert.equal(view.messages.at(-1).type, 'choose-language');
  const toggle = header.querySelector('#notifications-toggle'); view.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  view.key('Escape', {}, view.document.activeElement);
  assert.equal(view.document.activeElement, toggle);
  const status = view.document.querySelector('#statusbar');
  assert.equal(status.querySelector('#functionbar'), null);
  view.action('select-all');
  assert.ok(status.querySelector('[data-outcome="success"] [data-status-icon]'));
  view.action('copy');
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = view.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'filesystem-progress', operationId: request.operationId,
    progress: { path: 'C:/left/archive.zip', completedBytes: 42, totalBytes: 100, transferred: 68, total: 100 } } }));
  assert.equal(status.querySelector('#status-percent').textContent, '42%/68%');
  assert.equal(status.querySelector('#status-progress-overall').style.width, '42%');
  assert.equal(status.querySelector('#status-progress-file').style.width, '68%');
  assert.match(status.querySelector('#status-message').textContent, /archive\.zip/);
  assert.equal(status.querySelector('#status-elapsed').textContent, '00:00');
  view.click(status.querySelector('#status-cancel'));
  assert.equal(view.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
  assert.equal(status.querySelector('#status-metrics').hidden, false);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'restore', state: initial } }));
  assert.equal(status.dataset.statusProgressOwner, 'background');
  assert.equal(status.querySelector('#status-cancel').hidden, false);
  panel.dispose();
});

test('shared icon size reaches generated host HTML and changes live without navigating or restarting', async t => {
  const configuration = { 'appearance.iconSize': 28 };
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { configuration, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*icon-layout.js"/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.equal(view.document.body.style.getPropertyValue('--icon-base-size'), '28px');
  configuration['appearance.iconSize'] = 16;
  await app.configuration(['bitfroest.appearance.iconSize']);
  const update = panel.messages.filter(message => message.type === 'file-settings').at(-1);
  assert.equal(update.settings.iconSize, 16);
  const before = JSON.stringify(view.state().panes.map(p => p.tabs));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: update }));
  assert.equal(view.document.body.style.getPropertyValue('--icon-base-size'), '16px');
  assert.equal(JSON.stringify(view.state().panes.map(p => p.tabs)), before);
  panel.dispose();
});

function restoredWindowSnapshot(request, overrides = {}) {
  return { version: 1, readOnly: true, truncated: false, titleToken: request?.titleToken,
    windows: request?.titleToken ? [{ handle: '123456', processId: process.ppid, processCreated: '123456789', className: 'Chrome_WidgetWin_1', identityStable: true, visible: false, minimized: false, ...overrides }] : [] };
}

test('an identified invisible restored window reopens only its own panel before accepting file actions', async t => {
  const gate = deferred(), inspected = deferred(), logs = []; let removed = 0;
  const saved = clipboardFixture(); saved.panes[0].tabs.push('C:/temp'); saved.panes[0].tab = 1; saved.active = 1;
  const app = harness(t, { manualReadiness: true, workspaceState: { fileManagerState: saved }, filesystemLoad: async () => clipboardFixture(),
    onInfoLog: line => logs.push(JSON.parse(line)), filesystemRemove: async state => { removed++; return state; },
    nativeInspect: async request => { if (request?.titleToken) { inspected.resolve(); await gate.promise; } return restoredWindowSnapshot(request); } });
  const old = app.restoredPanel(); old.active = false;
  await app.restore(old);
  const ready = old.receive({ type: 'app-ready' });
  const duplicateReady = old.receive({ type: 'app-ready' });
  await Promise.race([inspected.promise, tick()]);
  assert.equal(app.contexts.get('bitfroest.ready'), false, 'file actions remain blocked during ownership verification');
  const deletion = old.receive({ type: 'filesystem-delete', paths: ['C:/tmp/a.txt'], operationId: 'before-window-verification', state: saved });
  await tick();
  assert.equal(removed, 0);
  gate.resolve(); await Promise.all([ready, duplicateReady, deletion]);
  assert.equal(old.disposed, true);
  assert.equal(app.panels.length, 2);
  const replacement = app.panels[1];
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.moveEditorToNewWindow').length, 1);
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: replacement.webview.html });
  assert.deepEqual(Array.from(view.state().panes[0].tabs), ['C:/tmp', 'C:/temp']);
  assert.equal(view.state().panes[0].tab, 1); assert.equal(view.state().active, 1);
  await replacement.receive({ type: 'app-ready' });
  await old.receive({ type: 'app-ready' });
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  assert.equal(app.panels.length, 2, 'a fresh panel cannot repeat the restoration recovery');
  assert.ok(logs.some(row => row.kind === 'window-recovery-start' && row.handle === '123456'));
  assert.ok(logs.some(row => row.kind === 'window-recovery-opened'));
  assert.equal(app.updateCalls.some(call => call.store === 'configuration'), false);
  replacement.dispose();
});

test('a visible restored window is retained and its temporary title marker is removed', async t => {
  let checks = 0;
  const app = harness(t, { manualReadiness: true, nativeInspect: async request => { if (request?.titleToken) checks++; return restoredWindowSnapshot(request, { visible: true }); } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel); await panel.receive({ type: 'app-ready' }); await panel.receive({ type: 'app-ready' });
  assert.equal(checks, 1);
  assert.equal(app.panels.length, 1); assert.equal(panel.disposed, false);
  assert.doesNotMatch(panel.title, /\[[a-f0-9-]{36}\]/);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  panel.dispose();
});

test('window recovery rejects a foreign process, changed identity, minimized window and ambiguous result', async t => {
  for (const override of [{ processId: process.ppid + 100000 }, { identityStable: false }, { minimized: true }, { ambiguous: true }]) {
    const app = harness(t, { manualReadiness: true, nativeInspect: async request => {
      const result = restoredWindowSnapshot(request, override);
      if (override.ambiguous && result.windows.length) result.windows.push({ ...result.windows[0], handle: '654321' });
      return result;
    } });
    const panel = app.restoredPanel(); panel.active = false;
    await app.restore(panel); await panel.receive({ type: 'app-ready' });
    assert.equal(app.panels.length, 1); assert.equal(panel.disposed, false);
    panel.dispose();
  }
});

test('closing a restored panel during ownership verification prevents a late replacement', async t => {
  const gate = deferred(), checked = deferred();
  const app = harness(t, { manualReadiness: true, nativeInspect: async request => {
    if (request?.titleToken) { checked.resolve(); await gate.promise; }
    return restoredWindowSnapshot(request);
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel);
  const ready = panel.receive({ type: 'app-ready' });
  await Promise.race([checked.promise, tick()]);
  panel.dispose(); gate.resolve(); await ready;
  assert.equal(app.panels.length, 1);
  assert.equal(app.contexts.get('bitfroest.ready'), false);
});

test('a restored window made visible before confirmation is retained', async t => {
  let checks = 0;
  const app = harness(t, { manualReadiness: true, nativeInspect: async request => {
    if (request?.titleToken) checks++;
    return restoredWindowSnapshot(request, { visible: checks >= 2 });
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel); await panel.receive({ type: 'app-ready' });
  assert.equal(checks, 2); assert.equal(app.panels.length, 1); assert.equal(panel.disposed, false);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  panel.dispose();
});

test('an unavailable scoped inspection retains the restored panel and records its limitation', async t => {
  const logs = [];
  const app = harness(t, { manualReadiness: true, onInfoLog: line => logs.push(JSON.parse(line)), nativeInspect: async request => {
    if (request?.titleToken) throw Object.assign(new Error('Inspection unavailable'), { code: 'UnsupportedOperation' });
    return restoredWindowSnapshot(request);
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel); await panel.receive({ type: 'app-ready' });
  assert.equal(panel.disposed, false); assert.equal(app.panels.length, 1);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  assert.ok(logs.some(row => row.kind === 'window-recovery-error' && row.code === 'UnsupportedOperation'));
  assert.doesNotMatch(panel.title, /\[[a-f0-9-]{36}\]/);
  panel.dispose();
});

test('window recovery can be reopened manually after replacement loading fails', async t => {
  let loads = 0;
  const app = harness(t, { manualReadiness: true, filesystemLoad: async () => {
    if (++loads === 2) throw new Error('Replacement directory unavailable');
    return clipboardFixture();
  }, nativeInspect: async request => restoredWindowSnapshot(request) });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel); await panel.receive({ type: 'app-ready' });
  assert.equal(app.panels.length, 2);
  assert.equal(app.panels.every(panel => panel.disposed), true);
  await app.command('bitfroest.show');
  assert.equal(app.panels.length, 3);
  await app.panels[2].receive({ type: 'app-ready' });
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  app.panels[2].dispose();
});
test('window recovery waits for the marked native title instead of treating a missing match as failure evidence', async t => {
  const timers = require('node:timers/promises'); let checks = 0;
  t.mock.method(timers, 'setTimeout', async () => {});
  const app = harness(t, { manualReadiness: true, nativeInspect: async request => {
    const snapshot = restoredWindowSnapshot(request);
    if (request?.titleToken && ++checks < 3) snapshot.windows = [];
    return snapshot;
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel); await panel.receive({ type: 'app-ready' });
  assert.equal(checks, 4, 'three observations locate the title and a separate observation confirms its identity');
  assert.equal(panel.disposed, true); assert.equal(app.panels.length, 2);
  assert.equal(timers.setTimeout.mock.calls.length, 2);
  await app.panels[1].receive({ type: 'app-ready' }); app.panels[1].dispose();
});

test('exhausted native title lookup preserves the restored panel and logs an unverified result', async t => {
  const timers = require('node:timers/promises'), logs = []; let checks = 0;
  t.mock.method(timers, 'setTimeout', async () => {});
  const app = harness(t, { manualReadiness: true, onInfoLog: line => logs.push(JSON.parse(line)), nativeInspect: async request => {
    if (request?.titleToken) checks++;
    return { ...restoredWindowSnapshot(request), windows: [] };
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel); await panel.receive({ type: 'app-ready' });
  assert.equal(checks, 12); assert.equal(timers.setTimeout.mock.calls.length, 11);
  assert.equal(app.panels.length, 1); assert.equal(panel.disposed, false);
  assert.ok(logs.some(row => row.kind === 'window-recovery-unverified' && row.reason === 'marked-window-not-found'));
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  assert.doesNotMatch(panel.title, /\[[a-f0-9-]{36}\]/);
  panel.dispose();
});

test('focus refresh arriving during native window verification receives its response after the window is retained', async t => {
  const gate = deferred(), checked = deferred(); let loads = 0;
  const state = clipboardFixture();
  const app = harness(t, { manualReadiness: true, filesystemLoad: async () => { loads++; return state; }, nativeInspect: async request => {
    if (request?.titleToken) { checked.resolve(); await gate.promise; }
    return restoredWindowSnapshot(request, { visible: true });
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel);
  const ready = panel.receive({ type: 'app-ready' }); await checked.promise;
  const refresh = panel.receive({ type: 'filesystem-refresh', refreshRequestId: 'refresh-during-window-check', state });
  await tick(); assert.equal(loads, 1);
  gate.resolve(); await Promise.all([ready, refresh]);
  assert.equal(loads, 2);
  assert.ok(panel.messages.some(message => message.type === 'filesystem-result' && message.refreshRequestId === 'refresh-during-window-check'));
  panel.dispose();
});

test('hiding a restored panel during window verification still acknowledges its browser readiness', async t => {
  const gate = deferred(), checked = deferred();
  const app = harness(t, { manualReadiness: true, nativeInspect: async request => {
    if (request?.titleToken) { checked.resolve(); await gate.promise; }
    return restoredWindowSnapshot(request);
  } });
  const panel = app.restoredPanel(); panel.active = false;
  await app.restore(panel);
  const ready = panel.receive({ type: 'app-ready' }); await checked.promise;
  panel.changeVisibility(false); gate.resolve(); await ready;
  assert.equal(app.panels.length, 1); assert.equal(panel.disposed, false);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  panel.dispose();
});
test('early open waits for initial host contexts before creating or moving a new panel', async t => {
  const gate = deferred(), started = deferred(); let held = false;
  t.after(() => gate.resolve());
  const copy = require('../shortcut-settings').catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
  const app = harness(t, { manualReadiness: true, configuration: { 'shortcuts.bindings': { [copy.id]: 'ctrl+shift+k' } }, commandEffect: async (id, args) => {
    if (!held && id === 'setContext' && String(args[0]).startsWith('bitfroest.shortcutOverride.')) {
      held = true; started.resolve(); await gate.promise;
    }
  } });
  await started.promise;
  assert.equal(app.status.command, undefined);
  assert.equal(app.contexts.get('bitfroest.canOpen'), false);
  const first = app.command('bitfroest.show'), second = app.command('bitfroest.show');
  await tick();
  assert.equal(app.panels.length, 0);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  assert.equal(app.nativeCalls.length, 0);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(app.panels.length, 1);
  assert.equal(app.status.command, undefined, 'the visible button still waits for browser readiness');
  await app.panels[0].receive({ type: 'app-ready' });
  assert.equal(app.status.command, 'bitfroest.show');
  assert.equal(app.contexts.get('bitfroest.canOpen'), true);
  app.panels[0].dispose();
});

test('fresh panel readiness and immediately following focus refresh share one completion boundary', async t => {
  let loads = 0; const state = clipboardFixture();
  const app = harness(t, { manualReadiness: true, filesystemLoad: async () => { loads++; return state; } });
  await app.command('bitfroest.show'); const panel = app.panels[0];
  const ready = panel.receive({ type: 'app-ready' });
  const refresh = panel.receive({ type: 'filesystem-refresh', refreshRequestId: 'fresh-ready-refresh', state });
  await Promise.all([ready, refresh]);
  assert.equal(loads, 2);
  assert.ok(panel.messages.some(message => message.type === 'filesystem-result' && message.refreshRequestId === 'fresh-ready-refresh'));
  panel.dispose();
});

test('the native open commands require actual file manager availability', () => {
  for (const id of ['bitfroest.openPrototype', 'bitfroest.show']) {
    assert.equal(manifest.contributes.commands.find(command => command.command === id).enablement, 'bitfroest.canOpen');
  }
});

test('an early open waits for the initial renderer acknowledgement without custom shortcuts', async t => {
  const gate = deferred(), started = deferred(); let held = false;
  t.after(() => gate.resolve());
  const app = harness(t, { manualReadiness: true, commandEffect: async (id, args) => {
    if (!held && id === 'setContext' && args[0] === 'bitfroest.canOpen' && args[1] === false) {
      held = true; started.resolve(); await gate.promise;
    }
  } });
  await started.promise;
  const opening = app.command('bitfroest.show'); await tick();
  assert.equal(app.panels.length, 0);
  assert.equal(app.status.command, undefined);
  gate.resolve(); await opening;
  assert.equal(app.panels.length, 1);
  await app.panels[0].receive({ type: 'app-ready' }); app.panels[0].dispose();
});
test('deactivation while initialization is pending cannot create a delayed window', async t => {
  const gate = deferred(), entered = deferred(); let held = false;
  t.after(() => gate.resolve());
  const app = harness(t, { manualReadiness: true, commandEffect: async (id, args) => {
    if (!held && id === 'setContext' && args[0] === 'bitfroest.canOpen' && args[1] === false) {
      held = true; entered.resolve(); await gate.promise;
    }
  } });
  await entered.promise;
  const opening = app.command('bitfroest.show');
  for (const subscription of app.context.subscriptions) subscription.dispose();
  gate.resolve(); await opening;
  assert.equal(app.panels.length, 0);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
});

test('a failed initialization acknowledgement creates no panel and leaves startup diagnostics available', async t => {
  const logs = []; let rejected = false;
  const app = harness(t, { manualReadiness: true, onLog: (_name, _config, line) => logs.push(JSON.parse(line)), commandEffect: async (id, args) => {
    if (!rejected && id === 'setContext' && args[0] === 'bitfroest.canOpen' && args[1] === false) {
      rejected = true; throw new Error('Renderer acknowledgement failed');
    }
  } });
  await assert.rejects(app.command('bitfroest.show'), /Renderer acknowledgement failed/);
  assert.equal(app.panels.length, 0); assert.equal(app.status.command, undefined);
  assert.ok(app.commands.has('bitfroest.copyStartupLog'));
  assert.ok(logs.some(row => row.kind === 'error' && row.operation === 'initialization'));
});

test('reloading a panel document resets the readiness boundary before the next focus refresh', async t => {
  let loads = 0; const state = clipboardFixture();
  const app = harness(t, { manualReadiness: true, filesystemLoad: async () => { loads++; return state; } });
  await app.command('bitfroest.show'); const panel = app.panels[0];
  await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'language-reload', state });
  assert.equal(app.status.command, undefined);
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  const ready = panel.receive({ type: 'app-ready' });
  const refresh = panel.receive({ type: 'filesystem-refresh', refreshRequestId: 'reloaded-ready-refresh', state });
  await Promise.all([ready, refresh]);
  assert.equal(loads, 2);
  assert.equal(app.status.command, 'bitfroest.show');
  assert.ok(panel.messages.some(message => message.type === 'filesystem-result' && message.refreshRequestId === 'reloaded-ready-refresh'));
  panel.dispose();
});

test('explicit panel refresh reads only the requested directory', async t => {
  for (const side of [0, 1]) {
    const initial = clipboardFixture(), calls = [];
    const app = harness(t, { filesystemLoad: async () => initial, filesystemPrepare: async (_state, options) => { calls.push(options.directories); return structuredClone(initial); } });
    await app.command('bitfroest.openPrototype');
    const panel = app.panels[0];
    await panel.receive({ type: 'filesystem-refresh', refreshRequestId: `refresh-panel-${side}`, side, state: initial });
    assert.deepEqual(calls, [[initial.panes[side].tabs[initial.panes[side].tab]]]);
    assert.equal(panel.messages.findLast(message => message.type === 'filesystem-result').ok, true);
  }
});

test('panel refresh reads one real directory and retains the other snapshot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-refresh-')).replaceAll('\\', '/');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = root + '/left', right = root + '/right'; fs.mkdirSync(left); fs.mkdirSync(right);
  const reads = [], provider = require('../filesystem-provider').createProvider({ roots: [left, right], readDirectory: async directory => { reads.push(directory); return null; } });
  const app = harness(t, { searchRoots: [left, right], containsPath: value => provider.contains(value), filesystemLoad: settings => provider.load(settings), filesystemPrepare: (before, settings) => provider.prepare(before, settings) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  for (const side of [0, 1]) {
    const paths = [left, right]; fs.writeFileSync(paths[side] + `/new-${side}.txt`, 'new'); fs.writeFileSync(paths[1 - side] + `/unread-${side}.txt`, 'pending');
    reads.length = 0;
    view.click(view.document.querySelector(`[data-pane="${side}"] [data-refresh]`));
    const request = view.messages.findLast(message => message.type === 'filesystem-refresh');
    await panel.receive(request); const result = panel.messages.findLast(message => message.type === 'filesystem-result');
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(reads, [paths[side]]);
    assert.equal(result.state.folders[paths[side]].some(file => file.name === `new-${side}.txt`), true);
    assert.equal(result.state.folders[paths[1 - side]].some(file => file.name === `unread-${side}.txt`), false);
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  }
});

test('a failed panel refresh does not reload the opposite directory', async t => {
  const initial = clipboardFixture(); let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return structuredClone(initial); }, filesystemPrepare: async () => { throw new Error('Read failed'); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], baseline = loads;
  await panel.receive({ type: 'filesystem-refresh', refreshRequestId: 'refresh-failed', side: 1, state: initial });
  assert.equal(loads, baseline);
  const result = panel.messages.findLast(message => message.type === 'filesystem-result');
  assert.equal(result.ok, false); assert.match(result.error, /Read failed/);
  assert.deepEqual(result.state.folders, initial.folders);
});
