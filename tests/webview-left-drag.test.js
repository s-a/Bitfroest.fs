const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'a.txt', type: 'text', content: 'a' }, { id: 'b', name: 'b.txt', type: 'text', content: 'b' }],
    '/right': [{ id: 'folder', name: 'target', type: 'folder' }], '/right/target': []
  } };
  state.panes[0].selected = ['a', 'b']; state.panes[0].cursor = 'a'; state.panes[1].tabs.push('/right/target');
  return state;
}
function pointer(app, type, target, extra = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, clientX: 5, clientY: 5, ...extra })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
}

for (const modifiers of [{}, { shiftKey: true }, { altKey: true }]) test(`left pointer drag immediately previews the selection and confirms ${JSON.stringify(modifiers)}`, async t => {
  const app = createApp(t, fixture()), before = JSON.stringify(app.state().folders);
  const source = app.row('b.txt').querySelector('[data-filename]'), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', source);
  const native = new app.window.Event('dragstart', { bubbles: true, cancelable: true }); source.dispatchEvent(native);
  assert.equal(native.defaultPrevented, true);
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200, ...modifiers });
  const feedback = app.document.querySelector('.file-drag-feedback');
  assert.ok(feedback); assert.equal(feedback.dataset.count, '2');
  assert.equal(feedback.dataset.mode, modifiers.shiftKey || modifiers.altKey ? 'move' : 'copy');
  assert.deepEqual([...feedback.querySelectorAll('.file-drag-row')].map(row => row.getAttribute('aria-label')), ['a.txt', 'b.txt']);
  assert.ok(target.classList.contains('drop-target')); assert.equal(app.document.querySelector('.selection-marquee'), null);
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200, ...modifiers });
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.match(app.document.querySelector('#modal-title').textContent, modifiers.shiftKey || modifiers.altKey ? /verschieben/i : /kopieren/i);
  assert.equal(JSON.stringify(app.state().folders), before);
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state().folders['/right'].length, 3);
  assert.equal(app.state().folders['/left'].length, modifiers.shiftKey || modifiers.altKey ? 0 : 2);
});

for (const selector of ['[data-pane="1"] [data-id="folder"]', '[data-pane="1"] [data-tab="1"]']) test(`left pointer drop retains destination ${selector}`, t => {
  const app = createApp(t, fixture()), target = app.document.querySelector(selector);
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#value').value, '/right/target'); assert.equal(app.state().panes[1].tab, 0);
});

for (const end of ['pointercancel', 'blur', 'pagehide', 'escape']) test(`left pointer drag cleans up on ${end}`, t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  assert.ok(app.document.querySelector('.file-drag-feedback'));
  if (end === 'blur' || end === 'pagehide') app.window.dispatchEvent(new app.window.Event(end));
  else if (end === 'escape') app.key('Escape');
  else pointer(app, end, target);
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
  assert.equal(app.document.body.dataset.fileDragCursor, undefined);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('left drag ignores a different pointer and cannot drop on the source path or create unsupported links', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { pointerId: 8, clientX: 500 });
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
  pointer(app, 'pointerup', target, { pointerId: 8 });
  pointer(app, 'pointermove', app.row('b.txt'), { clientX: 100 });
  assert.equal(app.document.querySelector('.file-drag-feedback')?.dataset.allowed, 'false');
  pointer(app, 'pointerup', app.row('b.txt'), { clientX: 100 });
  assert.equal(app.document.querySelector('#modal').open, false);
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, ctrlKey: true, shiftKey: true });
  pointer(app, 'pointerup', target, { clientX: 500, ctrlKey: true, shiftKey: true });
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('only right dragging on empty list space creates a selection rectangle', t => {
  for (const button of [0, 2]) {
    const app = createApp(t, fixture()), list = app.document.querySelector('[data-pane="0"] .list');
    list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 300 });
    [...list.querySelectorAll('[data-file-row][data-id]')].forEach((row, index) => { row.getBoundingClientRect = () => ({ left: 0, top: 30 + index * 22, right: 600, bottom: 50 + index * 22 }); });
    pointer(app, 'pointerdown', list, { button, buttons: button === 2 ? 2 : 1, clientX: 590, clientY: 200 });
    pointer(app, 'pointermove', list, { button, buttons: button === 2 ? 2 : 1, clientX: 10, clientY: 55 });
    assert.equal(Boolean(list.querySelector('.selection-marquee')), button === 2);
    pointer(app, 'pointerup', list, { button, clientX: 10, clientY: 55 });
    assert.deepEqual(app.state().panes[0].selected, button === 2 ? ['b'] : ['a', 'b']);
    const context = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); list.dispatchEvent(context);
    assert.equal(context.defaultPrevented, button === 2);
    assert.equal(app.document.querySelector('#modal').open, false);
  }
});

test('left pointer drag keeps the F8 deletion target and suppresses the trailing click', t => {
  const app = createApp(t, fixture()), button = app.document.querySelector('#functionbar [data-action="delete"]');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', button, { clientX: 100, clientY: 600 });
  assert.ok(button.classList.contains('drop-target'));
  pointer(app, 'pointerup', button, { clientX: 100, clientY: 600 });
  const dialog = app.document.querySelector('#modal');
  assert.equal(dialog.open, true);
  assert.match(app.document.querySelector('#modal-title').textContent, /löschen/i);
  const title = app.document.querySelector('#modal-title').textContent;
  const click = new app.window.MouseEvent('click', { bubbles: true, cancelable: true }); button.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(app.document.querySelector('#modal-title').textContent, title);
  assert.equal(app.state().folders['/left'].length, 2);
});

test('left pointer drag retains source signatures through confirmation', t => {
  const app = createApp(t, { ...fixture(), realFilesystem: true, snapshotId: 'before' });
  const target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.document.querySelector('#modal').open, true);
  const changed = fixture(); changed.folders['/left'][0].name = 'changed.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: { ...changed, realFilesystem: true, snapshotId: 'after' } } }));
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('left pointer confirmation rejects a switch to another tab at the same source path', t => {
  const app = createApp(t, { ...fixture(), realFilesystem: true, snapshotId: 'before' });
  const target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  const changed = structuredClone(app.state());
  const p = changed.panes[0]; p.tabs.push('/left'); p.tabStates.push({ ...p.tabStates[0], id: 'another-tab' }); p.tab = 1;
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: changed } }));
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('a thousand marked rows produce five preview rows while the complete selection reaches the host', async t => {
  const saved = fixture(); saved.realFilesystem = true; saved.snapshotId = 'large';
  for (let index = 2; index < 1000; index++) {
    const id = `extra${index}`;
    saved.folders['/left'].push({ id, name: `${id}.txt`, type: 'text' }); saved.panes[0].selected.push(id);
  }
  const app = createApp(t, saved), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  const preview = app.document.querySelector('.file-drag-feedback .file-drag-preview');
  assert.equal(preview.dataset.count, '1000'); assert.equal(preview.querySelectorAll('.file-drag-row').length, 5);
  assert.equal(preview.querySelector('.file-drag-more').textContent, '+995');
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  for (let attempt = 0; attempt < 50 && !app.messages.some(message => message.type === 'filesystem-apply'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const request = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
  assert.deepEqual([...request.transfer.ids], [...saved.panes[0].selected]);
  assert.equal(app.state().folders['/left'].length, 1000);
});
