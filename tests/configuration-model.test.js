const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../media/configuration-model');

test('favorite tables roundtrip groups, duplicate labels, order and opposite targets', () => {
  const input = { entries: { Work: 'C:/work', 'Other work': 'D:/work' }, labels: { 'Other work': 'Work' }, groups: { 'Other work': 'Projects/Archive' }, targets: { Work: 'C:/downloads' }, order: ['Work', 'Other work'] };
  const tree = model.favoritesFromTables(input);
  const tables = model.favoritesToTables(tree);
  assert.equal(tree.filter(item => item.type === 'group').length, 2);
  assert.deepEqual(Object.values(tables.entries), ['C:/work', 'D:/work']);
  assert.deepEqual(Object.values(tables.labels), ['Work', 'Work']);
  assert.equal(Object.values(tables.groups)[0], 'Projects/Archive');
  assert.equal(Object.values(tables.targets)[0], 'C:/downloads');
});

test('moving groups prevents cycles and moving favorites preserves their properties', () => {
  const nodes = [{ id: 'a', type: 'group', name: 'A', parent: null }, { id: 'b', type: 'group', name: 'B', parent: 'a' }, { id: 'f', type: 'favorite', name: 'File', parent: 'a', path: 'C:/work', target: '' }];
  assert.throws(() => model.moveFavorite(nodes, 'a', 'b'), /Untergruppe/);
  const moved = model.moveFavorite(nodes, 'f', 'b');
  assert.equal(moved.find(item => item.id === 'f').path, 'C:/work');
  assert.equal(moved.find(item => item.id === 'f').parent, 'b');
  assert.equal(nodes[2].parent, 'a');
});

test('validation rejects malformed hierarchy and commands while accepting unavailable absolute directory paths', () => {
  assert.throws(() => model.validateFavorites([{ id: 'f', type: 'favorite', name: 'F', path: 'cd C:/work', parent: null }]), /absoluter/);
  assert.throws(() => model.validateFavorites([{ id: 'g', type: 'group', name: 'G', parent: 'missing' }]), /Gruppe/);
  assert.equal(model.validateFavorites([{ id: 'f', type: 'favorite', name: 'F', path: 'Z:/offline', parent: null }])[0].path, 'Z:/offline');
});

test('column editor validates the complete fixed catalog and preserves display order', () => {
  const catalog = require('../media/commander-column-settings').catalog;
  const layout = catalog.map(item => ({ ...item }));
  layout.reverse();
  assert.equal(model.validateColumns(layout)[0].id, 'accessTime');
  assert.throws(() => model.validateColumns(layout.slice(1)), /Spalten/);
  layout[0].width = -1;
  assert.throws(() => model.validateColumns(layout), /Breite/);
});
