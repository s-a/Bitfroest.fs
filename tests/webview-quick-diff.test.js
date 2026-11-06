const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
test('Quick Diff footer survives pointer focus and cycles folder, repository and off', t => {
  const app = createApp(t), opposite = JSON.stringify(app.state().panes[1]);
  const button = app.document.querySelector('[data-pane="0"] [data-quick-diff-toggle]');
  assert.ok(button);
  button.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true })); button.focus();
  assert.ok(button.isConnected); app.click(button);
  assert.equal(button.dataset.mode, 'folder');
  assert.ok(app.document.querySelector('[data-quick-diff]'));
  assert.equal(app.document.querySelector('#panes').style.gridTemplateColumns, 'minmax(0, 2fr) minmax(0, 3fr)');
  app.click(button); assert.equal(button.dataset.mode, 'repository');
  app.click(button); assert.equal(button.dataset.mode, 'off');
  assert.equal(app.document.querySelector('[data-quick-diff]'), null);
  assert.equal(JSON.stringify(app.state().panes[1]), opposite);
  assert.equal(app.document.querySelector('[data-pane="0"] .pane-metrics').hidden, false);
});

test('Quick Diff ignores stale reads, follows keyboard selection and restores Escape focus', t => {
  const shown = [], app = createApp(t, undefined, { beforeApp: ({ window }) => { window.BitfroestXrayEditor = { createDiff(_node, a, b) { shown.push([a, b]); return { dispose() {} }; } }; } });
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const list = app.messages.find(m => m.type === 'quick-diff-list');
  const receive = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  receive({ type: 'quick-diff-result', requestId: list.requestId, generation: list.generation, ok: true, result: { id: 'list', entries: [{ path: 'a.sql', name: 'a.sql', status: 'Modified' }, { path: 'b.sql', name: 'b.sql', status: 'Modified' }] } });
  const first = app.messages.find(m => m.type === 'quick-diff-read');
  const name = app.document.querySelector('.quick-diff-name');
  receive({ type: 'quick-diff-icons-result', listId: 'list', generation: list.generation, icons: {} });
  assert.equal(name.isConnected, true, 'icon replies must preserve row click targets');
  app.key('ArrowDown');
  const second = app.messages.filter(m => m.type === 'quick-diff-read').at(-1);
  assert.equal(second.path, 'b.sql');
  const result = { commit: 'a'.repeat(40), name: 'a.sql', original: 'old', modified: 'new' };
  receive({ type: 'quick-diff-result', requestId: first.requestId, generation: first.generation, ok: true, result });
  assert.equal(shown.length, 0);
  receive({ type: 'quick-diff-result', requestId: second.requestId, generation: second.generation, ok: true, result });
  assert.equal(shown.length, 1);
  const preview = app.document.querySelector('[data-quick-diff]'); preview.focus(); app.key('Escape');
  assert.equal(app.document.querySelector('[data-quick-diff]'), null);
  assert.ok(app.document.activeElement.closest('[data-pane="0"] .list'));
});
test('Quick Diff and X-Ray exclude each other and right click exits', t => {
  const app = createApp(t), quick = app.document.querySelector('[data-quick-diff-toggle]');
  app.click(app.document.querySelector('[data-xray-toggle]')); app.click(quick);
  assert.equal(app.document.querySelector('[data-xray]'), null);
  app.click(app.document.querySelector('[data-pane="1"] [data-xray-toggle]'));
  assert.equal(app.document.querySelector('[data-quick-diff]'), null);
  app.click(quick);
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  quick.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  assert.equal(app.document.querySelector('[data-quick-diff]'), null);
});

test('Quick Diff sorts by status then date and supports explicit date sorting', t => {
  const app = createApp(t);
  const style = app.document.createElement('style'); style.textContent = require('node:fs').readFileSync(require.resolve('../media/app.css'), 'utf8'); app.document.head.append(style);
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'dates', entries: [{ path: 'old.sql', name: 'old.sql', status: 'Modified', modifiedAt: 1000 }, { path: 'new.sql', name: 'new.sql', status: 'Modified', modifiedAt: 3000 }, { path: 'added.sql', name: 'added.sql', status: 'Added', modifiedAt: 5000 }, { path: 'gone.sql', name: 'gone.sql', status: 'Deleted', modifiedAt: null }] } } }));
  const header = app.document.querySelector('[data-diff-sort="modifiedAt"]'); assert.ok(header);
  assert.equal(app.document.querySelector('[data-diff-sort="status"]').closest('[role="columnheader"]').getAttribute('aria-sort'), 'ascending');
  const firstRow = app.document.querySelector('.quick-diff-row');
  assert.equal(app.window.getComputedStyle(firstRow).height, '32px');
  assert.equal(app.window.getComputedStyle(firstRow).gridTemplateColumns, 'minmax(0,1fr)');
  const info = firstRow.querySelector('.quick-diff-info');
  assert.equal(app.window.getComputedStyle(info).display, 'flex');
  assert.deepEqual([...info.children].map(cell => cell.textContent), ['Modified', '·', info.querySelector('[data-modified-at]').textContent]);
  assert.equal(info.querySelectorAll('[aria-hidden="true"]').length, 1);
  assert.equal(info.querySelector('[data-diff-directory]'), null);
  assert.equal(app.window.getComputedStyle(info).color, app.window.getComputedStyle(firstRow).color);
  const names = () => [...app.document.querySelectorAll('[data-diff-filename]')].map(cell => cell.textContent);
  assert.deepEqual(names(), ['new.sql', 'old.sql', 'added.sql', 'gone.sql']);
  assert.equal(app.document.querySelectorAll('[data-quick-diff-list] time').length, 3);
  assert.equal(app.document.querySelector('.quick-diff-row:last-child [data-modified-at]').textContent, '—');
  app.click(header); assert.deepEqual(names(), ['added.sql', 'new.sql', 'old.sql', 'gone.sql']);
  app.click(header); assert.deepEqual(names(), ['old.sql', 'new.sql', 'added.sql', 'gone.sql']);
});

test('Quick Diff puts the filename above the native relative directory and uses relative time with an exact tooltip', t => {
  const app = createApp(t), now = 1793793600000;
  app.window.Date.now = () => now;
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'relative', entries: [{ path: 'src/nested/query.sql', name: 'src\\nested\\query.sql', status: 'Modified', modifiedAt: now - 120000 }] } } }));
  const row = app.document.querySelector('.quick-diff-row');
  assert.equal(row.querySelector('[data-diff-filename]')?.textContent, 'query.sql');
  assert.equal(row.querySelector('[data-diff-directory]')?.textContent, 'src\\nested\\');
  const time = row.querySelector('time');
  assert.equal(time.textContent, new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' }).format(-2, 'minute'));
  assert.equal(time.title, new app.window.Date(now - 120000).toLocaleString());
});

test('Quick Diff name sorting compares filenames across directories and preserves selection', t => {
  const app = createApp(t);
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'names', entries: [{ path: 'a/z.sql', name: 'a/z.sql', status: 'Modified' }, { path: 'z/a.sql', name: 'z/a.sql', status: 'Added' }] } } }));
  const paths = () => [...app.document.querySelectorAll('.quick-diff-row')].map(row => row.dataset.diffPath);
  const name = app.document.querySelector('[data-diff-sort="name"]');
  app.click(name); assert.deepEqual(paths(), ['z/a.sql', 'a/z.sql']);
  assert.equal(app.document.querySelector('[aria-selected="true"][data-diff-path]').dataset.diffPath, 'a/z.sql');
  app.click(name); assert.deepEqual(paths(), ['a/z.sql', 'z/a.sql']);
});

test('Quick Diff keeps filenames neutral without icons and colors only the status', async t => {
  const app = createApp(t, undefined, { fileSettings: { colors: { enabled: true, git: true, rules: { '*.sql': '#ffffff' } } } });
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'colors', entries: [{ path: 'nested/query.sql', name: 'nested/query.sql', status: 'Modified', gitStatus: 'modified', modifiedAt: 1000 }] } } }));
  const row = app.document.querySelector('.quick-diff-row');
  assert.equal(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'), '');
  assert.equal(row.style.getPropertyValue('--git-text-color'), '');
  assert.equal(row.querySelector('.file-icon,img,svg'), null);
  assert.equal(app.messages.some(message => message.type === 'quick-diff-icons'), false);
  assert.equal(row.querySelector('[data-modified-at]').style.getPropertyValue('--file-type-color'), '');
  assert.ok(row.querySelector('[data-diff-status-cell]').style.getPropertyValue('--quick-status-base'));
  assert.equal(row.querySelector('.quick-diff-name').style.getPropertyValue('--quick-status-base'), '');
  const list = app.document.querySelector('[data-quick-diff-list]');
  assert.ok(parseFloat(list.style.getPropertyValue('--quick-diff-status-width')) > 0);
  assert.ok(parseFloat(list.style.getPropertyValue('--quick-diff-date-width')) > 0);
  app.document.body.className = 'vscode-high-contrast';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row.isConnected, true);
  assert.equal(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'), '');
});

test('Quick Diff metadata uses the bright foreground even on unselected rows', t => {
  const app = createApp(t), { resolveThemeCss } = require('./support/webview.cjs');
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(require('node:fs').readFileSync(require.resolve('../media/app.css'), 'utf8'), { foreground: '#cccccc', descriptionForeground: '#777777' });
  app.document.head.append(style);
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'bright', entries: [{ path: 'a.sql', name: '.\\a.sql', status: 'Modified' }, { path: 'src/b.sql', name: 'src\\b.sql', status: 'Added' }] } } }));
  const row = app.document.querySelector('[data-diff-path="src/b.sql"]');
  assert.equal(row.getAttribute('aria-selected'), 'false');
  for (const cell of ['[data-diff-directory]', '[data-modified-at]', '.quick-diff-separator']) assert.equal(app.window.getComputedStyle(row.querySelector(cell)).color, 'rgb(204, 204, 204)');
  assert.equal(app.window.getComputedStyle(row.querySelector('.quick-diff-name')).color, 'rgb(204, 204, 204)');
  assert.equal(app.window.getComputedStyle(row.querySelector('.quick-diff-info')).paddingLeft, '0px');
  assert.equal(app.document.querySelector('[data-diff-path="a.sql"] .quick-diff-info').children.length, 3);
});

test('Quick Diff displays a syntax-capable Added ghost preview without a HEAD commit', t => {
  const shown = [], app = createApp(t, undefined, { beforeApp: ({ window }) => { window.BitfroestXrayEditor = { createDiff(_node, original, modified, name) { shown.push({ original, modified, name }); return { dispose() {} }; } }; } });
  const receive = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const list = app.messages.find(message => message.type === 'quick-diff-list');
  receive({ type: 'quick-diff-result', requestId: list.requestId, generation: list.generation, ok: true, result: { id: 'ghost', entries: [{ path: 'fresh.sql', name: '.\\fresh.sql', status: 'Added' }] } });
  const read = app.messages.find(message => message.type === 'quick-diff-read');
  receive({ type: 'quick-diff-result', requestId: read.requestId, generation: read.generation, ok: true, result: { original: '', modified: 'SELECT 3;', name: '.\\fresh.sql', commit: null, ghost: 'added' } });
  assert.deepEqual(shown, [{ original: '', modified: 'SELECT 3;', name: '.\\fresh.sql' }]);
  assert.match(app.document.querySelector('.xray-title').textContent, /Ghost.*Added/);
});

test('Quick Diff preserves its list and footer controls across a host-driven pane repaint', t => {
  const app = createApp(t), receive = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  receive({ type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true, result: { id: 'repaint', entries: [{ path: 'a.sql', name: 'a.sql', status: 'Modified' }, { path: 'b.sql', name: 'b.sql', status: 'Modified' }] } });
  const list = app.document.querySelector('[data-quick-diff-list]'), toggle = app.document.querySelector('[data-pane="0"] [data-quick-diff-toggle]');
  receive({ type: 'column-settings', settings: {} });
  assert.equal(app.document.querySelector('[data-quick-diff-list]'), list);
  assert.ok(list.querySelector('[role="grid"]'));
  assert.equal(app.document.querySelector('[data-pane="0"] .pane-status [data-quick-diff-toggle]'), toggle);
  app.click(list.querySelector('[data-diff-path="b.sql"]'));
  assert.equal(app.messages.filter(message => message.type === 'quick-diff-read').at(-1).path, 'b.sql');
});

test('Quick Diff leaves unchanged results mounted and restores list and editor scroll after a change', async t => {
  const views = [];
  const app = createApp(t, undefined, { beforeApp: ({ window }) => {
    window.BitfroestXrayEditor = { createDiff(_node, original, modified) {
      const editor = { modified, position: null, saveViewState: () => editor.position, restoreViewState: position => { editor.position = position; }, dispose() {} };
      views.push(editor);
      return editor;
    } };
  } });
  const send = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  const latest = type => app.messages.findLast(message => message.type === type);
  const entries = [{ path: 'a.txt', name: 'a.txt', status: 'Modified', modifiedAt: 1 },
    { path: 'b.txt', name: 'b.txt', status: 'Modified', modifiedAt: 2 }];
  const list = (id, rows) => {
    const { requestId, generation } = latest('quick-diff-list');
    send({ type: 'quick-diff-result', requestId, generation, ok: true, result: { id, entries: rows, commit: 'head' } });
  };
  const comparison = modified => {
    const { requestId, generation, path } = latest('quick-diff-read');
    send({ type: 'quick-diff-result', requestId, generation, ok: true, result: { path, name: path, commit: 'head', original: 'original', modified } });
  };
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  list('first', entries);
  app.click(app.document.querySelector('[data-diff-path="a.txt"]'));
  comparison('first content');
  views[0].position = { scrollTop: 90, scrollLeft: 14 };
  const read = latest('quick-diff-read'), grid = app.document.querySelector('[data-quick-diff-list] [role="grid"]');
  grid.scrollTop = 38;
  grid.focus();
  send({ type: 'quick-diff-refresh' });
  assert.equal(grid.isConnected, true);
  list('same', entries);
  assert.equal(latest('quick-diff-read'), read);
  assert.equal(latest('quick-diff-release').listId, 'same');
  assert.equal(views.length, 1);
  send({ type: 'quick-diff-refresh' });
  list('changed', [{ ...entries[0], modifiedAt: 3 }, entries[1]]);
  assert.equal(latest('quick-diff-read').listId, 'changed');
  assert.equal(latest('quick-diff-read').path, 'a.txt');
  assert.equal(grid.isConnected, true);
  assert.equal(grid.scrollTop, 38);
  assert.equal(app.document.activeElement, grid);
  comparison('new content');
  await Promise.resolve();
  assert.equal(views.at(-1).modified, 'new content');
  assert.deepEqual(views.at(-1).position, views[0].position);
});

test('double-clicking a Quick Diff entry exits and selects it in the restored file list', t => {
  const app = createApp(t), path = app.state().panes[0].tabs[0], original = app.row('package.json').dataset.id;
  const receive = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  receive({ type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true, result: { id: 'reveal', root: path, entries: [{ path: 'README.md', name: 'README.md', status: 'Modified' }, { path: 'package.json', name: 'package.json', status: 'Modified' }] } });
  const row = app.document.querySelector('[data-diff-path="package.json"]'); app.click(row);
  assert.equal(row.isConnected, true, 'the first click must preserve the target for a subsequent double-click');
  row.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  assert.equal(app.document.querySelector('[data-quick-diff]'), null);
  assert.equal(app.state().panes[0].cursor, original);
  assert.deepEqual(app.state().panes[0].selected, [original]);
  assert.match(app.document.querySelector('[data-pane="0"] [data-history="back"]').title, /Quick Diff/);
  app.action('back');
  assert.ok(app.document.querySelector('[data-quick-diff]'));
  const back = app.messages.filter(message => message.type === 'quick-diff-list').at(-1);
  assert.equal(back.mode, 'folder'); assert.equal(back.selectedPath, 'package.json');
  receive({ type: 'quick-diff-result', requestId: back.requestId, generation: back.generation, ok: true, result: { id: 'returned', root: path, entries: [{ path: 'README.md', name: 'README.md', status: 'Modified' }, { path: 'package.json', name: 'package.json', status: 'Modified' }] } });
  assert.equal(app.document.querySelector('[data-diff-path="package.json"]').getAttribute('aria-selected'), 'true');
  app.action('forward');
  assert.equal(app.document.querySelector('[data-quick-diff]'), null);
  assert.equal(app.state().panes[0].cursor, original);
});

test('history restores repository mode, sorting and scroll position from either source side', t => {
  for (const side of [0, 1]) {
    const app = createApp(t), receive = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
    const button = app.document.querySelector(`[data-pane="${side}"] [data-quick-diff-toggle]`);
    app.click(button); app.click(button);
    const request = app.messages.filter(message => message.type === 'quick-diff-list').at(-1);
    const entries = [{ path: 'src/z.sql', name: 'src/z.sql', status: 'Modified' }, { path: 'README.md', name: 'README.md', status: 'Modified' }];
    receive({ type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true, result: { id: 'repository', root: app.state().panes[side].tabs[0], entries } });
    app.click(app.document.querySelector('[data-diff-sort="name"]'));
    app.click(app.document.querySelector('[data-diff-path="README.md"]'));
    const grid = app.document.querySelector('[data-quick-diff-list] [role="grid"]'); grid.scrollTop = 32;
    app.document.querySelector('[data-diff-path="README.md"]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
    app.action('back');
    const back = app.messages.filter(message => message.type === 'quick-diff-list').at(-1);
    assert.equal(back.mode, 'repository');
    assert.equal(back.selectedPath, 'README.md');
    receive({ type: 'quick-diff-result', requestId: back.requestId, generation: back.generation, ok: true, result: { id: 'restored', entries } });
    assert.equal(app.document.querySelector(`[data-pane="${side}"] [data-quick-diff-toggle]`).dataset.mode, 'repository');
    assert.equal(app.document.querySelector('[data-diff-sort="name"]').closest('[role="columnheader"]').getAttribute('aria-sort'), 'ascending');
    assert.equal(app.document.querySelector('[data-quick-diff-list] [role="grid"]').scrollTop, 32);
  }
});

test('Quick Diff names its sortable first heading File Name in English', t => {
  const app = createApp(t, undefined, { language: 'en' }); app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true, result: { id: 'heading', entries: [] } } }));
  assert.equal(app.document.querySelector('[data-diff-sort="name"]').textContent, 'File Name');
});

test('Quick Diff history waits for the filesystem navigation acknowledgement before restoring the preview', t => {
  const initial = { version: 1, realFilesystem: true, snapshotId: 'history-diff', active: 0,
    panes: [{ tabs: ['/repo/src'], tab: 0, selected: [] }, { tabs: ['/other'], tab: 0, selected: [] }],
    folders: { '/repo/src': [], '/repo/docs': [{ id: 'audit', name: 'audit.sql', type: 'file' }], '/other': [] } };
  const app = createApp(t, initial), receive = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  receive({ type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true, result: { id: 'ack', root: '/repo', entries: [{ path: 'docs/audit.sql', name: 'docs/audit.sql', status: 'Modified' }] } });
  app.document.querySelector('[data-diff-path]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
  const open = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.equal(open.path, '/repo/docs');
  receive({ type: 'filesystem-result', navigationRequestId: open.navigationRequestId, ok: true, state: open.state });
  assert.equal(app.state().panes[0].tabs[0], '/repo/docs');
  app.action('back');
  const back = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.equal(back.path, '/repo/src'); assert.equal(app.document.querySelector('[data-quick-diff]'), null);
  receive({ type: 'filesystem-result', navigationRequestId: back.navigationRequestId, ok: true, state: back.state });
  assert.ok(app.document.querySelector('[data-quick-diff]'));
  assert.equal(app.messages.filter(message => message.type === 'quick-diff-list').at(-1).selectedPath, 'docs/audit.sql');
});

test('Quick Diff tooltips and path shortcuts use the complete selected path', t => {
  const app = createApp(t, undefined, { platform: 'win32' });
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'paths', root: 'C:/repo', entries: [{ path: 'src/query.sql', name: 'src\\query.sql', status: 'Modified' }] } } }));
  assert.equal(app.document.querySelector('.quick-diff-name').title, 'C:\\repo\\src\\query.sql');
  assert.equal(app.document.querySelector('[data-diff-directory]').title, 'C:\\repo\\src\\query.sql');
  const grid = app.document.querySelector('[data-quick-diff-list] [role="grid"]'); grid.focus();
  app.key('y', { ctrlKey: true }, grid);
  let copy = app.messages.filter(message => message.type === 'selection-io').at(-1);
  assert.equal(copy.text, 'C:\\repo\\src\\query.sql'); assert.equal(copy.pathStyle, undefined);
  app.key('Y', { ctrlKey: true, shiftKey: true }, grid);
  copy = app.messages.filter(message => message.type === 'selection-io').at(-1);
  assert.equal(copy.text, 'C:\\repo\\src\\query.sql'); assert.equal(copy.pathStyle, 'slash');
  app.action('copy-full-names');
  assert.equal(app.messages.filter(message => message.type === 'selection-io').at(-1).pathStyle, undefined);
  grid.blur(); const count = app.messages.filter(message => message.type === 'selection-io').length;
  app.document.querySelector('[data-quick-diff]').focus();
  app.key('y', { ctrlKey: true }, app.document.activeElement);
  assert.equal(app.messages.filter(message => message.type === 'selection-io').length, count);
});
