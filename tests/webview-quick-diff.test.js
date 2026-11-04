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
  assert.equal(app.window.getComputedStyle(firstRow).gridTemplateColumns, 'minmax(140px,1fr) var(--quick-diff-status-width,82px) var(--quick-diff-date-width,146px)');
  assert.equal(app.window.getComputedStyle(app.document.querySelector('.quick-diff-header')).gridTemplateColumns, 'minmax(140px,1fr) var(--quick-diff-status-width,82px) var(--quick-diff-date-width,146px)');
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

test('Quick Diff reuses configured filename colors and sizes its columns from rendered content', async t => {
  const app = createApp(t, undefined, { fileSettings: { colors: { enabled: true, git: true, rules: { '*.sql': '#ffffff' } } } });
  app.click(app.document.querySelector('[data-quick-diff-toggle]'));
  const request = app.messages.find(message => message.type === 'quick-diff-list');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'quick-diff-result', requestId: request.requestId, generation: request.generation, ok: true,
    result: { id: 'colors', entries: [{ path: 'nested/query.sql', name: 'nested/query.sql', status: 'Modified', gitStatus: 'modified', modifiedAt: 1000 }] } } }));
  const row = app.document.querySelector('.quick-diff-row');
  assert.ok(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'));
  assert.ok(row.style.getPropertyValue('--git-text-color'));
  const list = app.document.querySelector('[data-quick-diff-list]');
  assert.ok(parseFloat(list.style.getPropertyValue('--quick-diff-status-width')) > 0);
  assert.ok(parseFloat(list.style.getPropertyValue('--quick-diff-date-width')) > 0);
  app.document.body.className = 'vscode-high-contrast';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row.isConnected, true);
  assert.equal(row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color'), '');
});
