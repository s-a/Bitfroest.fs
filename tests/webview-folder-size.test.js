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
