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

test('native Git binding and its linked component licenses are included without an isomorphic Git dependency', () => {
  const manifest = require('../package.json');
  const lock = require('../package-lock.json');
  const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.deepEqual(Object.keys(manifest.dependencies), ['@zip.js/zip.js']);
  assert.equal(lock.packages[''].dependencies['isomorphic-git'], undefined);
  assert.ok(lock.packages['node_modules/@zip.js/zip.js']);
  assert.match(rules, /!native\/binding\.node/);
  for (const broker of ['network-broker-win.exe', 'icons-broker-win.exe', 'file-broker-win.exe', 'clipboard-broker-win.exe']) {
    assert.equal(fs.existsSync(path.join(root, 'native', broker)), false, broker);
    assert.doesNotMatch(rules, new RegExp(`!native/${broker.replaceAll('.', '\\.')}\\r?\\n`), broker);
  }
  assert.match(rules, /^native\/\*\.exe$/m);
  assert.match(rules, /!node_modules\/@zip\.js\/zip\.js\/\*\*/);
  assert.doesNotMatch(rules, /!node_modules\/(?!@zip\.js\/zip\.js\/)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'Start-Development.ps1'), 'utf8'), /isomorphic-git/);
  assert.equal(fs.existsSync(path.join(root, 'licenses/GIT-DEPENDENCIES.txt')), false);
  const components = require('../licenses/components.json');
  for (const name of ['libgit2', 'sha1dc', 'llhttp', 'LibXDiff', 'PCRE2', 'zlib']) {
    const component = components.find(item => item.name === name); assert.ok(component, name);
    assert.ok(component.files.every(file => fs.existsSync(path.join(root, file))), name);
  }
  assert.equal(components.find(item => item.name === 'libgit2').version, '1.9.7');
});
