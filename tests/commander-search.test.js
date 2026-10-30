const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../media/commander-search');

const files = [{ id: '1', name: 'architecture.md' }, { id: '2', name: 'keyboard-shortcuts.md' }, { id: '3', name: 'Notizen.txt' }];
test('finds case-insensitive substrings in the middle and at the end', () => {
  assert.equal(search.find(files, 'TECT', null).id, '1');
  assert.deepEqual(search.matches(files, '.MD').map(item => item.id), ['1', '2']);
  assert.deepEqual(search.range('architecture.md', 'tect'), { start: 5, end: 9 });
});
test('cycles matches without filtering the source list', () => {
  assert.equal(search.find(files, '.md', '2', 1).id, '1');
  assert.equal(search.find(files, '.md', '1', -1).id, '2');
  assert.equal(files.length, 3);
  assert.equal(search.find(files, 'missing', null), null);
});
