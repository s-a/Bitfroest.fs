const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': [{ id: 'a', name: 'a.txt', type: 'text', content: 'a' }, { id: 'b', name: 'b.txt', type: 'text', content: 'b' }], '/right': [{ id: 'folder', name: 'target', type: 'folder' }], '/right/target': [] } };
  state.panes[0].selected = ['a', 'b']; state.panes[0].cursor = 'a'; state.panes[1].tabs.push('/right/target'); return state;
}
function pointer(app, type, target, extra = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 2, buttons: type === 'pointerup' ? 0 : 2, pointerId: 7, clientX: 5, clientY: 5, ...extra })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
}

test('column context remains available after a cancelled right drag without a further pointer press', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('a.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  pointer(app, 'pointercancel', target);
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
  app.document.querySelector('.ag-header-cell-label').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});
function gesture(app, target, extra = {}) {
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointermove', target, { clientX: 500, clientY: 200, ...extra });
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200, ...extra });
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

test('right dragging onto the source list or a tab for the same path offers no action', t => {
  for (const selector of ['[data-pane="0"] .list', '[data-pane="1"] [data-tab="0"]']) {
    const saved = fixture(); saved.panes[1].tabs[0] = '/left';
    const app = createApp(t, saved), target = app.document.querySelector(selector);
    pointer(app, 'pointerdown', app.row('a.txt'));
    pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
    assert.equal(app.document.querySelector('.drop-target'), null);
    pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
    assert.equal(app.messages.some(item => item.type === 'choose-drop-action'), false);
    assert.equal(app.document.querySelector('#modal').open, false);
  }
});
test('right pointer drag shows move feedback and opens move confirmation directly', async t => {
  const app = createApp(t, fixture()), before = JSON.stringify(app.state().folders);
  const target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('a.txt'));
  pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  assert.equal(app.document.querySelector('.file-drag-feedback')?.dataset.mode, 'move');
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.messages.some(item => item.type === 'choose-drop-action'), false);
  assert.match(app.document.querySelector('#modal-title').textContent, /verschieben/i);
  assert.equal(app.document.querySelector('#value').value, '/right');
  assert.equal(JSON.stringify(app.state().folders), before);
  submit(app); await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.state().folders['/right'].some(file => file.name === 'a.txt'));
  assert.equal(app.state().folders['/left'].length, 0);
});
test('right drag captures folder and inactive-tab destinations without navigating there', t => {
  for (const selector of ['[data-pane="1"] [data-file-row][data-id="folder"]', '[data-pane="1"] [data-tab="1"]']) {
    const app = createApp(t, fixture()); gesture(app, app.document.querySelector(selector));
    assert.equal(app.document.querySelector('#value').value, '/right/target'); assert.equal(app.state().panes[1].tab, 0);
    assert.match(app.document.querySelector('#modal-title').textContent, /verschieben/i);
  }
});
test('right-drag cancellation, unsupported links and short right clicks cannot transfer files', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list'), before = JSON.stringify(app.state().folders);
  gesture(app, target); app.document.querySelector('#modal-cancel').click(); assert.equal(app.document.querySelector('#modal').open, false);
  gesture(app, target, { ctrlKey: true, shiftKey: true }); assert.equal(app.messages.filter(item => item.type === 'choose-drop-action').length, 0);
  assert.equal(app.document.querySelector('#modal').open, false);
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  app.key('Escape'); pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.document.querySelector('#modal').open, false);
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointerup', app.row('a.txt'));
  const context = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); app.row('a.txt').dispatchEvent(context);
  assert.equal(context.defaultPrevented, false); assert.equal(JSON.stringify(app.state().folders), before);
});
test('changed drag sources and removed targets are rejected before move confirmation completes', t => {
  for (const change of ['source', 'target']) {
    const saved = { ...fixture(), realFilesystem: true, snapshotId: 'before' };
    const app = createApp(t, saved); gesture(app, app.document.querySelector('[data-pane="1"] [data-file-row][data-id="folder"]'));
    const changed = fixture();
    if (change === 'source') changed.folders['/left'][0].name = 'different.txt';
    else { changed.folders['/right'] = []; delete changed.folders['/right/target']; changed.panes[1].tabs = ['/right']; }
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: { ...changed, realFilesystem: true, snapshotId: 'after' } } }));
    assert.equal(app.state().snapshotId, 'after');
    submit(app);
    assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false); assert.equal(app.state().folders['/right'].length, change === 'source' ? 1 : 0);
  }
});
test('right drag suppresses its generated context menu and duplicate pointer releases retain the move confirmation', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list'); gesture(app, target);
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  const context = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); target.dispatchEvent(context);
  assert.equal(context.defaultPrevented, true); assert.equal(app.messages.filter(item => item.type === 'choose-drop-action').length, 0);
  assert.match(app.document.querySelector('#modal-title').textContent, /verschieben/i);
});
test('a dialog opened during a right gesture is not overlaid by a drop picker', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  app.action('mkdir'); pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.messages.some(item => item.type === 'choose-drop-action'), false); assert.equal(app.document.querySelector('#modal').open, true);
});

for (const end of ['pointerup', 'pointercancel', 'blur', 'pagehide', 'escape']) test(`right drag previews the whole selection over its source and cleans up on ${end}`, t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="0"] .list');
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', target, { clientX: 100, clientY: 100 });
  const feedback = app.document.querySelector('.file-drag-feedback');
  assert.ok(feedback);
  assert.equal(feedback.dataset.mode, 'move');
  assert.equal(feedback.dataset.allowed, 'false');
  assert.equal(feedback.dataset.count, '2');
  assert.match(feedback.textContent, /a\.txt/); assert.match(feedback.textContent, /b\.txt/);
  assert.equal(app.document.body.dataset.fileDragCursor, 'none');
  assert.equal(app.document.querySelector('.drop-target'), null);
  if (end === 'blur' || end === 'pagehide') app.window.dispatchEvent(new app.window.Event(end));
  else if (end === 'escape') app.key('Escape');
  else pointer(app, end, target);
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
  assert.equal(app.document.body.dataset.fileDragCursor, undefined);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('large right-drag selections show five names and the complete count without losing entries', t => {
  const saved = fixture();
  for (let index = 0; index < 8; index++) { saved.folders['/left'].push({ id: `extra${index}`, name: `extra${index}.txt`, type: 'text' }); saved.panes[0].selected.push(`extra${index}`); }
  const app = createApp(t, saved);
  pointer(app, 'pointerdown', app.row('b.txt'));
  pointer(app, 'pointermove', app.document.querySelector('[data-pane="1"] .list'), { clientX: 500, clientY: 200 });
  const preview = app.document.querySelector('.file-drag-preview');
  assert.equal(preview.dataset.count, '10'); assert.equal(preview.querySelectorAll('.file-drag-row').length, 5);
  assert.match(preview.textContent, /\+5/);
  assert.equal(app.state().panes[0].selected.length, 10);
  pointer(app, 'pointercancel', app.document.body);
});
