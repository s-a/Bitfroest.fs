const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function dispatch(app, target, key, modifiers = {}, type = 'keydown') {
  const event = new app.window.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

test('all keyboard events stay inside the document across lists, inputs, buttons and dialogs', t => {
  const app = createApp(t), escaped = [];
  for (const type of ['keydown', 'keyup']) app.window.addEventListener(type, event => escaped.push(event.key));
  const targets = [app.document.querySelector('.list'), app.document.querySelector('.path-input'), app.document.querySelector('#language-toggle')];
  app.action('mkdir'); targets.push(app.document.querySelector('#value'), app.document.querySelector('#modal-cancel'));
  for (const target of targets) for (const [key, modifiers] of [['q', { ctrlKey: true }], ['n', { ctrlKey: true, shiftKey: true }], ['k', { ctrlKey: true }], ['F12', {}], ['F4', { altKey: true }], ['a', {}]]) {
    for (const type of ['keydown', 'keyup']) dispatch(app, target, key, modifiers, type);
  }
  assert.deepEqual(escaped, []);
});

test('text editing defaults and local dialog and list actions remain available', t => {
  const app = createApp(t), input = app.document.querySelector('.path-input');
  input.focus();
  for (const [key, modifiers] of [['a', {}], ['ArrowLeft', { ctrlKey: true }], ['a', { ctrlKey: true }], ['c', { ctrlKey: true }], ['v', { ctrlKey: true }], ['z', { ctrlKey: true }], ['@', { ctrlKey: true, altKey: true }]]) {
    assert.equal(dispatch(app, input, key, modifiers).defaultPrevented, false, key);
  }
  assert.equal(dispatch(app, input, 'n', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(dispatch(app, input, 'F12').defaultPrevented, true);
  app.document.querySelector('.list').focus(); app.key('F7');
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('Ctrl L selects the entire active path, including when already editing it', t => {
  const app = createApp(t);
  for (const side of [0, 1]) {
    app.document.querySelectorAll('.list')[side].focus(); app.key('l', { ctrlKey: true });
    const input = app.document.querySelectorAll('.path-input')[side];
    assert.equal(app.document.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [0, input.value.length]);
    input.setSelectionRange(1, 1); app.key('L', { ctrlKey: true });
    assert.deepEqual([input.selectionStart, input.selectionEnd], [0, input.value.length]);
  }
});

test('Ctrl Shift L requests clipboard text once and opens the checked directory', t => {
  const app = createApp(t);
  app.key('L', { ctrlKey: true, shiftKey: true });
  const request = app.messages.find(message => message.type === 'clipboard-path-read');
  assert.ok(request);
  const input = app.document.activeElement;
  assert.equal(input.className, 'path-input');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, path: app.state().panes[1].tabs[0] } }));
  assert.equal(app.state().panes[0].tabs[0], app.state().panes[1].tabs[0]);
  assert.equal(app.document.activeElement.className, 'list');
});

test('clipboard errors and answers after focus changes do not navigate', t => {
  for (const change of ['error', 'pane', 'blur', 'typing']) {
    const app = createApp(t), before = JSON.stringify(app.state().panes);
    app.key('l', { ctrlKey: true, shiftKey: true });
    const request = app.messages.find(message => message.type === 'clipboard-path-read'); assert.ok(request);
    if (change === 'pane') app.document.querySelectorAll('.list')[1].focus();
    if (change === 'blur') app.window.dispatchEvent(new app.window.Event('blur'));
    if (change === 'typing') { app.document.activeElement.value = 'new input'; app.document.activeElement.dispatchEvent(new app.window.Event('input', { bubbles: true })); }
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: change !== 'error', error: 'Unavailable', path: app.state().panes[1].tabs[0] } }));
    assert.equal(JSON.stringify(app.state().panes), before, change);
  }
});

test('clipboard navigation acknowledgement after window blur does not switch the tab or restore focus', t => {
  const pane = path => ({ tabs: [path], tab: 0, filter: '', sort: 'name', selected: [], cursor: null });
  const initial = { version: 1, realFilesystem: true, active: 0, snapshotId: 'before', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, initial);
  app.key('l', { ctrlKey: true, shiftKey: true });
  const request = app.messages.find(message => message.type === 'clipboard-path-read');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, path: 'C:/temp' } }));
  assert.ok(app.messages.find(message => message.type === 'filesystem-navigate'));
  app.window.dispatchEvent(new app.window.Event('blur'));
  let focusCalls = 0; app.window.HTMLElement.prototype.focus = () => { focusCalls++; };
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: initial } }));
  assert.equal(app.state().panes[0].tabs[0], 'C:/tmp');
  assert.equal(focusCalls, 0);
});

test('unknown modified keys do not fall back to unmodified file operations', t => {
  for (const [key, modifiers] of [['Delete', { ctrlKey: true }], ['Enter', { ctrlKey: true }], ['Backspace', { ctrlKey: true }], ['Delete', { altKey: true }], ['Enter', { altKey: true }], ['r', { ctrlKey: true, altKey: true }], ['a', { ctrlKey: true, shiftKey: true }]]) {
    const app = createApp(t); app.click(app.row('README.md').querySelector('[data-filename]'));
    const before = JSON.stringify(app.state()); const count = app.messages.length;
    app.key(key, modifiers);
    assert.equal(app.document.querySelector('#modal').open, false, key);
    assert.equal(JSON.stringify(app.state()), before, `${key} ${JSON.stringify(modifiers)}`);
    assert.equal(app.messages.slice(count).some(message => ['open-file', 'filesystem-apply', 'filesystem-navigate'].includes(message.type)), false);
  }
});

test('checked Windows paths use the matching model directory regardless of letter case', t => {
  const pane = path => ({ tabs: [path], tab: 0, filter: '', sort: 'name', selected: [], cursor: null });
  const initial = { version: 1, realFilesystem: true, active: 0, snapshotId: 'before', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, initial);
  app.key('l', { ctrlKey: true, shiftKey: true });
  const request = app.messages.find(message => message.type === 'clipboard-path-read');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, path: 'c:/TEMP' } }));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: initial } }));
  assert.equal(app.state().panes[0].tabs[0], 'C:/temp');
});
