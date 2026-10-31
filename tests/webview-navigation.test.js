const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createApp } = require('./support/webview.cjs');

function pointer(app, type, element, properties = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, clientX: 0, pointerId: 1, ...properties })) Object.defineProperty(event, key, { value });
  element.dispatchEvent(event);
}

function transfer() {
  const data = new Map();
  return { setData(key, value) { data.set(key, value); }, getData(key) { return data.get(key) || ''; } };
}

function drag(app, type, target, data, extra = {}) {
  assert.ok(target, `${type} target exists`);
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

function select(app, name, extra) { app.click(app.row(name).querySelector('[data-filename]'), extra); }
function pane(app, index = 0) { return app.document.querySelector(`[data-pane="${index}"]`); }
function tab(app, index, side = 0) { return pane(app, side).querySelector(`[data-tab="${index}"]`); }

test('pointer resizing persists only the target pane width and stops after release', t => {
  const app = createApp(t);
  const left = app.state().panes[0].columns.find(column => column.key === 'name').width;
  const before = app.state().panes[1].columns.find(column => column.key === 'name').width;
  const handle = pane(app, 1).querySelector('[data-resize="name"]');
  pointer(app, 'pointerdown', handle, { clientX: 100 });
  pointer(app, 'pointermove', handle, { clientX: 180 });
  assert.equal(pane(app, 1).querySelector('[data-col="name"]').width, String(before + 80));
  pointer(app, 'pointerup', handle, { clientX: 180 });
  assert.equal(app.state().panes[1].columns.find(column => column.key === 'name').width, before + 80);
  assert.equal(app.state().panes[0].columns.find(column => column.key === 'name').width, left);
  pointer(app, 'pointermove', handle, { clientX: 500 });
  assert.equal(pane(app, 1).querySelector('[data-col="name"]').width, String(before + 80));
});

test('pointer cancellation persists the final clamped width without leaving handlers active', t => {
  const app = createApp(t);
  const handle = pane(app).querySelector('[data-resize="name"]');
  pointer(app, 'pointerdown', handle, { clientX: 500 });
  pointer(app, 'pointermove', handle, { clientX: -500 });
  pointer(app, 'pointercancel', handle);
  assert.equal(app.state().panes[0].columns.find(column => column.key === 'name').width, 80);
  pointer(app, 'pointermove', handle, { clientX: 1000 });
  assert.equal(pane(app).querySelector('[data-col="name"]').width, '80');
});

test('dragging a tab to the opposite pane moves its path and activates that pane', t => {
  const app = createApp(t), data = transfer();
  drag(app, 'dragstart', tab(app, 1), data);
  const accepted = drag(app, 'dragover', pane(app, 1).querySelector('.tabs'), data);
  assert.equal(accepted.defaultPrevented, true);
  drag(app, 'drop', tab(app, 1, 1), data);
  assert.deepEqual(app.state().panes[0].tabs, ['/workspace/bitfroest', '/workspace/bitfroest/assets']);
  assert.deepEqual(app.state().panes[1].tabs, ['/home/demo/Downloads', '/workspace/bitfroest/docs', '/home/demo/Backups']);
  assert.equal(app.state().active, 1);
  assert.equal(pane(app, 1).querySelector('.path-input').value, '/workspace/bitfroest/docs');
});

test('Ctrl-drag copies a tab and drag cancellation prevents a later accidental drop', t => {
  const app = createApp(t), data = transfer();
  const originalId = app.state().panes[0].tabStates[1].id;
  drag(app, 'dragstart', tab(app, 1), data);
  drag(app, 'drop', pane(app, 1).querySelector('.tabs'), data, { ctrlKey: true });
  assert.equal(app.state().panes[0].tabs.length, 3);
  assert.equal(app.state().panes[1].tabs.at(-1), '/workspace/bitfroest/docs');
  assert.notEqual(app.state().panes[1].tabStates.at(-1).id, originalId);
  const length = app.state().panes[1].tabs.length;
  drag(app, 'dragstart', tab(app, 0), data);
  drag(app, 'dragend', tab(app, 0), data);
  drag(app, 'drop', pane(app, 1).querySelector('.tabs'), data);
  assert.equal(app.state().panes[1].tabs.length, length);
});

test('each tab restores its selected file, search, sort direction and scroll position', t => {
  const app = createApp(t);
  select(app, 'README.md');
  app.click(pane(app).querySelector('[data-sort="size"]'));
  app.click(pane(app).querySelector('[data-sort="size"]'));
  pane(app).querySelector('.list').scrollTop = 133;
  for (const character of 'README') app.key(character);
  const originalCursor = app.state().panes[0].cursor;
  app.click(tab(app, 1)); select(app, 'architecture.md');
  app.click(pane(app).querySelector('[data-sort="date"]'));
  assert.equal(app.state().panes[0].filter, '');
  app.click(tab(app, 0));
  assert.equal(app.state().panes[0].cursor, originalCursor);
  assert.equal(app.row('README.md').getAttribute('aria-selected'), 'true');
  assert.equal(app.state().panes[0].filter, 'README');
  assert.equal(app.state().panes[0].sort, 'size');
  assert.equal(app.state().panes[0].descending, true);
  assert.equal(pane(app).querySelector('.list').scrollTop, 133);
});

test('a quick double click opens a directory instead of starting inline rename', async t => {
  const app = createApp(t); let now = 1000; app.window.Date.now = () => now;
  select(app, 'docs'); now += 100;
  select(app, 'docs', { detail: 2 });
  app.row('docs').querySelector('[data-filename]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  assert.equal(pane(app).querySelector('.path-input').value, '/workspace/bitfroest/docs');
  await delay(400);
  assert.equal(app.document.querySelector('.inline-rename'), null);
});

test('a real pointer double-click on the parent icon navigates up without marquee capture', t => {
  for (const part of ['filename', 'fileicon']) {
    const app = createApp(t);
    select(app, 'docs');
    app.row('docs').querySelector('[data-filename]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    assert.equal(pane(app).querySelector('.path-input').value, '/workspace/bitfroest/docs');
    const list = pane(app).querySelector('.list'), parent = list.querySelector('[data-parent]'), target = parent.querySelector(`.${part}`);
    let captures = 0;
    list.setPointerCapture = () => { captures++; };
    for (let click = 0; click < 2; click++) {
      pointer(app, 'pointerdown', target, { pointerId: 9, clientX: 20, clientY: 20 });
      pointer(app, 'pointerup', target, { pointerId: 9, clientX: 20, clientY: 20 });
      target.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, detail: click + 1 }));
    }
    target.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    assert.equal(pane(app).querySelector('.path-input').value, '/workspace/bitfroest');
    assert.equal(captures, 0);
    assert.equal(list.querySelector('.selection-marquee'), null);
  }
});

test('a delayed second click starts inline rename and Escape restores the original name', async t => {
  const app = createApp(t); let now = 1000; app.window.Date.now = () => now;
  select(app, 'README.md'); now += 700;
  select(app, 'README.md'); await delay(400);
  const input = app.document.querySelector('.inline-rename');
  assert.ok(input);
  assert.equal(input.selectionEnd, 'README.md'.length);
  input.value = 'discarded.md'; app.key('Escape', {}, input);
  assert.ok(app.row('README.md')); assert.equal(app.row('discarded.md'), undefined);
  assert.equal(app.document.querySelector('.inline-rename'), null);
});

test('Shift-click extends a contiguous range and Ctrl-click toggles a single entry', t => {
  const app = createApp(t);
  select(app, 'assets'); select(app, 'src', { shiftKey: true });
  const expected = ['assets', 'docs', 'src'];
  assert.deepEqual([...pane(app).querySelectorAll('tr.selected [data-filename]')].map(element => element.textContent), expected);
  select(app, 'docs', { ctrlKey: true });
  assert.deepEqual([...pane(app).querySelectorAll('tr.selected [data-filename]')].map(element => element.textContent), ['assets', 'src']);
  select(app, 'README.md', { ctrlKey: true });
  assert.equal(app.state().panes[0].selected.length, 3);
});

test('a search without matches keeps the current entry while Backspace and Escape update the query', t => {
  const app = createApp(t);
  select(app, 'README.md'); const originalCursor = app.state().panes[0].cursor;
  const entries = pane(app).querySelectorAll('tr[data-id]').length;
  app.key('z'); app.key('z');
  assert.equal(app.state().panes[0].cursor, originalCursor);
  assert.equal(pane(app).querySelectorAll('tr[data-id]').length, entries);
  assert.equal(pane(app).querySelector('mark'), null);
  app.key('Backspace'); assert.equal(app.state().panes[0].filter, 'z');
  app.key('Escape'); assert.equal(app.state().panes[0].filter, '');
  assert.equal(app.state().panes[0].cursor, originalCursor);
  assert.equal(app.document.querySelector('dialog').open, false);
});

test('path entry accepts known folders and leaves the source unchanged for invalid paths', t => {
  const app = createApp(t);
  let input = pane(app).querySelector('.path-input'); input.focus(); input.value = '/not-present'; app.key('Enter', {}, input);
  assert.equal(app.state().panes[0].tabs[0], '/workspace/bitfroest');
  assert.match(app.document.querySelector('#status-message').textContent, /nicht vorhanden/);
  input = pane(app).querySelector('.path-input'); input.value = '/workspace/bitfroest/docs/'; app.key('Enter', {}, input);
  assert.equal(app.state().panes[0].tabs[0], '/workspace/bitfroest/docs');
  assert.ok(app.row('architecture.md'));
  input = pane(app).querySelector('.path-input'); input.focus(); input.value = '/discard'; app.key('Escape', {}, input);
  assert.equal(pane(app).querySelector('.path-input').value, '/workspace/bitfroest/docs');
});

test('real filesystem navigation loads an unknown parent instead of rejecting example data', t => {
  const pane = () => ({ tabs: ['C:/git/zwork/gb-src-mirror/node-rpt'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'parent', active: 0, panes: [pane(), pane()], folders: { 'C:/git/zwork/gb-src-mirror/node-rpt': [] } });
  app.document.querySelector('.pane.active [data-parent]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  const request = app.messages.find(message => message.type === 'filesystem-navigate');
  assert.ok(request); assert.equal(request.path, 'C:/git/zwork/gb-src-mirror');
  assert.equal(app.state().panes[0].tabs[0], 'C:/git/zwork/gb-src-mirror/node-rpt');
  const fresh = app.state(); fresh.snapshotId = 'parent-loaded'; fresh.folders[request.path] = [];
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh, resumeNavigation: { path: request.path, side: 0 } } }));
  assert.equal(app.state().panes[0].tabs[0], request.path);
  assert.equal(app.document.querySelector('.pane.active .path-input').value, 'C:\\git\\zwork\\gb-src-mirror');
});
