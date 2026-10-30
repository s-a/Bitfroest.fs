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
  app.document.querySelector('thead th button').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});
function gesture(app, target, extra = {}) {
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointermove', target, { clientX: 500, clientY: 200, ...extra });
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200, ...extra });
  return app.messages.find(item => item.type === 'choose-drop-action');
}
const reply = (app, request, action) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'drop-action-result', requestId: request.requestId, action } }));
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
test('right pointer drag offers a choice before the normal copy or move confirmation', async t => {
  for (const mode of ['copy', 'move']) {
    const app = createApp(t, fixture()), before = JSON.stringify(app.state().folders);
    const request = gesture(app, app.document.querySelector('[data-pane="1"] .list')); assert.ok(request);
    assert.equal(JSON.stringify(app.state().folders), before); assert.equal(app.document.querySelector('#modal').open, false);
    reply(app, request, mode); assert.equal(app.document.querySelector('#value').value, '/right');
    assert.equal(JSON.stringify(app.state().folders), before); submit(app); await new Promise(resolve => setImmediate(resolve));
    assert.ok(app.state().folders['/right'].some(file => file.name === 'a.txt')); assert.equal(app.state().folders['/left'].length, mode === 'copy' ? 2 : 0);
  }
});
test('right drag captures folder and inactive-tab destinations without navigating there', t => {
  for (const selector of ['[data-pane="1"] tr[data-id="folder"]', '[data-pane="1"] [data-tab="1"]']) {
    const app = createApp(t, fixture()), request = gesture(app, app.document.querySelector(selector)); assert.ok(request);
    reply(app, request, 'copy'); assert.equal(app.document.querySelector('#value').value, '/right/target'); assert.equal(app.state().panes[1].tab, 0);
  }
});
test('right-drag cancellation, unsupported links and short right clicks cannot transfer files', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list'), before = JSON.stringify(app.state().folders);
  const request = gesture(app, target); assert.ok(request); reply(app, request, 'cancel'); assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(gesture(app, target, { ctrlKey: true, shiftKey: true }), request); assert.equal(app.messages.filter(item => item.type === 'choose-drop-action').length, 1);
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointerup', app.row('a.txt'));
  const context = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); app.row('a.txt').dispatchEvent(context);
  assert.equal(context.defaultPrevented, false); assert.equal(JSON.stringify(app.state().folders), before);
});
test('changed drag sources and removed targets are rejected after the native menu and before confirmation', t => {
  for (const phase of ['menu', 'confirmation']) for (const change of ['source', 'target']) {
    const app = createApp(t, fixture()), request = gesture(app, app.document.querySelector('[data-pane="1"] tr[data-id="folder"]')); assert.ok(request);
    if (phase === 'confirmation') reply(app, request, 'copy');
    const changed = fixture();
    if (change === 'source') changed.folders['/left'][0].name = 'different.txt';
    else { changed.folders['/right'] = []; delete changed.folders['/right/target']; changed.panes[1].tabs = ['/right']; }
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: { ...changed, realFilesystem: true } } }));
    if (phase === 'menu') reply(app, request, 'move'); else submit(app);
    assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false); assert.equal(app.state().folders['/right'].length, change === 'source' ? 1 : 0);
  }
});
test('right drag suppresses its generated context menu and duplicate pointer releases cannot offer another choice', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list'); gesture(app, target);
  pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  const context = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); target.dispatchEvent(context);
  assert.equal(context.defaultPrevented, true); assert.equal(app.messages.filter(item => item.type === 'choose-drop-action').length, 1);
});
test('a dialog opened during a right gesture is not overlaid by a drop picker', t => {
  const app = createApp(t, fixture()), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.row('a.txt')); pointer(app, 'pointermove', target, { clientX: 500, clientY: 200 });
  app.action('mkdir'); pointer(app, 'pointerup', target, { clientX: 500, clientY: 200 });
  assert.equal(app.messages.some(item => item.type === 'choose-drop-action'), false); assert.equal(app.document.querySelector('#modal').open, true);
});
