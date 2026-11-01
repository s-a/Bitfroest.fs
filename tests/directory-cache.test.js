const test = require('node:test');
const assert = require('node:assert/strict');
test('directory cache bounds UTF-8 data and evicts least recently read directories including oversized replacements', () => {
  const { create } = require('../media/commander-directory-cache');
  const rows = [{ id: 'ä', name: '文件.txt', type: 'text' }];
  const weight = Buffer.byteLength(JSON.stringify(['/a', rows]));
  const cache = create(weight * 2);
  cache.set('/a', rows); cache.set('/b', rows); cache.get('/a'); cache.set('/c', rows);
  assert.equal(cache.get('/b'), undefined); assert.deepEqual(cache.get('/a'), rows);
  assert.equal(cache.bytes, weight * 2);
  cache.set('/a', [{ name: 'x'.repeat(weight * 3) }]);
  assert.equal(cache.get('/a'), undefined); assert.ok(cache.bytes <= weight * 2);
  cache.clear(); assert.equal(cache.bytes, 0);
});

test('Git decorations share the directory budget and survive row updates until eviction or invalidation', () => {
  const { create } = require('../media/commander-directory-cache');
  const rows = [{ id: 'a', name: 'a.txt', type: 'text' }], info = { ok: true, repository: true, branch: 'main', statuses: { 'a.txt': 'modified' } };
  const cache = create(400);
  cache.set('/a', rows); const before = cache.bytes;
  cache.setGit('/a', info);
  assert.ok(cache.bytes > before); assert.deepEqual(cache.getGit('/a'), info);
  cache.set('/a', [...rows, { id: 'b', name: 'b.txt' }]); assert.deepEqual(cache.getGit('/a'), info);
  cache.clearGit(); assert.equal(cache.getGit('/a'), undefined); assert.equal(cache.get('/a').length, 2);
  cache.setGit('/a', { ...info, statuses: { ['x'.repeat(500)]: 'modified' } });
  assert.equal(cache.get('/a'), undefined); assert.ok(cache.bytes <= 400);
});

test('column widths share the cache budget and survive row and Git updates', () => {
  const { create } = require('../media/commander-directory-cache');
  const cache = create(400), rows = [{ name: 'a.txt' }];
  const columns = { signature: 'standard', widths: { name: 180, size: 90 } };
  cache.set('/a', rows); const before = cache.bytes;
  cache.setColumns('/a', columns);
  columns.widths.name = 999;
  assert.equal(cache.getColumns('/a').widths.name, 180);
  assert.ok(cache.bytes > before);
  cache.set('/a', [{ name: 'b.txt' }]);
  cache.setGit('/a', { statuses: {} }); cache.clearGit();
  assert.equal(cache.getColumns('/a').widths.size, 90);
  cache.setColumns('/a', { signature: 'x'.repeat(500) });
  assert.equal(cache.getColumns('/a'), undefined);
  assert.equal(cache.get('/a'), undefined);
  assert.ok(cache.bytes <= 400);
});
