const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture(real = false) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: 'docs', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: real, snapshotId: 'one', active: 0, panes: [pane('/left'), pane('/right')],
    folders: { '/left': [{ id: 'docs', name: 'docs', type: 'folder', size: 0 }, { id: 'empty', name: 'empty', type: 'folder', size: 0 }, { id: 'file', name: 'file.txt', type: 'text', size: 3 }],
      '/left/docs': [{ id: 'nested', name: 'nested', type: 'folder', size: 0 }, { id: 'a', name: 'a.txt', type: 'text', size: 7 }],
      '/left/docs/nested': [{ id: 'b', name: 'b.bin', type: 'archive', size: 11 }], '/left/empty': [], '/right': [] } };
}
const cell = (app, name) => app.row(name).querySelector('[data-cell="size"]').textContent;
const reply = (app, request, extra = {}) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'folder-size-result', operationId: request.operationId, snapshotId: request.snapshotId, path: request.path, ok: true, size: 18, ...extra } }));

test('Space after a plain click marks the folder without replacing lists, focus or scroll', t => {
  const app = createApp(t, fixture(true));
  app.click(app.row('docs'));
  const list = app.document.activeElement, row = app.row('docs');
  list.scrollTop = 140; list.scrollLeft = 83;
  app.key(' ');
  assert.equal(app.document.activeElement, list);
  assert.equal(app.row('docs'), row);
  assert.equal(list.scrollTop, 140); assert.equal(list.scrollLeft, 83);
  assert.equal(app.state().panes[0].cursor, 'docs');
  assert.deepEqual(app.state().panes[0].selected, ['docs']);
  assert.ok(row.classList.contains('space-marked'));
  const request = app.messages.find(m => m.type === 'folder-size'); assert.ok(request);
  reply(app, request);
  assert.equal(cell(app, 'docs'), '18 B');
  assert.equal(app.document.activeElement, list); assert.ok(row.classList.contains('space-marked'));
  app.key(' ', { repeat: true });
  assert.deepEqual(app.state().panes[0].selected, ['docs']);
  app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.equal(row.classList.contains('space-marked'), false);
});

test('Space marks survive cursor movement and include files without selecting the next cursor', t => {
  const app = createApp(t, fixture());
  app.click(app.row('docs')); app.key(' '); app.key('ArrowDown');
  assert.equal(app.state().panes[0].cursor, 'empty');
  assert.deepEqual(app.state().panes[0].selected, ['docs']);
  assert.ok(app.row('docs').classList.contains('space-marked'));
  app.key(' '); app.key('ArrowDown'); app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, ['docs', 'empty', 'file']);
  assert.ok(app.row('file.txt').classList.contains('space-marked'));
  app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, ['docs', 'empty']);
  assert.equal(app.row('file.txt').classList.contains('space-marked'), false);
});

test('a cursor-only arrow selection can be marked with Space and marks remain scoped to their tab', t => {
  const state = fixture(); state.panes[0].tabs.push('/right');
  const app = createApp(t, state);
  app.key('ArrowDown'); app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, ['empty']);
  assert.ok(app.row('empty').classList.contains('space-marked'));
  app.click(app.document.querySelector('.pane.active [data-tab="1"]'));
  assert.equal(app.document.querySelectorAll('.pane.active .space-marked').length, 0);
  app.click(app.document.querySelector('.pane.active [data-tab="0"]'));
  assert.ok(app.row('empty').classList.contains('space-marked'));
});

test('Space marks keep normal font weight and an independent visible cursor while sizing is pending', t => {
  const fs = require('node:fs'), path = require('node:path');
  const app = createApp(t, fixture(true));
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  app.click(app.row('docs')); app.key(' ');
  const row = app.row('docs');
  const weight = app.window.getComputedStyle(app.row('empty').querySelector('[data-filename]')).fontWeight;
  assert.equal(app.window.getComputedStyle(row.querySelector('[data-filename]')).fontWeight, weight);
  const list = app.document.activeElement;
  const request = app.messages.find(message => message.type === 'folder-size'); assert.ok(request);
  for (const completed of [false, true]) {
    if (completed) reply(app, request);
    for (const [key, id, name, repeat] of [['ArrowDown', 'empty', 'empty', false], ['ArrowDown', 'file', 'file.txt', true], ['ArrowUp', 'empty', 'empty', false], ['ArrowUp', 'docs', 'docs', true]]) {
      app.key(key, { repeat });
      list.dispatchEvent(new app.window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      assert.equal(app.state().panes[0].cursor, id);
      assert.equal(app.document.activeElement, list);
      assert.deepEqual(app.state().panes[0].selected, ['docs']);
      const cursor = app.row(name);
      assert.ok(cursor.classList.contains('focused'));
      assert.equal(app.document.querySelectorAll('.pane.active tr.focused').length, 1);
      assert.equal(app.window.getComputedStyle(cursor).outlineStyle, 'solid');
    }
  }
  assert.match(style.textContent, /\.file-table tr\.space-marked[^{}]*\{[^}]*--inactive-selection-text/);
  assert.match(style.textContent, /@media \(forced-colors: active\)[\s\S]*\.space-marked/);
});

test('Space marks keep readable theme colors on active and inactive selection backgrounds', async t => {
  const app = createApp(t, fixture());
  const style = app.document.body.style;
  style.setProperty('--vscode-editor-background', '#ffffff');
  style.setProperty('--vscode-list-highlightForeground', '#333333');
  for (const state of ['active', 'inactive']) style.setProperty(`--vscode-list-${state}SelectionBackground`, '#333333');
  await new Promise(resolve => setImmediate(resolve));
  const table = app.document.querySelector('.file-table');
  for (const state of ['active', 'inactive']) {
    assert.ok(app.window.CommanderFileColors.ratio(table.style.getPropertyValue(`--${state}-space-mark-text`), '#333333') >= 4.5);
  }
  for (const theme of ['vscode-high-contrast', 'vscode-high-contrast-light']) {
    app.document.body.className = theme;
    await new Promise(resolve => setImmediate(resolve));
    for (const state of ['active', 'inactive']) {
      assert.equal(table.style.getPropertyValue(`--${state}-space-mark-text`), '');
      assert.ok(app.window.CommanderFileColors.ratio(table.style.getPropertyValue(`--${state}-selection-text`), '#333333') >= 4.5);
    }
  }
});

test('Space respects explicit Insert selection after a plain cursor click', t => {
  const app = createApp(t, fixture());
  app.click(app.row('file.txt'));
  app.key('Insert'); app.key('Insert'); app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, []);
});

test('explicit selection commands replace the cursor-only selection before Space', t => {
  for (const commands of [['select-all'], ['invert', 'invert']]) {
    const state = fixture(); state.folders['/left'] = state.folders['/left'].filter(file => file.id === 'file');
    state.panes[0].cursor = 'file';
    const app = createApp(t, state);
    app.click(app.row('file.txt'));
    commands.forEach(command => app.action(command));
    app.key(' ');
    assert.deepEqual(app.state().panes[0].selected, [], commands.join(', '));
  }
});

test('Space markings restore with the saved view and refresh drops a removed marked entry', t => {
  const app = createApp(t, fixture(true));
  app.click(app.row('docs')); app.key(' ');
  const saved = app.state();
  const restored = createApp(t, saved);
  assert.ok(restored.row('docs').classList.contains('space-marked'));
  restored.key(' ');
  assert.deepEqual(restored.state().panes[0].selected, []);
  app.action('refresh');
  const fresh = structuredClone(saved); fresh.snapshotId = 'two';
  fresh.folders['/left'] = fresh.folders['/left'].filter(file => file.id !== 'docs');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh } }));
  assert.equal(app.row('docs'), undefined);
  assert.equal(app.document.querySelectorAll('.pane.active .space-marked').length, 0);
  assert.deepEqual(app.state().panes[0].spaceMarked, []);
});

test('Space sums only the newly marked cursor folder recursively and keeps other marks and cursor', t => {
  const state = fixture(); state.panes[0].selected = ['file', 'empty'];
  const app = createApp(t, state); app.key(' ');
  assert.equal(cell(app, 'docs'), '18 B'); assert.equal(cell(app, 'empty'), '<DIR>');
  assert.deepEqual(app.state().panes[0].selected, ['file', 'empty', 'docs']);
  assert.equal(app.state().panes[0].cursor, 'docs');
  assert.match(app.document.querySelector('.pane.active .pane-status').textContent, /21 B/);
  app.key(' '); assert.equal(cell(app, 'docs'), '18 B');
  assert.deepEqual(app.state().panes[0].selected, ['file', 'empty']);
  assert.equal(app.state().folders['/left'][0].size, 0);
});

test('Alt Shift Enter calculates every displayed folder including empty folders without changing selection', t => {
  const app = createApp(t, fixture()); app.key('Enter', { altKey: true, shiftKey: true });
  assert.equal(cell(app, 'docs'), '18 B'); assert.equal(cell(app, 'empty'), '0 B');
  assert.deepEqual(app.state().panes[0].selected, []); assert.equal(app.state().panes[0].cursor, 'docs');
});

test('real folder sizing uses a read-only host request and never commits display metadata', t => {
  const app = createApp(t, fixture(true)); app.key(' ');
  const request = app.messages.find(m => m.type === 'folder-size'); assert.ok(request);
  assert.equal(request.path, '/left/docs'); assert.equal(request.snapshotId, 'one');
  assert.equal(cell(app, 'docs'), '<DIR>'); reply(app, request);
  assert.equal(cell(app, 'docs'), '18 B');
  assert.equal(app.messages.some(m => ['filesystem-apply', 'filesystem-prepare'].includes(m.type)), false);
  assert.equal(app.state().folders['/left'][0].size, 0);
  app.key(' '); assert.equal(app.messages.filter(m => m.type === 'folder-size').length, 1);
});

test('Escape cancels sizing and late or stale results do not publish a partial size', t => {
  const app = createApp(t, fixture(true)); app.key(' ');
  const request = app.messages.find(m => m.type === 'folder-size'); assert.ok(request);
  app.key('Escape'); assert.ok(app.messages.some(m => m.type === 'filesystem-cancel' && m.operationId === request.operationId));
  reply(app, request); assert.equal(cell(app, 'docs'), '<DIR>');
  app.key(' '); app.key(' ');
  const next = app.messages.filter(m => m.type === 'folder-size').at(-1);
  const fresh = app.state(); fresh.snapshotId = 'two';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: fresh } }));
  reply(app, next); assert.equal(cell(app, 'docs'), '<DIR>');
});

test('Insert, text input, modified Space and already marked folders do not start sizing', t => {
  const state = fixture(true); state.panes[0].selected = ['docs'];
  const app = createApp(t, state); app.key(' '); app.key('Insert');
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) app.key(' ', { [modifier]: true });
  app.key(' ', {}, app.document.querySelector('.path-input'));
  assert.equal(app.messages.some(m => m.type === 'folder-size'), false);
});

test('sizing results preserve a path input and inline rename entered while metadata is read', t => {
  for (const inline of [false, true]) for (const ok of [true, false]) {
    const app = createApp(t, fixture(true)); app.key(' ');
    const request = app.messages.find(m => m.type === 'folder-size');
    if (inline) app.action('rename-one');
    const input = app.document.querySelector(inline ? '.inline-rename' : '.path-input');
    assert.ok(input); input.focus(); input.value = 'unfinished';
    reply(app, request, { ok, error: 'Access denied' });
    assert.equal(app.document.activeElement, input); assert.equal(input.value, 'unfinished');
    assert.equal(cell(app, 'docs'), ok ? '18 B' : '<DIR>');
    assert.equal(app.document.querySelector('#modal').open, false);
  }
});

test('multiple Space selections receive separate sizes and errors never display partial totals', t => {
  const app = createApp(t, fixture(true)); app.key(' ');
  const first = app.messages.find(m => m.type === 'folder-size');
  app.click(app.row('empty').querySelector('[data-filename]'), { ctrlKey: true }); app.key(' '); app.key(' ');
  const second = app.messages.filter(m => m.type === 'folder-size').at(-1);
  assert.notEqual(first.operationId, second.operationId); assert.equal(second.path, '/left/empty');
  reply(app, second, { size: 0 }); reply(app, first, { ok: false, size: 9, error: 'Access denied' });
  assert.equal(cell(app, 'empty'), '0 B'); assert.equal(cell(app, 'docs'), '<DIR>');
  assert.deepEqual(app.state().panes[0].selected, ['docs', 'empty']);
  assert.equal(app.messages.some(m => m.type === 'filesystem-apply'), false);
});

test('folder sizing on Space can be disabled in file settings while the explicit all-folder command remains available', t => {
  const app = createApp(t, fixture(true), { fileSettings: { countFolderSizeOnSpace: false } });
  app.key(' '); assert.deepEqual(app.state().panes[0].selected, ['docs']);
  assert.equal(app.messages.some(m => m.type === 'folder-size'), false);
  app.key('Enter', { altKey: true, shiftKey: true });
  assert.equal(app.messages.filter(m => m.type === 'folder-size').length, 2);
});

test('calculated sizes respect custom byte columns and do not replace folder names or unsupported fields', t => {
  const app = createApp(t, fixture(true), { columnSettings: { activeSet: 'sizes', sets: [{ id: 'sizes', name: 'Sizes', columns: [
    { id: 'name', field: '[=tc.fullname]' }, { id: 'bytes', field: '[=tc.size.bytes]' },
    { id: 'auto', field: '[=tc.size.auto]' }, { id: 'missing', field: '[=wdx.foo]' },
    { id: 'substring', field: '[=tc.size:1-1]' }, { id: 'conditional', field: '[="Size: "tc.size.auto"!"]' }
  ] }] } });
  app.key(' '); const request = app.messages.find(m => m.type === 'folder-size'); reply(app, request);
  assert.equal(app.row('docs').querySelector('[data-cell="bytes"]').textContent, '18');
  assert.equal(app.row('docs').querySelector('[data-cell="auto"]').textContent, '18 B');
  assert.equal(app.row('docs').querySelector('[data-filename]').textContent, 'docs');
  assert.match(app.row('docs').querySelector('[data-cell="missing"]').textContent, /Nicht verfügbar/);
  assert.equal(app.row('docs').querySelector('[data-cell="substring"]').textContent, '1');
  assert.equal(app.row('docs').querySelector('[data-cell="conditional"]').textContent, 'Size: 18 B!');
});
