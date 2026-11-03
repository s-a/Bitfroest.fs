const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./support/webview.cjs');

function setup(t) {
  const pane = path => ({ tabs: [path], tab: 0, cursor: 'a', selected: ['a'], sort: 'name' });
  const app = createApp(t, { version: 1, active: 0, realFilesystem: true, snapshotId: 'rename-text',
    panes: [pane('C:/left'), pane('C:/right')], folders: {
      'C:/left': [{ id: 'a', name: 'original.txt', type: 'text', fsSource: 'C:/left/original.txt' }], 'C:/right': []
    } });
  app.action('rename-one');
  app.input = app.document.querySelector('.inline-rename');
  return app;
}

function mouse(app, type, target = app.input, extra = {}) {
  const event = new app.window.MouseEvent(type, { bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event);
  return event;
}

test('inline name selection leaves mouse defaults intact and never opens or drags the file', t => {
  const app = setup(t), input = app.input, row = input.closest('tr');
  assert.equal(row.draggable, false);
  input.value = 'editable.txt'; input.setSelectionRange(1, 5);
  for (const type of ['pointerdown', 'mousedown', 'pointermove', 'mouseup', 'click', 'dblclick']) {
    assert.equal(mouse(app, type).defaultPrevented, false, type);
    assert.equal(app.document.activeElement, input, type);
    assert.equal(app.document.querySelector('.inline-rename'), input, type);
    assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 5);
  }
  const writes = [];
  const drag = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(drag, 'dataTransfer', { value: { setData: (...args) => writes.push(args) } });
  input.dispatchEvent(drag);
  assert.equal(drag.defaultPrevented, false);
  assert.deepEqual(writes, []);
  mouse(app, 'dragover', app.document.querySelector('[data-pane="1"] .list'));
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
  assert.equal(mouse(app, 'dragstart', row).defaultPrevented, true);
  assert.equal(app.messages.some(message => ['open', 'filesystem-apply', 'shell-context-menu'].includes(message.type)), false);
});

for (const keyboard of [false, true]) {
  test(`inline text context keeps the proposal and selection through menu focus loss (${keyboard ? 'keyboard' : 'mouse'})`, t => {
    const app = setup(t), input = app.input;
    input.value = 'proposal.txt'; input.setSelectionRange(2, 7);
    if (!keyboard) mouse(app, 'pointerdown', input, { button: 2, buttons: 2 });
    const event = mouse(app, 'contextmenu', input, { button: keyboard ? 0 : 2 });
    assert.equal(event.defaultPrevented, false);
    assert.equal(JSON.parse(input.dataset.vscodeContext).webviewSection, 'textInput');
    assert.equal(JSON.parse(input.dataset.vscodeContext).preventDefaultContextMenuItems, false);
    input.blur();
    assert.equal(app.document.querySelector('.inline-rename'), input);
    app.window.dispatchEvent(new app.window.Event('blur'));
    app.window.dispatchEvent(new app.window.Event('focus'));
    input.focus();
    assert.equal(input.value, 'proposal.txt');
    assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
    assert.equal(app.document.querySelector('[data-context-popup]'), null);
    assert.equal(app.messages.some(message => ['shell-context-menu', 'filesystem-apply'].includes(message.type)), false);
    assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).inlineRename, true);
    input.setRangeText('changed', 2, 7, 'end'); app.key('Enter', {}, input);
    assert.equal(app.state().folders['C:/left'][0].name, 'prchangedl.txt');
    assert.ok(app.messages.some(message => message.type === 'filesystem-apply'));
  });
}

for (const end of ['escape', 'outside-click', 'outside-right-click']) {
  test(`inline rename restores file dragging after ${end}`, t => {
    const app = setup(t), input = app.input, row = input.closest('tr');
    if (end === 'escape') input.value = 'discard.txt';
    if (end === 'escape') app.key('Escape', {}, input);
    else mouse(app, 'pointerdown', app.document.querySelector('.path-input'), { button: end === 'outside-right-click' ? 2 : 0 });
    assert.equal(app.document.querySelector('.inline-rename'), null);
    assert.equal(app.row('original.txt').draggable, true);
    assert.equal(row.draggable, true);
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
    app.action('rename-one');
    const next = app.document.querySelector('.inline-rename'); assert.ok(next);
    next.focus(); assert.equal(app.document.activeElement, next);
  });
}

test('ordinary focus loss preserves an edited proposal until an explicit outside click or Escape', t => {
  const app = setup(t), input = app.input;
  input.value = 'keep-proposal.txt'; input.setSelectionRange(1, 4);
  app.document.querySelector('.path-input').focus();
  assert.equal(app.document.querySelector('.inline-rename'), input);
  input.focus();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'window-focus' } }));
  assert.equal(app.messages.some(message => message.type === 'filesystem-refresh'), false);
  assert.equal(input.value, 'keep-proposal.txt');
  assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 4);
  app.key('Escape', {}, input);
  assert.equal(app.document.querySelector('.inline-rename'), null);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

for (const trigger of ['pointerdown', 'click']) {
  test(`outside ${trigger} confirms edited text once and preserves the clicked control`, t => {
    const app = setup(t), input = app.input;
    input.value = 'confirmed.txt';
    const destination = app.document.querySelector('.path-input');
    mouse(app, trigger, destination);
    destination.focus();
    if (trigger === 'pointerdown') mouse(app, 'click', destination);
    assert.equal(app.document.querySelector('.inline-rename'), null);
    assert.equal(app.document.activeElement, destination);
    assert.equal(destination.isConnected, true);
    assert.equal(app.state().folders['C:/left'][0].name, 'confirmed.txt');
    assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
  });
}

test('an invalid outside confirmation keeps editing and prevents the outside action', t => {
  const app = setup(t); app.input.value = 'bad?name';
  const event = mouse(app, 'pointerdown', app.document.querySelector('.path-input'));
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.document.activeElement, app.input);
  assert.equal(app.document.querySelector('.inline-rename'), app.input);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
