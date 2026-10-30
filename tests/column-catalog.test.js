const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../media/commander-column-settings');
const properties = Object.assign({}, ...require('../package.json').contributes.configuration.map(item => item.properties));

test('every available column has fixed native controls with visibility first and bounded choices', () => {
  assert.equal(settings.catalog.length, 13);
  for (const column of settings.catalog) {
    const visibility = properties[`bitfroest.columns.visible.${column.id}`];
    assert.equal(visibility.type, 'boolean');
    for (const kind of ['width', 'alignment', 'position']) {
      const schema = properties[`bitfroest.columns.${kind}.${column.id}`];
      assert.ok(schema.enum.length > 1);
      assert.ok(schema.order > visibility.order);
    }
    assert.equal(properties[`bitfroest.columns.title.${column.id}`].type, 'string');
  }
});

test('fixed column preferences produce visible columns, localized default titles and stable positions', () => {
  const result = settings.columnSetFromPreferences({ 'visible.path': true, 'visible.size': false, 'position.path': 1, 'position.name': 2, 'width.path': 320, 'alignment.path': 'right', 'title.name': 'My name' }, value => `translated:${value}`);
  assert.equal(result.columns[0].id, 'path');
  assert.equal(result.columns[0].width, 320);
  assert.equal(result.columns[0].align, 'right');
  assert.equal(result.columns.find(item => item.id === 'size').visible, false);
  assert.equal(result.columns.find(item => item.id === 'name').title, 'My name');
  assert.equal(result.columns.find(item => item.id === 'path').title, 'translated:Pfad');
});
