const test = require('node:test');
const assert = require('node:assert/strict');
const clipboard = require('../media/bitfroest-clipboard');
function fixture() {
  return { active: 0, panes: [{ tabs: ['C:/tmp'], tab: 0, cursor: 'a', selected: [] }, { tabs: ['C:/temp'], tab: 0, selected: [] }], unloadedFolders: ['C:/tmp/nested'], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt' }, { id: 'b', name: 'b.txt' }], 'C:/temp': [], 'C:/tmp/nested': [] } };
}
test('copy and cut capture the current selection with cursor fallback without deleting any row', () => {
  const state = fixture(), before = JSON.stringify(state);
  assert.deepEqual(clipboard.capture(state, 'move'), { paths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(JSON.stringify(state), before);
  state.panes[0].selected = ['b', 'a'];
  assert.deepEqual(clipboard.capture(state, 'copy').paths, ['C:/tmp/a.txt', 'C:/tmp/b.txt']);
});
test('paste preserves selections from different source directories and does not navigate panes', () => {
  const state = fixture(); state.unloadedFolders = []; state.folders['C:/tmp/nested'] = [{ id: 'c', name: 'c.txt' }];
  const before = JSON.stringify(state.panes);
  const plan = clipboard.inspectPaste(state, { paths: ['C:/tmp/nested/c.txt', 'C:/tmp/a.txt'], mode: 'move', token: 'one' }, 'C:/temp');
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.groups, [{ sourcePath: 'C:/tmp/nested', ids: ['c'], paths: ['C:/tmp/nested/c.txt'], targetPath: 'C:/temp', mode: 'move' }, { sourcePath: 'C:/tmp', ids: ['a'], paths: ['C:/tmp/a.txt'], targetPath: 'C:/temp', mode: 'move' }]);
  assert.equal(JSON.stringify(state.panes), before);
});
test('unloaded source parents are explicitly requested before planning native clipboard imports', () => {
  const plan = clipboard.inspectPaste(fixture(), { paths: ['C:/tmp/nested/c.txt'], mode: 'copy' }, 'C:/temp');
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.directories, ['C:/tmp/nested']);
  assert.deepEqual(plan.groups, []);
});
test('missing and unsafe clipboard entries fail before transferring any source', () => {
  for (const paths of [['C:/tmp/missing'], ['C:/tmp/../outside/a'], ['relative'], ['C:/tmp/a.txt\0x']]) {
    assert.throws(() => clipboard.inspectPaste(fixture(), { paths, mode: 'copy' }, 'C:/temp'));
  }
  assert.throws(() => clipboard.inspectPaste(fixture(), { paths: ['C:/tmp/a.txt'], mode: 'link' }, 'C:/temp'));
});
test('only confirmed completed IDs leave a cut selection; partial skip/cancel remains available', () => {
  const selection = { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt'], mode: 'move' };
  const group = { sourcePath: 'C:/tmp', ids: ['a', 'b'], paths: selection.paths };
  assert.deepEqual(clipboard.remaining(selection, [{ group, result: { confirmed: false, completedIds: ['a', 'b'] } }]), selection.paths);
  assert.deepEqual(clipboard.remaining(selection, [{ group, result: { confirmed: true, completedIds: ['a'], cancelled: true } }]), ['C:/tmp/b.txt']);
  assert.deepEqual(clipboard.remaining({ ...selection, mode: 'copy' }, [{ group, result: { confirmed: true, completedIds: ['a', 'b'] } }]), selection.paths);
});

test('copy without an existing cursor or selection does not replace clipboard data', () => {
  const state=fixture();state.panes[0].cursor=null;state.folders['C:/tmp']=[];
  assert.equal(clipboard.capture(state,'copy'),null);
});

test('POSIX clipboard paths preserve literal backslashes and use case-sensitive identity', () => {
  const state = { active: 0, panes: [{ tabs: ['/tmp'], tab: 0, cursor: 'one', selected: [] }, { tabs: ['/target'], tab: 0, selected: [] }],
    folders: { '/tmp': [{ id: 'one', name: 'literal\\name.txt' }, { id: 'two', name: 'Case.txt' }, { id: 'three', name: 'a\\..\\b.txt' }, { id: 'upper', name: 'A.txt' }, { id: 'lower', name: 'a.txt' }], '/target': [] } };
  const selection = clipboard.capture(state, 'move', 'linux');
  assert.deepEqual(selection, { paths: ['/tmp/literal\\name.txt'], mode: 'move' });
  state.panes[0].selected = ['three'];
  assert.deepEqual(clipboard.capture(state, 'copy', 'linux').paths, ['/tmp/a\\..\\b.txt']);
  state.panes[0].selected = ['upper', 'lower'];
  assert.deepEqual(clipboard.capture(state, 'copy', 'linux').paths, ['/tmp/A.txt', '/tmp/a.txt']);
  const plan = clipboard.inspectPaste(state, { paths: ['/tmp/literal\\name.txt'], mode: 'move' }, '/target', 'linux');
  assert.deepEqual(plan.groups[0].paths, ['/tmp/literal\\name.txt']);
  assert.throws(() => clipboard.inspectPaste(state, { paths: ['/tmp/case.txt'], mode: 'copy' }, '/target', 'linux'));
  const selectionWithCase = { paths: ['/tmp/Case.txt'], mode: 'move' };
  const differentlyCasedGroup = { ids: ['two'], paths: ['/tmp/case.txt'] };
  assert.deepEqual(clipboard.remaining(selectionWithCase, [{ group: differentlyCasedGroup, result: { confirmed: true, completedIds: ['two'] } }], 'linux'), ['/tmp/Case.txt']);
});

test('Windows clipboard paths keep case-insensitive drive identity and separator normalization', () => {
  const selection = { paths: ['C:\\Temp\\File.txt'], mode: 'move' };
  const group = { ids: ['file'], paths: ['c:/temp/file.txt'] };
  assert.deepEqual(clipboard.remaining(selection, [{ group, result: { confirmed: true, completedIds: ['file'] } }]), []);
});
