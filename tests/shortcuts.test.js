const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../media/bitfroest-shortcuts');

test('search filtering has an editable Ctrl Shift F binding restricted to file list focus', () => {
  const manifest = require('../package.json');
  const entry = model.createCatalog(manifest).find(item => item.command === 'bitfroest.filter-search-matches');
  assert.ok(entry);
  assert.equal(entry.key, 'ctrl+shift+f');
  assert.equal(entry.editable, true);
  const binding = manifest.contributes.keybindings.find(item => item.command === entry.command);
  assert.ok(binding.when.includes(`!bitfroest.shortcutOverride.${entry.id}`));
  for (const platform of ['win32', 'linux']) {
    assert.equal(model.active(entry, { listFocus: true }, platform), true);
    for (const focus of [{}, { listFocus: true, textInput: true }, { listerFocus: true }, { searchFocus: true }]) assert.equal(model.active(entry, focus, platform), false);
  }
});

test('search match selection has an editable Ctrl B binding restricted to file lists', () => {
  const manifest = require('../package.json');
  const entry = model.createCatalog(manifest).find(item => item.command === 'bitfroest.select-search-matches');
  assert.ok(entry);
  assert.equal(entry.key, 'ctrl+b');
  assert.equal(entry.editable, true);
  const binding = manifest.contributes.keybindings.find(item => item.command === entry.command);
  assert.ok(binding.when.includes(`!bitfroest.shortcutOverride.${entry.id}`));
  assert.equal(model.active(entry, { listFocus: true }, 'win32'), true);
  for (const focus of [{}, { listFocus: true, textInput: true }, { listerFocus: true }, { searchFocus: true }]) assert.equal(model.active(entry, focus, 'win32'), false);
  for (const language of ['', '.de']) {
    const strings = require(`../package.nls${language}.json`);
    assert.ok(strings['command.bitfroest.select-search-matches.title']);
  }
});

test('slash path shortcut has an editable guarded native binding limited to file list focus', () => {
  const manifest = require('../package.json');
  const entry = model.createCatalog(manifest).find(item => item.command === 'bitfroest.copy-full-names-slash');
  assert.equal(entry.key, 'ctrl+shift+y');
  assert.equal(entry.editable, true);
  const binding = manifest.contributes.keybindings.find(item => item.command === entry.command);
  assert.ok(binding.when.includes(`!bitfroest.shortcutOverride.${entry.id}`));
  for (const platform of ['win32', 'linux']) {
    assert.equal(model.active(entry, { listFocus: true }, platform), true);
    for (const focus of [{}, { textInput: true }, { listFocus: true, textInput: true }, { listerFocus: true }]) assert.equal(model.active(entry, focus, platform), false);
  }
});
const manifest = require('../package.json');
const catalog = model.createCatalog(manifest);
const find = (command, key) => catalog.find(item => item.command === `bitfroest.${command}` && item.key === key);

test('F2 renames only in file lists while refresh remains on Ctrl R', () => {
  const rename = find('rename-one', 'f2'); assert.ok(rename);
  for (const platform of ['win32', 'linux']) {
    assert.equal(model.active(rename, { listFocus: true }, platform), true);
    assert.equal(model.active(rename, { listFocus: true, searchResults: true }, platform), true);
    for (const focus of [{ textInput: true }, { inlineRenameInput: true, textInput: true }, { searchFocus: true }, { listerFocus: true }, {}]) assert.equal(model.active(rename, focus, platform), false);
    assert.deepEqual(model.keys(find('refresh', 'ctrl+r'), {}, platform), ['ctrl+r']);
    const active = catalog.filter(item => model.active(item, { listFocus: true, searchResults: true }, platform) && model.keys(item, {}, platform).includes('f2'));
    assert.deepEqual(active.map(item => item.command), ['bitfroest.rename-one']);
  }
  assert.ok(find('rename-one', 'shift+f6'));
  assert.match(manifest.contributes.keybindings.find(item => item.key === 'f2' && item.command === rename.command).when, new RegExp(`!bitfroest\\.shortcutOverride\\.${rename.id}$`));
});

test('localized shortcut catalogs retain labels with statically verifiable resource loads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { inspectRuntimeSource } = require('./support/runtime-architecture.cjs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'shortcut-settings.js'), 'utf8');
  assert.deepEqual(inspectRuntimeSource(source, 'shortcut-settings.js'), []);
  const { localizedCatalog } = require('../shortcut-settings');
  for (const [language, resource] of [['de-DE', require('../package.nls.de.json')], ['en', require('../package.nls.json')]]) {
    const localized = localizedCatalog(language);
    assert.equal(localized.length, catalog.length);
    for (const item of catalog) {
      const key = item.title.replace(/^%|%$/g, '');
      if (resource[key]) assert.equal(localized.find(entry => entry.id === item.id).title, resource[key]);
    }
  }
});

test('catalog retains every manifest default and distinguishes parameter actions and contexts', () => {
  assert.equal(catalog.filter(item => item.source === 'manifest').length, manifest.contributes.keybindings.length);
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  assert.notEqual(find('copy', 'f5').id, find('transfer-name-parts', 'f5').id);
  assert.equal(find('openPrototype', 'ctrl+alt+shift+f12').editable, false);
});
test('capture normalizes keys and modifiers without intercepting composition or AltGr', () => {
  assert.equal(model.capture({ key: 'K', ctrlKey: true, shiftKey: true }), 'ctrl+shift+k');
  assert.equal(model.capture({ key: '+', code: 'NumpadAdd' }), 'numpad_add');
  assert.equal(model.capture({ key: 'ö', code: 'Semicolon', altKey: true }), 'alt+[semicolon]');
  assert.equal(model.capture({ key: 'Control', ctrlKey: true }), null);
  assert.equal(model.capture({ key: '@', ctrlKey: true, altKey: true }), null);
  assert.equal(model.capture({ key: 'a', isComposing: true }), null);
});
test('conflicts respect disjoint focus, default priorities and platform variants', () => {
  assert.deepEqual(model.conflicts(catalog, {}, 'win32'), []);
  const copy = find('copy', 'f5');
  const conflicts = model.conflicts(catalog, { [copy.id]: 'f6' }, 'win32');
  assert.ok(conflicts.some(pair => pair.ids.includes(copy.id) && pair.ids.includes(find('move', 'f6').id)));
  assert.equal(model.conflicts(catalog, { [copy.id]: 'f6', [find('move', 'f6').id]: '' }, 'win32').length, 0);
  assert.ok(model.conflicts(catalog, { [copy.id]: 'cmd+c' }, 'darwin').length > 0);
});
test('validation rejects unknown actions, chords, unsafe text keys and immutable global keys', () => {
  const copy = find('copy', 'f5');
  for (const overrides of [{ missing: 'f10' }, { [copy.id]: 'ctrl+k ctrl+c' }, { [copy.id]: 'q' }, { [find('openPrototype', 'ctrl+alt+shift+f12').id]: 'f10' }]) assert.throws(() => model.validate(catalog, overrides, 'win32'));
  assert.deepEqual(model.validate(catalog, { [copy.id]: 'ctrl+shift+k' }, 'win32'), { [copy.id]: 'ctrl+shift+k' });
});
test('text editing retains its standard copy and dialog keys', () => {
  const transfer = find('transfer-name-parts', 'f5');
  assert.throws(() => model.validate(catalog, { [transfer.id]: 'ctrl+c' }, 'win32'));
  assert.throws(() => model.validate(catalog, { [transfer.id]: 'escape' }, 'win32'));
});
test('dispatch changes only overridden bindings and suppresses the replaced default', () => {
  const copy = find('copy', 'f5'), values = { [copy.id]: 'ctrl+shift+k' }, focus = { listFocus: true };
  assert.equal(model.resolve(catalog, values, 'ctrl+shift+k', focus, 'win32').entry.id, copy.id);
  assert.equal(model.resolve(catalog, values, 'f5', focus, 'win32').blocked, true);
  assert.equal(model.resolve(catalog, values, 'f5', { transferNameInput: true, textInput: true, fileDialog: true }, 'win32'), null);
  assert.equal(model.resolve(catalog, {}, 'f5', focus, 'win32'), null);
  assert.equal(model.resolve(catalog, values, 'ctrl+shift+k', { textInput: true }, 'win32'), null);
});

test('system menu setting preserves the existing shortcut identity and limits the default binding', () => {
  const { createCatalog } = require('../media/bitfroest-shortcuts');
  const manifest = require('../package.json');
  const entry = createCatalog(manifest).find(item => item.command === 'bitfroest.shell-context-menu');
  assert.equal(entry.id, 'k1opszch');
  assert.match(manifest.contributes.keybindings.find(item => item.command === entry.command).when, /config\.bitfroest\.files\.useSystemContextMenu/);
  assert.equal(require('../media/bitfroest-shortcuts').active(entry, { listFocus: true }, 'win32'), true);
});

test('folder tab shortcuts retain their stored identities and accept only pane navigation focus', () => {
  for (const [command, id] of [['next-tab', 'kqztrg3'], ['previous-tab', 'k1o87ddq']]) {
    const entry = catalog.find(item => item.command === `bitfroest.${command}`);
    assert.equal(entry.id, id);
    assert.equal(model.active(entry, { tabFocus: true }, 'win32'), true);
    assert.equal(model.active(entry, { listFocus: true }, 'win32'), true);
    assert.equal(model.active(entry, { tabFocus: true, textInput: true }, 'win32'), false);
    assert.equal(model.active(entry, { listerFocus: true }, 'win32'), false);
    assert.equal(model.active(entry, {}, 'win32'), false);
  }
});
