const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture(path = 'C:/base/current', empty = false) {
  const pane = directory => ({ tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, panes: [pane(path), pane('C:/other')], folders: {
    [path]: empty ? [] : [{ id: 'note', name: 'note.txt', type: 'text', size: 4 }],
    'C:/other': [], 'C:/base': []
  } };
}
const parentRow = app => app.document.querySelector('.pane.active [data-parent]');
const copies = app => app.messages.filter(message => message.type === 'selection-io');

test('the two-dot row can be selected and both path shortcuts copy the current directory', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  app.click(app.row('note.txt'));
  app.click(parentRow(app).querySelector('.filename'));
  assert.equal(parentRow(app).querySelector('.filename').textContent, '..');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  assert.ok(parentRow(app).classList.contains('focused'));
  assert.equal(app.row('note.txt').getAttribute('aria-selected'), 'false');
  app.key('y', { ctrlKey: true });
  app.key('Y', { ctrlKey: true, shiftKey: true });
  assert.equal(copies(app).length, 2);
  for (const request of copies(app)) {
    assert.equal(request.text.replaceAll('\\', '/'), 'C:/base/current');
    assert.deepEqual(Array.from(request.pathRanges, range => ({ ...range })), [{ start: 0, length: request.text.length }]);
  }
  assert.equal(copies(app)[1].pathStyle, 'slash');
});

test('keyboard navigation reaches the symbolic row and Enter still navigates up', t => {
  const app = createApp(t, fixture());
  app.click(app.row('note.txt'));
  app.key('ArrowUp');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('ArrowDown');
  assert.ok(app.row('note.txt').classList.contains('focused'));
  app.key('Home');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('Enter');
  assert.equal(app.state().panes[0].tabs[0], 'C:/base');
});

test('an empty directory has a keyboard-selectable current-directory symbol', t => {
  const app = createApp(t, fixture('/empty', true), { platform: 'linux' });
  app.document.querySelector('.pane.active .list').focus();
  app.key('Home'); app.key('Y', { ctrlKey: true, shiftKey: true });
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  assert.equal(copies(app).at(-1)?.text, '/empty');
});

test('name and detail copies resolve the symbol to the current directory', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app));
  app.action('copy-names'); app.action('copy-full-details');
  assert.equal(copies(app)[0]?.text, 'current');
  assert.match(copies(app)[1]?.text || '', /C:.*base.*current/);
  assert.doesNotMatch(copies(app)[1]?.text || '', /\.\./);
});

test('select all excludes the symbolic directory and double-click retains parent navigation', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app)); app.action('select-all');
  assert.deepEqual(app.state().panes[0].selected, ['note']);
  parentRow(app).dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  assert.equal(app.state().panes[0].tabs[0], 'C:/base');
});

test('streamed directory updates preserve the selected symbol', t => {
  const initial = fixture(); initial.realFilesystem = true;
  const app = createApp(t, initial);
  app.action('new-tab'); app.click(parentRow(app));
  const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
  assert.ok(request);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: {
    type: 'filesystem-directory', navigationRequestId: request.navigationRequestId,
    path: 'C:/base/current', rows: [{ id: 'new', name: 'new.txt', type: 'text' }]
  } }));
  assert.ok(app.row('new.txt'));
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('y', { ctrlKey: true });
  assert.equal(copies(app).at(-1)?.text.replaceAll('\\', '/'), 'C:/base/current');
});

test('symbol selection remains local to its pane and survives tab restoration', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app)); app.action('new-tab');
  app.click(app.row('note.txt')); app.action('previous-tab');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('Tab');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'false');
  app.click(parentRow(app)); app.action('copy-full-names-slash');
  assert.equal(copies(app).at(-1)?.text.replaceAll('\\', '/'), 'C:/other');
});

test('filesystem roots omit the symbolic entry and keep real files keyboard-accessible', t => {
  for (const directory of ['C:/', '/', '//server/share']) for (const results of [false, true]) {
    const saved = fixture(directory);
    if (results) {
      saved.folders[directory][0].fsSource = `${directory.replace(/\/$/, '')}/note.txt`;
      saved.panes[0].tabStates = [{ path: directory, searchResult: { id: 'root-search', source: directory, paths: [saved.folders[directory][0].fsSource] } }];
    }
    const app = createApp(t, saved);
    assert.equal(Boolean(parentRow(app)), false);
    app.document.querySelector('.pane.active .list').focus(); app.key('Home');
    assert.ok(app.row('note.txt').classList.contains('focused'));
  }
});

test('restoring a root clears obsolete symbol selections from older views', t => {
  const saved = fixture('C:/', true);
  saved.panes[0].selected = ['\u0000parent']; saved.panes[0].cursor = '\u0000parent';
  const app = createApp(t, saved);
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.equal(app.state().panes[0].cursor, null);
  app.action('copy-names');
  assert.equal(copies(app).length, 0);
});

test('text-input focus preserves the shortcut boundary after symbol selection', t => {
  for (const directory of ['C:/base/current', '/current']) {
    const app = createApp(t, fixture(directory, true));
    app.click(parentRow(app)); app.action('copy-full-names-slash');
    assert.equal(copies(app).at(-1)?.text.replaceAll('\\', '/'), directory);
    const count = copies(app).length;
    app.document.querySelector('.pane.active .path-input').focus();
    app.key('y', { ctrlKey: true }); app.key('Y', { ctrlKey: true, shiftKey: true });
    assert.equal(copies(app).length, count);
  }
});

const openContext = (app, target) => target.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
const menuAction = (app, action) => app.document.querySelector(`[data-context-menu] [data-context-action="${action}"]`);

test('current-directory context replaces file marks and copies or cuts the current folder', t => {
  for (const mode of ['copy', 'cut']) {
    const saved = fixture(); saved.realFilesystem = true;
    const app = createApp(t, saved, { platform: 'win32' });
    app.click(app.row('note.txt')); openContext(app, parentRow(app));
    assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
    assert.equal(JSON.parse(parentRow(app).dataset.vscodeContext).webviewSection, 'folder');
    assert.ok(menuAction(app, 'inspect-folder-locks'));
    app.click(menuAction(app, `clipboard-${mode}`));
    assert.deepEqual(Array.from(app.messages.findLast(message => message.type === 'clipboard-write')?.paths || []), ['C:/base/current']);
  }
});

test('native current-directory menu and lock inspection receive the symbolic folder identity', t => {
  for (const system of [false, true]) {
    const saved = fixture(); saved.realFilesystem = true;
    const app = createApp(t, saved, { platform: 'win32', fileSettings: { useSystemContextMenu: system } });
    openContext(app, parentRow(app));
    if (!system) app.click(menuAction(app, 'inspect-folder-locks'));
    const request = app.messages.findLast(message => message.type === 'shell-context-menu');
    assert.ok(request);
    assert.equal(request.directory, 'C:/base/current');
    assert.deepEqual(Array.from(request.ids), [app.window.CommanderGrid.parentId]);
    assert.equal(Boolean(request.inspectLocks), !system);
  }
});

test('keyboard context on the symbol opens the folder menu and stale actions cannot copy', t => {
  const saved = fixture(); saved.realFilesystem = true;
  const app = createApp(t, saved, { platform: 'win32' });
  app.click(parentRow(app)); app.key('F10', { shiftKey: true });
  const copy = menuAction(app, 'clipboard-copy'); assert.ok(copy);
  assert.ok(menuAction(app, 'inspect-folder-locks'));
  app.action('new-tab'); app.click(copy);
  assert.equal(app.messages.some(message => message.type === 'clipboard-write'), false);
});

test('the symbol context in a search-results tab refers to its current folder', t => {
  const saved = fixture(); saved.realFilesystem = true;
  saved.folders['C:/base/current'][0].fsSource = 'C:/base/current/note.txt';
  saved.panes[0].tabStates = [{ path: 'C:/base/current', searchResult: { id: 'search', source: 'C:/base/current', paths: ['C:/base/current/note.txt'] } }];
  const app = createApp(t, saved, { platform: 'win32' });
  openContext(app, parentRow(app));
  assert.equal(JSON.parse(parentRow(app).dataset.vscodeContext).webviewSection, 'folder');
  app.click(menuAction(app, 'clipboard-copy'));
  assert.deepEqual(Array.from(app.messages.findLast(message => message.type === 'clipboard-write')?.paths || []), ['C:/base/current']);
});

test('a search-result symbol retains the available Git history action for its current folder', t => {
  const saved = fixture(); saved.realFilesystem = true; saved.panes[1].tabs = ['C:/base/current'];
  saved.folders['C:/base/current'][0].fsSource = 'C:/base/current/note.txt';
  saved.panes[0].tabStates = [{ path: 'C:/base/current', searchResult: { id: 'search', source: 'C:/base/current', paths: ['C:/base/current/note.txt'] } }];
  const app = createApp(t, saved, { platform: 'win32' });
  const query = app.messages.find(message => message.type === 'git-status'); assert.ok(query);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, directories: { 'C:/base/current': { ok: true, repository: true, statuses: {} } } } }));
  openContext(app, parentRow(app));
  const group = menuAction(app, 'git'); assert.ok(group);
  group.dispatchEvent(new app.window.MouseEvent('mouseenter'));
  app.click(menuAction(app, 'git-history'));
  assert.equal(app.messages.findLast(message => message.type === 'git-history-directory')?.directory, 'C:/base/current');
});

test('navigation into an empty drive root removes the symbol and navigation back restores it', t => {
  const saved = fixture(); saved.folders['C:/'] = [];
  const warnings = [];
  const app = createApp(t, saved, { beforeApp: ({ window }) => { window.console.warn = message => warnings.push(String(message)); } });
  for (const [directory, expected] of [['C:/', false], ['C:/base/current', true]]) {
    app.action('path'); const input = app.document.querySelector('.pane.active .path-input');
    input.value = directory; app.key('Enter', {}, input);
    assert.equal(Boolean(parentRow(app)), expected);
    app.document.querySelector('.pane.active .list').focus(); app.key('Home');
  }
  assert.equal(warnings.some(message => message.includes('#88')), false);
});

test('the current network directory retains the permanent-delete warning and choice', t => {
  const saved = fixture(); saved.realFilesystem = true; saved.networkDirectories = ['C:/base/current'];
  const app = createApp(t, saved, { platform: 'win32' });
  openContext(app, parentRow(app)); app.click(menuAction(app, 'delete'));
  assert.match(app.document.querySelector('#modal-body').textContent, /Netzwerkpfade/);
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(app.messages.findLast(message => message.type === 'filesystem-delete')?.useTrash, false);
});

test('current-folder context deletion confirms the folder itself and rejects tab changes', t => {
  for (const stale of [false, true]) {
    const saved = fixture(); saved.realFilesystem = true;
    const app = createApp(t, saved, { platform: 'win32' });
    openContext(app, parentRow(app)); const remove = menuAction(app, 'delete'); assert.ok(remove);
    if (stale) app.action('new-tab');
    app.click(remove);
    if (stale) { assert.equal(app.document.querySelector('#modal').open, false); continue; }
    assert.equal(app.document.querySelector('#modal').open, true);
    assert.match(app.document.querySelector('#modal-body').textContent, /current/);
    assert.doesNotMatch(app.document.querySelector('#modal-body').textContent, /note\.txt/);
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.deepEqual(Array.from(app.messages.findLast(message => message.type === 'filesystem-delete')?.paths || []), ['C:/base/current']);
  }
});

test('file drags exclude the symbolic entry from a mixed selection', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app)); app.click(app.row('note.txt'), { ctrlKey: true });
  const data = new Map();
  const event = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData: (key, value) => data.set(key, value), setDragImage() {} } });
  app.row('note.txt').dispatchEvent(event);
  const source = JSON.parse(data.get('application/x-bitfroest-files'));
  assert.deepEqual(source.ids, ['note']);
  assert.deepEqual(source.items.map(item => item.id), source.ids);
});
