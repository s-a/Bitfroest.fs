const test = require('node:test');
const assert = require('node:assert/strict');
const transfer = require('../media/commander-transfer');
const { createApp } = require('./support/webview.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const file = (id, name, extra = {}) => ({ id, name, type: 'text', size: 3, content: id, ...extra });
function fixture(real = true) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: real, snapshotId: 'reference-contract',
    panes: [pane('C:/tmp'), pane('C:/temp')],
    folders: { 'C:/tmp': [file('a', 'a.txt'), file('b', 'b.txt')], 'C:/temp': [] } };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
const select = (app, name, modifiers = {}) => app.click(app.row(name).querySelector('[data-filename]'), modifiers);
const respond = (app, request, selection) => app.window.dispatchEvent(new app.window.MessageEvent('message', {
  data: { type: 'clipboard-result', requestId: request.requestId, ok: true, selection }
}));

for (const policy of ['overwrite-older', 'overwrite-older-equal', 'larger', 'smaller']) {
  test(`PRIM-008 ${policy} applies one decision to mixed conflicts and retains skipped move sources`, async () => {
    const folders = { '/source': [], '/target': [] };
    const accepted = policy === 'overwrite-older-equal' ? ['a', 'b'] : ['a'];
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      const size = policy === 'smaller' ? [1, 3, 5][index] : [5, 3, 1][index];
      folders['/source'].push(file(id, `${id}.txt`, { size, mtimeMs: [3000, 2000, 1000][index] }));
      folders['/target'].push(file(`old-${id}`, `${id}.txt`, { mtimeMs: 2000 }));
    }
    let prompts = 0;
    const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target',
      ids: ['a', 'b', 'c'], mode: 'move', onConflict: () => { prompts++; return { action: policy }; } });
    assert.equal(prompts, 1);
    assert.equal(result.completed, accepted.length);
    assert.deepEqual(folders['/source'].map(row => row.id), ['a', 'b', 'c'].filter(id => !accepted.includes(id)));
    for (const id of ['a', 'b', 'c']) {
      assert.equal(folders['/target'].find(row => row.name === `${id}.txt`).content, accepted.includes(id) ? id : `old-${id}`);
    }
  });
}

test('PRIM-008 automatic version protection retains lower-version sources in a mixed move batch', async () => {
  const folders = {
    '/source': [file('a', 'a.exe', { fileVersion: [2, 0, 0, 0], mtimeMs: 1000 }), file('b', 'b.exe', { fileVersion: [1, 0, 0, 0], mtimeMs: 9000 })],
    '/target': [file('old-a', 'a.exe', { fileVersion: [1, 0, 0, 0], mtimeMs: 9000 }), file('old-b', 'b.exe', { fileVersion: [2, 0, 0, 0], mtimeMs: 1000 })]
  };
  const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target', ids: ['a', 'b'], mode: 'move', policy: 'overwrite-older' });
  assert.equal(result.completed, 1);
  assert.deepEqual(folders['/source'].map(row => row.content), ['b']);
  assert.equal(folders['/target'].find(row => row.name === 'a.exe').content, 'a');
  assert.equal(folders['/target'].find(row => row.name === 'b.exe').content, 'old-b');
});

test('PRIM-015 preview cancellation and a collision at the second destination leave the entire batch unchanged', t => {
  const saved = fixture(); saved.panes[0].selected = ['a', 'b']; saved.panes[0].cursor = 'a';
  saved.folders['C:/tmp'].push(file('other', 'renamed_2.txt'));
  const app = createApp(t, saved), before = structuredClone(app.state().folders);
  for (const cancel of [true, false]) {
    app.action('rename');
    const mask = app.document.querySelector('#mask'); mask.value = 'renamed_[C]';
    mask.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    assert.match(app.document.querySelector('#rename-preview').textContent, /renamed_1.txt/);
    assert.match(app.document.querySelector('#rename-preview').textContent, /renamed_2.txt/);
    assert.deepEqual(app.state().folders, before);
    if (cancel) app.click(app.document.querySelector('#modal-cancel'));
    else { submit(app); assert.equal(app.document.querySelector('#modal').open, true); }
    assert.deepEqual(app.state().folders, before);
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  }
});

test('PRIM-020 both delete keys obey all preference/Shift combinations and cancellation preserves the selected group', t => {
  for (const key of ['F8', 'Delete']) for (const deleteToTrash of [true, false]) for (const shiftKey of [true, false]) {
    const saved = fixture(); saved.panes[0].selected = ['a', 'b']; saved.panes[0].cursor = 'a';
    const app = createApp(t, saved), before = structuredClone(app.state().folders);
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { deleteToTrash } } }));
    app.key(key, { shiftKey }); app.click(app.document.querySelector('#modal-cancel'));
    assert.deepEqual(app.state().folders, before);
    assert.equal(app.messages.some(message => message.type === 'filesystem-delete'), false);
    app.key(key, { shiftKey }); submit(app);
    const requests = app.messages.filter(message => message.type === 'filesystem-delete');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].useTrash, deleteToTrash !== shiftKey);
    assert.deepEqual(requests[0].paths, ['C:/tmp/a.txt', 'C:/tmp/b.txt']);
    assert.deepEqual(app.state().folders, before);
  }
});

test('PRIM-023 cancelling a system cut paste retains both sources and sends neither mutation nor acknowledgement', async t => {
  const app = createApp(t, fixture()), before = structuredClone(app.state().folders);
  select(app, 'a.txt'); select(app, 'b.txt', { ctrlKey: true }); app.key('x', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt'], mode: 'move', token: 'cancel-cut', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), selection);
  app.key('Tab'); app.key('v', { ctrlKey: true });
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), selection);
  assert.equal(app.document.querySelector('#modal').open, true);
  app.click(app.document.querySelector('#modal-cancel')); await tick();
  assert.deepEqual(app.state().folders, before);
  assert.equal(app.messages.some(message => ['filesystem-apply', 'clipboard-ack'].includes(message.type)), false);
});

test('PRIM-023 repeated copy paste resolves its new collision without consuming the source', async t => {
  const app = createApp(t, fixture(false)); select(app, 'a.txt'); app.key('c', { ctrlKey: true }); app.key('Tab');
  app.key('v', { ctrlKey: true }); submit(app); await tick();
  app.key('v', { ctrlKey: true }); submit(app); await tick();
  const skip = app.document.querySelector('[data-conflict-action="skip"]'); assert.ok(skip); app.click(skip); await tick();
  assert.deepEqual(app.state().folders['C:/tmp'].map(row => row.content), ['a', 'b']);
  assert.deepEqual(app.state().folders['C:/temp'].map(row => row.content), ['a']);
  assert.equal(app.messages.some(message => message.type === 'clipboard-ack'), false);
});
