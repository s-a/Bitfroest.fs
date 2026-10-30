const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  return {
    version: 1, active: 0, panes: [pane('/left'), pane('/right')],
    folders: {
      '/left': [{ id: '1', name: 'a.txt', type: 'text', size: 1 }, { id: '2', name: 'b.txt', type: 'text', size: 1 }, { id: '3', name: 'c.txt', type: 'text', size: 1 }],
      '/right': [{ id: '4', name: 'target', type: 'folder', size: 0 }],
      '/right/target': []
    }
  };
}

function pointer(app, type, target, properties = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: 10, clientY: 10, ...properties })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

function layout(app) {
  const list = app.document.querySelector('[data-pane="0"] .list');
  list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300 });
  [...list.querySelectorAll('tr[data-id]')].forEach((row, index) => { row.getBoundingClientRect = () => ({ left: 0, top: 30 + index * 22, right: 600, bottom: 50 + index * 22, width: 600, height: 20 }); });
  return list;
}

function drag(app, type, target, transfer, properties = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

function transfer() {
  const values = new Map();
  return { effectAllowed: '', dropEffect: '', setData(key, value) { values.set(key, value); }, getData(key) { return values.get(key) || ''; } };
}

function name(app, text) { return app.row(text).querySelector('[data-filename]'); }

test('dragging from empty list space selects intersected files instead of selecting text', t => {
  const app = createApp(t, fixture()), list = layout(app);
  pointer(app, 'pointerdown', list, { clientX: 590, clientY: 200 });
  pointer(app, 'pointermove', list, { clientX: 10, clientY: 55 });
  pointer(app, 'pointerup', list, { clientX: 10, clientY: 55 });
  assert.deepEqual(app.state().panes[0].selected, ['2', '3']);
  const selectStart = new app.window.Event('selectstart', { bubbles: true, cancelable: true });
  name(app, 'b.txt').dispatchEvent(selectStart);
  assert.equal(selectStart.defaultPrevented, true);
  assert.equal(app.window.getSelection().toString(), '');
});

test('Ctrl rectangle selection extends the marked files and pointercancel restores them', t => {
  const app = createApp(t, fixture());
  app.click(name(app, 'a.txt'));
  const list = layout(app);
  pointer(app, 'pointerdown', list, { ctrlKey: true, clientX: 590, clientY: 200 });
  pointer(app, 'pointermove', list, { ctrlKey: true, clientX: 10, clientY: 55 });
  pointer(app, 'pointerup', list, { ctrlKey: true, clientX: 10, clientY: 55 });
  assert.deepEqual(app.state().panes[0].selected, ['1', '2', '3']);
  pointer(app, 'pointerdown', list, { clientX: 590, clientY: 200 });
  pointer(app, 'pointermove', list, { clientX: 10, clientY: 75 });
  pointer(app, 'pointercancel', list);
  assert.deepEqual(app.state().panes[0].selected, ['1', '2', '3']);
});

test('every data cell keeps native row clicks and file dragging while empty list space remains available for marquee selection', t => {
  for (const key of ['name', 'type', 'size', 'date', 'attributes']) {
    const app = createApp(t, fixture()), cell = app.row('a.txt').querySelector(`[data-cell="${key}"]`);
    assert.equal(pointer(app, 'pointerdown', cell).defaultPrevented, false, `${key} must retain its native click and drag gesture`);
    pointer(app, 'pointerup', cell); app.click(cell);
    assert.deepEqual(app.state().panes[0].selected, ['1']);
    const data = transfer(); drag(app, 'dragstart', cell, data);
    drag(app, 'drop', app.document.querySelector('[data-pane="1"] .list'), data);
    assert.equal(app.document.querySelector('dialog').open, true);
    assert.equal(app.document.querySelector('.inline-rename'), null);
  }
});

test('Shift rectangle selection adds files and the trailing click does not start rename', async t => {
  const app = createApp(t, fixture());
  let now = 1000; app.window.Date.now = () => now;
  app.click(name(app, 'a.txt')); const list = layout(app); now += 800;
  pointer(app, 'pointerdown', list, { shiftKey: true, clientX: 590, clientY: 200 });
  pointer(app, 'pointermove', list, { shiftKey: true, clientX: 10, clientY: 55 });
  pointer(app, 'pointerup', list, { shiftKey: true, clientX: 10, clientY: 55 });
  app.click(name(app, 'b.txt'));
  assert.deepEqual(app.state().panes[0].selected, ['1', '2', '3']);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(app.document.querySelector('.inline-rename'), null);
});

test('file drop on the other file list opens a copy dialog and Shift changes it to move', t => {
  for (const shiftKey of [false, true]) {
    const app = createApp(t, fixture()), data = transfer();
    app.click(name(app, 'a.txt')); app.click(name(app, 'b.txt'), { ctrlKey: true });
    assert.equal(app.row('a.txt').draggable, true);
    drag(app, 'dragstart', name(app, 'a.txt'), data);
    const destination = app.document.querySelector('[data-pane="1"] .list');
    const over = drag(app, 'dragover', destination, data, { shiftKey });
    assert.equal(over.defaultPrevented, true); assert.equal(data.dropEffect, shiftKey ? 'move' : 'copy');
    drag(app, 'drop', destination, data, { shiftKey });
    assert.equal(app.document.querySelector('dialog').open, true);
    assert.match(app.document.querySelector('#modal-title').textContent, shiftKey ? /verschieben/i : /kopieren/i);
    assert.equal(app.state().folders['/right'].length, 1);
  }
});

test('dropping a file on a directory row supplies that folder as the transfer target', t => {
  const app = createApp(t, fixture()), data = transfer();
  app.click(name(app, 'a.txt')); drag(app, 'dragstart', name(app, 'a.txt'), data);
  const folderRow = app.document.querySelector('[data-pane="1"] tr[data-id="4"]');
  drag(app, 'drop', folderRow, data);
  assert.equal(app.document.querySelector('dialog').open, true);
  const input = app.document.querySelector('#modal-body input');
  assert.equal(input.value, '/right/target');
  assert.equal(app.state().folders['/right/target'].length, 0);
});

test('dropping a file on an inactive folder tab uses its path without changing that tab', t => {
  const saved = fixture(); saved.panes[1].tabs.push('/right/target');
  const app = createApp(t, saved), data = transfer();
  app.click(name(app, 'a.txt')); drag(app, 'dragstart', name(app, 'a.txt'), data);
  drag(app, 'drop', app.document.querySelector('[data-pane="1"] [data-tab="1"]'), data);
  assert.equal(app.document.querySelector('dialog').open, true);
  assert.equal(app.document.querySelector('#modal-body input').value, '/right/target');
  assert.equal(app.state().panes[1].tab, 0);
});

test('Ctrl-Shift file drops cannot silently move files when link creation is unavailable',t=>{
 const app=createApp(t,fixture()),data=transfer();app.click(name(app,'a.txt'));drag(app,'dragstart',name(app,'a.txt'),data);const target=app.document.querySelector('[data-pane="1"] .list');
 drag(app,'dragover',target,data,{ctrlKey:true,shiftKey:true});assert.equal(data.dropEffect,'none');
 drag(app,'drop',target,data,{ctrlKey:true,shiftKey:true});assert.equal(app.document.querySelector('#modal').open,false);assert.equal(app.state().folders['/left'].length,3);assert.match(app.document.querySelector('#toast').textContent,/Verknüpfungen/);
});

test('source directory drops are rejected on rows, list space and either pane tab', t => {
  for (const shiftKey of [false, true]) for (const selector of ['[data-pane="0"] tr[data-id="1"]', '[data-pane="0"] .list', '[data-pane="0"] [data-tab="0"]', '[data-pane="1"] .list', '[data-pane="1"] [data-tab="0"]']) {
    const saved = fixture(); saved.panes[1].tabs = ['/left', '/right'];
    const app = createApp(t, saved), data = transfer(), before = JSON.stringify(app.state().folders);
    drag(app, 'dragstart', name(app, 'a.txt'), data);
    const validTarget = app.document.querySelector('[data-pane="1"] [data-tab="1"]');
    assert.equal(drag(app, 'dragover', validTarget, data, { shiftKey }).defaultPrevented, true);
    assert.ok(app.document.querySelector('.drop-target'));
    const target = app.document.querySelector(selector);
    const over = drag(app, 'dragover', target, data, { shiftKey });
    assert.equal(data.dropEffect, 'none', selector);
    assert.equal(over.defaultPrevented, false);
    assert.equal(app.document.querySelector('.drop-target'), null);
    drag(app, 'drop', target, data, { shiftKey });
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.equal(JSON.stringify(app.state().folders), before);
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  }
});

test('Windows source directory identity ignores drive and directory casing', t => {
  const saved = fixture();
  saved.folders['C:/Work'] = saved.folders['/left']; saved.folders['c:/work'] = saved.folders['/left'];
  saved.panes[0].tabs = ['C:/Work']; saved.panes[1].tabs = ['c:/work'];
  const app = createApp(t, saved), data = transfer();
  drag(app, 'dragstart', app.row('a.txt'), data);
  const target = app.document.querySelector('[data-pane="1"] .list');
  assert.equal(drag(app, 'dragover', target, data).defaultPrevented, false);
  assert.equal(data.dropEffect, 'none');
  drag(app, 'drop', target, data);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('selected folders reject their own subtree but allow sibling folders in the source pane', t => {
  for (const destination of ['/left/source', '/left/source/child', '/left/source-other']) {
    const saved = fixture();
    saved.folders['/left'].push({ id: 'folder', name: 'source', type: 'folder' }, { id: 'sibling', name: 'source-other', type: 'folder' });
    saved.folders['/left/source'] = [{ id: 'child', name: 'child', type: 'folder' }];
    saved.folders['/left/source/child'] = []; saved.folders['/left/source-other'] = [];
    saved.panes[0].tabs.push(destination);
    const app = createApp(t, saved), data = transfer();
    drag(app, 'dragstart', app.row('source'), data);
    const target = app.document.querySelector('[data-pane="0"] [data-tab="1"]');
    const allowed = destination === '/left/source-other';
    assert.equal(drag(app, 'dragover', target, data).defaultPrevented, allowed);
    assert.equal(data.dropEffect, allowed ? 'copy' : 'none');
    drag(app, 'drop', target, data);
    assert.equal(app.document.querySelector('#modal').open, allowed);
  }
});
