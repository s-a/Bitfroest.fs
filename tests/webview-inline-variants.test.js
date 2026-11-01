const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture(realFilesystem = false) {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem, snapshotId: 'before', active: 0, panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.one.txt', type: 'text', content: 'one', fsSource: 'C:/tmp/a.one.txt' }, { id: 'b', name: 'b.two.txt', type: 'text', content: 'two', fsSource: 'C:/tmp/b.two.txt' }], 'C:/temp': [] } };
}
const reply = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ...data } }));
test('ordinary focus loss cancels an inline rename without a model or host mutation', t => {
  for (const real of [false, true]) {
    const app = createApp(t, fixture(real)); app.action('rename-one');
    const before = structuredClone(app.state().folders);
    app.document.querySelector('.inline-rename').value = 'discarded-proposal.txt';
    const destination = app.document.querySelector('.path-input'); destination.focus();
    assert.deepEqual(app.state().folders, before);
    assert.equal(app.document.querySelector('.inline-rename'), null);
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
    assert.equal(app.document.activeElement, destination);
  }
});
test('default inline rename selects name and extension; repeated Shift F6 selects only the edited stem', t => {
  const app = createApp(t, fixture()); app.key('F6', { shiftKey: true }); const input = app.document.querySelector('.inline-rename');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 'a.one.txt'.length]);
  input.value = 'proposal.new.txt'; app.key('F6', { shiftKey: true }, input);
  assert.equal(app.document.querySelector('.inline-rename'), input); assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'proposal.new');
  assert.equal(app.state().folders['C:/tmp'][0].name, 'a.one.txt'); assert.equal(app.document.activeElement, input);
  input.select(); app.action('rename-one'); assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'proposal.new');
  assert.equal(app.messages.filter(item => item.type === 'inputFocus').at(-1).inlineRename, true);
});
test('arrow rename commits one marked file before editing its captured adjacent file', t => {
  const app = createApp(t, fixture()); app.action('rename-one'); const input = app.document.querySelector('.inline-rename');
  input.value = 'z-renamed.txt'; app.key('ArrowDown', {}, input);
  assert.ok(app.state().folders['C:/tmp'].some(file => file.name === 'z-renamed.txt'));
  assert.equal(app.document.querySelector('.inline-rename').value, 'b.two.txt'); assert.equal(app.document.activeElement, app.document.querySelector('.inline-rename'));
});
test('real arrow rename waits for host success and preserves the original proposal on failure', t => {
  for (const ok of [true, false]) {
    const original = fixture(true), app = createApp(t, structuredClone(original)); app.action('rename-one');
    const input = app.document.querySelector('.inline-rename'); input.value = 'z-renamed.txt'; app.key('ArrowDown', {}, input);
    const request = app.messages.find(item => item.type === 'filesystem-apply'); assert.ok(request);
    assert.equal(app.document.querySelector('.inline-rename'), null);
    const state = ok ? structuredClone(request.state) : original;
    state.folders['C:/tmp'].find(file => file.name === 'b.two.txt').id = 'fresh-next';
    reply(app, { ok, state, error: ok ? undefined : 'Blocked' });
    const recovered = app.document.querySelector('.inline-rename'); assert.ok(recovered);
    assert.equal(recovered.value, ok ? 'b.two.txt' : 'z-renamed.txt'); assert.equal(app.document.activeElement, recovered);
    if (!ok) assert.ok(app.state().folders['C:/tmp'].some(file => file.name === 'a.one.txt'));
  }
});
test('arrow rename ignores modifiers, multiple marks and absent adjacent entries', t => {
  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    const app = createApp(t, fixture()); app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); input.value = 'new.txt'; app.key('ArrowDown', modifiers, input);
    assert.equal(app.document.querySelector('.inline-rename'), input); assert.equal(app.state().folders['C:/tmp'][0].name, 'a.one.txt');
  }
  const state = fixture(); state.panes[0].selected = ['a', 'b']; const app = createApp(t, state); app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); app.key('ArrowDown', {}, input);
  assert.equal(app.document.querySelector('.inline-rename'), input);
  const edge = createApp(t, fixture()); edge.action('rename-one'); const first = edge.document.querySelector('.inline-rename'); first.value = 'unconfirmed.txt'; edge.key('ArrowUp', {}, first);
  assert.equal(edge.document.querySelector('.inline-rename'), first); assert.equal(edge.state().folders['C:/tmp'][0].name, 'a.one.txt');
});
test('main menu trash entry requests only the OS trash view and keeps the selection unchanged', t => {
  const app = createApp(t, fixture(true)), before = JSON.stringify(app.state().folders);
  app.click(app.document.querySelector('[data-menu-group="Dateien"]'));
  app.click(app.document.querySelector('[data-menu-action="open-trash"]'));
  assert.equal(app.messages.filter(item => item.type === 'open-trash').length, 1);
  assert.equal(JSON.stringify(app.state().folders), before); assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.some(item => ['filesystem-delete', 'filesystem-apply'].includes(item.type)), false);
});
test('a trash launch failure retains an active inline proposal and shows readable persistent details', t => {
  const app = createApp(t, fixture(true)); app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); input.value = 'unsaved proposal.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'open-trash-result', ok: false, error: 'Trash unavailable' } }));
  assert.equal(app.document.querySelector('.inline-rename'), input); assert.equal(input.value, 'unsaved proposal.txt'); assert.equal(app.document.activeElement, input);
  assert.ok(app.document.querySelector('.operation-error-text').value.endsWith('Trash unavailable'));
  assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false);
});
test('unchanged arrow switching performs no host mutation and invalid names cannot advance', t => {
  const app = createApp(t, fixture(true)); app.action('rename-one'); app.key('ArrowDown', {}, app.document.querySelector('.inline-rename'));
  assert.equal(app.document.querySelector('.inline-rename').value, 'b.two.txt'); assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false);
  const input = app.document.querySelector('.inline-rename'); input.value = 'CON'; app.key('ArrowUp', {}, input);
  assert.equal(app.document.querySelector('.inline-rename'), input); assert.equal(input.value, 'CON'); assert.equal(app.messages.some(item => item.type === 'filesystem-apply'), false);
});
test('F8 right click is ignored while another dialog is open and does not act on neighboring buttons', t => {
  const app = createApp(t, fixture(true));
  const context = button => button.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  context(app.document.querySelector('#functionbar [data-action="copy"]'));
  app.action('mkdir'); context(app.document.querySelector('#functionbar [data-action="delete"]'));
  assert.equal(app.messages.some(item => item.type === 'open-trash'), false); assert.equal(app.document.querySelector('#modal').open, true);
});
