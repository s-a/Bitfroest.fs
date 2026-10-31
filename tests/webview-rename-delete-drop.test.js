const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'original', panes: [pane('C:/tmp'), pane('C:/temp')], folders: {
    'C:/tmp': [{ id: 'a', name: 'original.txt', type: 'text', fsSource: 'C:/tmp/original.txt', content: 'keep' }, { id: 'b', name: 'occupied.txt', type: 'text', content: 'other' }], 'C:/temp': []
  } };
}
const message = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
function drag(app, type, target, transfer = {}, modifiers = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, ...transfer } });
  for (const [key, value] of Object.entries(modifiers)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

test('F2 edits the current filename and Enter sends the existing rename operation', t => {
  const app = createApp(t, fixture());
  app.document.querySelector('.list').focus(); app.key('F2');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input);
  assert.equal(input.value, 'original.txt'); assert.equal(app.document.activeElement, input);
  assert.equal(app.messages.some(item => item.type === 'filesystem-refresh'), false);
  input.value = 'renamed.txt'; app.key('Enter', {}, input);
  assert.ok(app.messages.find(item => item.type === 'filesystem-apply'));
  assert.equal(app.state().folders['C:/tmp'][0].name, 'renamed.txt');
});

test('F2 rename cancels without changing files and does not start in text fields or dialogs', t => {
  const app = createApp(t, fixture());
  app.document.querySelector('.list').focus(); app.key('F2');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input);
  input.value = 'discarded.txt'; app.key('Escape', {}, input);
  assert.equal(app.document.querySelector('.inline-rename'), null);
  assert.equal(app.state().folders['C:/tmp'][0].name, 'original.txt');
  app.document.querySelector('.path-input').focus(); app.key('F2');
  assert.equal(app.document.querySelector('.inline-rename'), null);
  app.action('mkdir'); app.key('F2');
  assert.equal(app.document.querySelector('.inline-rename'), null);
  assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false);
});
test('invalid, occupied and reserved inline names keep the typed value and keyboard focus', t => {
  for (const name of ['bad?name', 'occupied.txt', 'CON', 'con.txt', 'LPT1.log', 'bad\u0001name']) {
    const app = createApp(t, fixture()); app.action('rename-one');
    const input = app.document.querySelector('.inline-rename'); input.value = name; app.key('Enter', {}, input);
    assert.equal(app.document.querySelector('.inline-rename'), input, name);
    assert.equal(input.value, name); assert.equal(app.document.activeElement, input);
    assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false);
    assert.equal(app.state().folders['C:/tmp'][0].name, 'original.txt');
  }
});
test('a real host rename rejection restores the original row and editable proposal with focus', t => {
  for (const reload of [true, false]) {
    const original = fixture(), app = createApp(t, structuredClone(original), { language: 'en' }); app.action('rename-one');
    const input = app.document.querySelector('.inline-rename'); input.value = 'Mein Vorschlag.txt'; app.key('Enter', {}, input);
    assert.ok(app.messages.some(item => item.type === 'filesystem-apply'));
    const state = structuredClone(original); state.folders['C:/tmp'][0].id = 'reloaded-a';
    message(app, { type: 'filesystem-result', ok: false, error: 'Access denied', ...(reload ? { state } : {}) });
    const recovered = app.document.querySelector('.inline-rename'); assert.ok(recovered);
    assert.equal(recovered.value, 'Mein Vorschlag.txt'); assert.equal(app.document.activeElement, recovered);
    assert.equal(app.state().folders['C:/tmp'][0].name, 'original.txt');
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.match(app.document.querySelector('.operation-error-text').value, /Access denied/);
  }
});
test('reading and dismissing inline failure details keeps the editable rename proposal', t => {
  const original = fixture(), app = createApp(t, structuredClone(original)); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); input.value = 'proposal.txt'; app.key('Enter', {}, input);
  message(app, { type: 'filesystem-result', ok: false, error: 'Access denied', state: original });
  const recovered = app.document.querySelector('.inline-rename'), details = app.document.querySelector('[data-select-error]');
  details.focus(); app.click(details);
  assert.equal(app.document.querySelector('.inline-rename'), recovered); assert.equal(recovered.value, 'proposal.txt');
  app.click(app.document.querySelector('[data-dismiss-error]'));
  assert.equal(app.document.activeElement, recovered);
  assert.equal(app.messages.filter(item => item.type === 'filesystem-apply').length, 1);
});
test('dropping an internal selected group on F8 uses the confirmed configured deletion mode', t => {
  for (const [deleteToTrash, shiftKey, expected] of [[true, false, true], [true, true, false], [false, true, true]]) {
    const state = fixture(); state.panes[0].selected = ['a', 'b']; const app = createApp(t, state);
    message(app, { type: 'file-settings', settings: { deleteToTrash } });
    const button = app.document.querySelector('#functionbar [data-action="delete"]');
    drag(app, 'dragstart', app.row('original.txt'));
    assert.equal(drag(app, 'dragover', button).defaultPrevented, true);
    drag(app, 'drop', button, {}, { shiftKey });
    assert.equal(app.document.querySelector('#modal').open, true);
    assert.equal(app.messages.some(item => item.type === 'filesystem-delete'), false);
    submit(app); const request = app.messages.find(item => item.type === 'filesystem-delete'); assert.ok(request);
    assert.deepEqual(request.paths, ['C:/tmp/original.txt', 'C:/tmp/occupied.txt']); assert.equal(request.useTrash, expected);
  }
});
test('F8 drop cancellation and external or unsuitable drags never mutate files', t => {
  const app = createApp(t, fixture()), button = app.document.querySelector('#functionbar [data-action="delete"]');
  drag(app, 'drop', button, { types: ['text/plain'] }); assert.equal(app.document.querySelector('#modal').open, false);
  drag(app, 'dragstart', app.document.querySelector('[data-column="name"]')); drag(app, 'drop', button);
  assert.equal(app.document.querySelector('#modal').open, false);
  drag(app, 'dragstart', app.row('original.txt')); drag(app, 'drop', button);
  assert.equal(app.document.querySelector('#modal').open, true); app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.messages.some(item => item.type === 'filesystem-delete'), false);
  assert.equal(app.state().folders['C:/tmp'].length, 2);
});
test('F8 drop rejects a changed source instead of deleting the newly focused cursor', t => {
  const app = createApp(t, fixture()), button = app.document.querySelector('#functionbar [data-action="delete"]');
  drag(app, 'dragstart', app.row('original.txt'));
  const changed = fixture(); changed.panes[0].tabs = ['C:/temp']; changed.panes[0].cursor = 'other'; changed.panes[0].selected = ['other'];
  changed.folders['C:/temp'] = [{ id: 'other', name: 'untouched.txt', type: 'text', content: 'do not delete' }];
  message(app, { type: 'filesystem-result', ok: true, state: changed });
  drag(app, 'drop', button);
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.some(item => item.type === 'filesystem-delete'), false);
});
test('F8 drop rejects text-only payloads and source changes before confirmation', t => {
  const app = createApp(t, fixture()), button = app.document.querySelector('#functionbar [data-action="delete"]');
  drag(app, 'dragstart', app.row('original.txt')); drag(app, 'drop', button, { types: ['text/plain'] });
  assert.equal(app.document.querySelector('#modal').open, false);
  drag(app, 'dragstart', app.row('original.txt')); drag(app, 'drop', button);
  assert.equal(app.document.querySelector('#modal').open, true);
  const changed = fixture(); changed.folders['C:/tmp'][0].name = 'different.txt';
  message(app, { type: 'filesystem-result', ok: true, state: changed }); submit(app);
  assert.equal(app.messages.some(item => item.type === 'filesystem-delete'), false);
  assert.equal(app.state().folders['C:/tmp'][0].name, 'different.txt');
});
