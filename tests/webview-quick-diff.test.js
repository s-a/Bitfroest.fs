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
  const shown = [], app = createApp(t, undefined, { beforeApp: ({ window }) => { window.CommanderXrayEditor = { createDiff(_node, a, b) { shown.push([a, b]); return { dispose() {} }; } }; } });
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

test('Quick Diff uses Git colors for filename and status while keeping metadata readable', async t => {
  const app = createApp(t, undefined, { fileSettings: { colors: { enabled: true, git: true, rules: { '*.sql': '#ffffff' } } } });
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'colors', entries: [{ path: 'nested/query.sql', name: 'nested/query.sql', status: 'Modified', gitStatus: 'modified', modifiedAt: 1000 }] } } }));
  const row = app.document.querySelector('.quick-diff-row');
  assert.ok(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'));
  assert.ok(row.style.getPropertyValue('--git-text-color'));
  assert.equal(row.querySelector('[data-modified-at]').style.getPropertyValue('--file-type-color'), '');
  assert.ok(row.querySelector('[data-diff-status-cell]').style.getPropertyValue('--quick-status-base'));
  assert.equal(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'), row.querySelector('[data-diff-status-cell]').style.getPropertyValue('--quick-status-base'));
  assert.notEqual(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'), '#ffffff');
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
  assert.equal(app.document.querySelector('[data-diff-path="a.sql"] .quick-diff-info').children.length, 3);
});

test('Quick Diff displays a syntax-capable Added ghost preview without a HEAD commit', t => {
  const shown = [], app = createApp(t, undefined, { beforeApp: ({ window }) => { window.CommanderXrayEditor = { createDiff(_node, original, modified, name) { shown.push({ original, modified, name }); return { dispose() {} }; } }; } });
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
});
