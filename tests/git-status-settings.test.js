const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('Git settings are editable as scalar values or simple lists with German and English text', () => {
  const manifest = require('../package.json');
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(group => group.properties));
  const english = require('../package.nls.json'), german = require('../package.nls.de.json');
  for (const key of ['enabled', 'showClean', 'showUntracked', 'showIgnored', 'recursive', 'untrackedAsModified', 'allowNetwork', 'includePaths', 'excludePaths']) {
    const value = properties[`bitfroest.gitStatus.${key}`]; assert.ok(value, key);
    assert.ok(['boolean', 'array'].includes(value.type));
    if (value.type === 'array') assert.equal(value.items.type, 'string');
    const label = value.description.replace(/^%|%$/g, ''); assert.ok(english[label]); assert.ok(german[label]);
  }
  assert.ok(manifest.contributes.commands.some(command => command.command === 'bitfroest.showLocalBranches'));
});

test('Git runtime dependency and its license are explicitly included in the extension package', () => {
  const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(rules, /!node_modules\/isomorphic-git\/\*\*/);
  const component = require('../licenses/components.json').find(item => item.name === 'isomorphic-git'); assert.ok(component);
  assert.ok(component.files.every(file => fs.existsSync(path.join(root, file))));
  assert.equal(component.version, JSON.parse(fs.readFileSync(path.join(root, 'node_modules/isomorphic-git/package.json'), 'utf8')).version);
});
