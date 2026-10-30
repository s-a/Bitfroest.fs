const test = require('node:test');
const assert = require('node:assert/strict');
const { selectDuplicates } = require('../media/search-duplicates');
const rows = [
  { id: 'a', name: 'one.txt', fsSource: '/source/one.txt', size: 10, mtimeMs: 100, group: 0 },
  { id: 'b', name: 'copy.txt', fsSource: '/backup/sub/copy.txt', size: 10, mtimeMs: 200, group: 0 },
  { id: 'c', name: 'two.md', fsSource: '/source/two.md', size: 20, mtimeMs: 300, group: 1 },
  { id: 'd', name: 'copy.md', fsSource: '/backup/copy.md', size: 15, mtimeMs: 300, group: 1 }
];
test('duplicate selection combines names, removals and group-relative date or size rules', () => {
  assert.deepEqual(selectDuplicates(rows, { include: '*.txt', exclude: 'one*' }), ['b']);
  assert.deepEqual(selectDuplicates(rows, { date: 'older' }), ['a']);
  assert.deepEqual(selectDuplicates(rows, { size: 'smallest' }), ['a', 'b', 'd']);
  assert.deepEqual(selectDuplicates(rows, { include: '<^copy' }), ['b', 'd']);
});
test('duplicate folder selection and keep-one priorities never select the last preserved member', () => {
  assert.deepEqual(selectDuplicates(rows, { folders: ['/backup'], includeChildren: true }), ['b', 'd']);
  assert.deepEqual(selectDuplicates(rows, { folderPattern: 'backup', directParent: true }), ['d']);
  assert.deepEqual(selectDuplicates(rows, { keepOne: true, keep: ['newest', 'largest', 'first'] }), ['a', 'd']);
  assert.deepEqual(selectDuplicates(rows, { keepOne: true, keep: ['last'] }), ['a', 'c']);
});
