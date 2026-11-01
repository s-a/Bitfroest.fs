const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../media/configuration-model');

test('column settings omit custom titles from validated saved data and public schemas', () => {
  const columns = require('../media/commander-column-settings').catalog;
  const normalized = model.validateColumns(columns);
  assert.ok(normalized.every(column => !Object.hasOwn(column, 'title')));
  const properties = Object.assign({}, ...require('../package.json').contributes.configuration.map(category => category.properties));
  assert.ok(Object.keys(properties).every(key => key !== 'bitfroest.columns.titles' && !key.startsWith('bitfroest.columns.title.')));
  assert.equal(properties['bitfroest.columns.layout'].items.properties.title, undefined);
});

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
  assert.equal(model.validateColumns(layout)[0].id, catalog.at(-1).id);
  assert.throws(() => model.validateColumns(layout.slice(0, -1)), /Spalten/);
  layout[0].width = -1;
  assert.equal(Object.hasOwn(model.validateColumns(layout)[0], 'width'), false);
});

test('saved layouts from the previous catalog retain order and receive an invisible Version column', () => {
  const catalog = require('../media/commander-column-settings').catalog;
  const old = catalog.slice(0, 13).reverse().map(item => ({ id: item.id, align: 'center', visible: true }));
  const result = model.validateColumns(old);
  assert.equal(result.length, catalog.length);
  assert.deepEqual(result.slice(0, 13), old);
  assert.deepEqual(result[13], { id: 'version', align: 'left', visible: false });
  assert.equal(old.length, 13);
});

test('fourteen-field layouts preserve Windows preferences and append the new fields without enabling them', () => {
  const catalog = require('../media/commander-column-settings').catalog;
  const old = catalog.slice(0, 14).reverse().map(item => ({ id: item.id, visible: true, align: 'right' }));
  const result = model.validateColumns(old);
  assert.deepEqual(result.slice(0, 14), old);
  assert.equal(result.length, catalog.length);
  assert.ok(result.slice(14).every(item => item.visible === false));
  assert.throws(() => model.validateColumns([...old.slice(1), old[1]]), /Spalten/);
});
