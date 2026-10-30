const test = require('node:test');
const assert = require('node:assert/strict');
const names = require('../media/commander-file-names');
const transfer = require('../media/commander-transfer');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('file batches reject planned file ancestors in either order and under Windows casing rules', () => {
  for (const input of ['new|new/child.txt', 'new/child.txt|new', 'NEW|new/child.txt', 'new/child.txt|NEW']) {
    const folders = { 'C:/tmp': [], 'C:/temp': [] };
    assert.throws(() => names.plan(input, { base: 'C:/tmp', folders, kind: 'file' }), Error, input);
    assert.deepEqual(folders, { 'C:/tmp': [], 'C:/temp': [] });
  }
});

test('F6 case-only rename preserves source identity and contents without a conflict decision', async () => {
  const folders = { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', content: 'original', fsSource: 'C:/tmp/a.txt' }], 'C:/temp': [] };
  let prompts = 0;
  const result = await transfer.execute({ folders, sourcePath: 'C:/tmp', targetPath: 'C:/tmp/A.txt', ids: ['a'], mode: 'move', onConflict: () => { prompts++; return { action: 'cancel' }; } });
  assert.equal(prompts, 0);
  assert.deepEqual(result.completedIds, ['a']);
  assert.deepEqual(folders['C:/tmp'], [{ id: 'a', name: 'A.txt', type: 'text', content: 'original', fsSource: 'C:/tmp/a.txt' }]);
});

test('case-only moves never rename onto a separate existing case neighbour', async () => {
  const folders = { '/source': [{ id: 'a', name: 'a.txt', type: 'text', content: 'source' }, { id: 'A', name: 'A.txt', type: 'text', content: 'neighbour' }] };
  const before = structuredClone(folders);
  await transfer.execute({ folders, sourcePath: '/source', targetPath: '/source/A.txt', ids: ['a'], mode: 'move', onConflict: () => ({ action: 'cancel' }) });
  assert.deepEqual(folders, before);
});

test('automatic older policies protect newer target versions even when the source timestamp is newer', async () => {
  for (const [policy, sourceTime, expected] of [['overwrite-older', 2, 0], ['overwrite-older-equal', 1, 0], ['overwrite-older', 1, 0], ['overwrite-older-equal', 0, 0], ['rename-older-target', 2, 0], ['overwrite-all', 2, 1]]) {
    const folders = { '/source': [{ id: 'a', name: 'a.dll', type: 'text', content: 'source', fileVersion: [10, 0, 26100, 1150], mtimeMs: sourceTime }],
      '/target': [{ id: 'b', name: 'a.dll', type: 'text', content: 'target', fileVersion: [10, 0, 26100, 1151], mtimeMs: 1 }] };
    const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target', ids: ['a'], policy });
    assert.equal(result.completed, expected, `${policy}: ${sourceTime}`);
    assert.equal(folders['/target'][0].content, expected ? 'source' : 'target');
  }
});

test('renaming older targets preserves their bytes under the reference default numbered name', async () => {
  const folders = { '/source': [{ id: 'a', name: 'a.dll', type: 'text', content: 'source', fileVersion: [2, 0, 0, 0], mtimeMs: 1 }],
    '/target': [{ id: 'b', name: 'a.dll', type: 'text', content: 'target', fileVersion: [1, 0, 0, 0], mtimeMs: 2 }] };
  const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target', ids: ['a'], policy: 'rename-older-target' });
  assert.equal(result.completed, 1);
  assert.equal(folders['/target'].find(row => row.name === 'a.dll').content, 'source');
  assert.equal(folders['/target'].find(row => row.name === 'a (2).dll').content, 'target');
});

test('automatic names use a space, start at two and increment existing end numbers', () => {
  assert.equal(transfer.uniqueName([{ name: 'a.txt' }, { name: 'a (2).txt' }], 'a.txt'), 'a (3).txt');
  assert.equal(transfer.uniqueName([{ name: 'a (8).txt' }], 'a (8).txt'), 'a (9).txt');
  assert.equal(transfer.uniqueName([{ name: 'README' }], 'README'), 'README (2)');
});

test('explicit directory exclusions skip selected and nested trees while retaining other files', async () => {
  for (const mode of ['copy', 'move']) {
    const folders = {
      '/source': [{ id: 'docs', name: 'docs', type: 'folder' }, { id: 'keep', name: 'keep', type: 'folder' }],
      '/source/docs': [{ id: 'excluded', name: 'inside.txt', type: 'text', content: 'excluded' }],
      '/source/keep': [{ id: 'nested', name: 'docs', type: 'folder' }, { id: 'included', name: 'inside.txt', type: 'text', content: 'included' }],
      '/source/keep/docs': [{ id: 'nested-excluded', name: 'secret.txt', type: 'text', content: 'secret' }], '/target': []
    };
    const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target', ids: ['docs', 'keep'], mode, filter: '*.* | docs\\' });
    assert.equal(folders['/target/docs'], undefined);
    assert.equal(folders['/target/keep/docs'], undefined);
    assert.equal(folders['/target/keep'][0].content, 'included');
    assert.equal(folders['/source/docs'][0].content, 'excluded');
    assert.equal(folders['/source/keep/docs'][0].content, 'secret');
    assert.equal(result.completedIds.includes('docs'), false);
  }
});

function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a', 'b'], cursor: 'a', filter: '', sort: 'name' });
  const file = (id, name, content, root) => ({ id, name, type: 'text', size: content.length, content, fsSource: `${root}/${name}` });
  return { version: 1, realFilesystem: true, snapshotId: 'partial-conflict', active: 0,
    panes: [pane('C:/tmp'), pane('C:/temp')], folders: {
      'C:/tmp': [file('a', 'a-first.txt', 'first', 'C:/tmp'), file('b', 'b-conflict.txt', 'new', 'C:/tmp')],
      'C:/temp': [file('old', 'b-conflict.txt', 'old', 'C:/temp')]
    } };
}
test('earlier real transfers are confirmed before a later conflict is shown and survive its cancellation', async t => {
  for (const mode of ['copy', 'move']) {
    const app = createApp(t, fixture()); app.action(mode);
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
    const apply = app.messages.find(message => message.type === 'filesystem-apply');
    assert.ok(apply, 'the first completed entry must reach the host before the next conflict');
    assert.equal(app.document.querySelector('[data-conflict-action="cancel"]'), null);
    assert.equal(apply.state.folders['C:/temp'].find(row => row.name === 'a-first.txt').content, 'first');
    assert.equal(apply.state.folders['C:/temp'].find(row => row.name === 'b-conflict.txt').content, 'old');
    assert.equal(apply.state.folders['C:/tmp'].some(row => row.id === 'a'), mode === 'copy');
    assert.equal(apply.state.folders['C:/tmp'].find(row => row.id === 'b').content, 'new');
    const confirmed = structuredClone(apply.state); confirmed.snapshotId = 'first-confirmed';
    confirmed.folders['C:/temp'].find(row => row.name === 'a-first.txt').fsSource = 'C:/temp/a-first.txt';
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: apply.operationId, ok: true, state: confirmed } })); await tick();
    app.click(app.document.querySelector('[data-conflict-action="cancel"]')); await tick();
    assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
    assert.equal(app.state().folders['C:/temp'].find(row => row.name === 'a-first.txt').content, 'first');
    assert.equal(app.state().folders['C:/temp'].find(row => row.name === 'b-conflict.txt').content, 'old');
  }
});

test('a failed host write stops before the later conflict and restores the confirmed snapshot', async t => {
  const saved = fixture(), app = createApp(t, structuredClone(saved)); app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: apply.operationId, ok: false, error: 'Write denied', state: saved } })); await tick();
  assert.equal(app.document.querySelector('[data-conflict-action="cancel"]'), null);
  assert.deepEqual(app.state().folders, saved.folders);
  assert.match(app.document.querySelector('.operation-error-text').value, /Write denied/);
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
});

test('restoring the workspace while a prior entry is pending prevents stale conflict continuation', async t => {
  const app = createApp(t, fixture()); app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  const restored = fixture(); restored.snapshotId = 'restored'; restored.folders['C:/tmp'] = [];
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: restored } })); await tick();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: apply.operationId, ok: true, state: apply.state } })); await tick();
  assert.equal(app.state().snapshotId, 'restored');
  assert.deepEqual(app.state().folders['C:/tmp'], []);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('host failure removes a viewed target tab that disappeared during the write', async t => {
  const saved = fixture();
  saved.folders['C:/temp/view'] = saved.folders['C:/temp'].map(row => ({ ...row, fsSource: 'C:/temp/view/b-conflict.txt' }));
  saved.panes[1].tabs.push('C:/temp/view'); saved.panes[1].tab = 1;
  const app = createApp(t, saved); app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  const native = fixture();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: apply.operationId, ok: false, error: 'Target removed', state: native } })); await tick();
  assert.deepEqual(app.state().panes[1].tabs, ['C:/temp']);
  assert.equal(app.state().panes[1].tab, 0);
});
