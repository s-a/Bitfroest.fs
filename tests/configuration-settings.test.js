const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigurationSettings } = require('../configuration-settings');
function setup(values = {}, fail) {
  const writes = [];
  const settings = { inspect: key => values[key] || {}, async update(key, value, target) { if (fail?.(key, value)) throw new Error('Write failed'); values[key] ||= {}; values[key][target === 1 ? 'globalValue' : 'workspaceValue'] = value; writes.push({ key, value, target }); } };
  const backend = createConfigurationSettings({ workspace: { getConfiguration: () => settings, workspaceFolders: [{}] }, ConfigurationTarget: { Global: 1, Workspace: 2 } }, { t: value => value, saved() {} });
  return { backend, writes, values };
}
test('configuration editor keeps user and workspace trees separate and does not rewrite unchanged columns', async () => {
  const { backend, writes } = setup({ 'favorites.entries': { globalValue: { Personal: 'C:/personal' }, workspaceValue: { Team: 'C:/team' } } });
  const data = backend.read('user'); assert.equal(data.favorites.length, 1); assert.equal(data.favorites[0].name, 'Personal');
  data.favorites.push({ id: 'new', type: 'group', name: 'Empty group', parent: null });
  await backend.write(data, 'user');
  assert.equal(writes.length, 1); assert.equal(writes[0].key, 'favorites.items'); assert.equal(writes[0].target, 1);
  assert.equal(backend.read('workspace').favorites[0].name, 'Team');
});
test('failed combined save restores the previous tree instead of leaving a partial configuration', async () => {
  const { backend, values } = setup({}, key => key === 'columns.layout');
  const data = backend.read('user'); data.favorites.push({ id: 'g', type: 'group', name: 'G', parent: null }); data.columns[0].align = 'right';
  await assert.rejects(backend.write(data, 'user'), /Write failed/);
  assert.equal(values['favorites.items'].globalValue, undefined);
});

test('legacy width settings are ignored while localized defaults remain available', () => {
  const { backend } = setup({ 'columns.widths': { globalValue: { 'standard.name': 400 } } });
  const data = backend.read('user');
  assert.equal(Object.hasOwn(data.columns.find(item => item.id === 'name'), 'width'), false);
  assert.equal(data.columns.find(item => item.id === 'size').visible, true);
  assert.equal(data.columns.find(item => item.id === 'path').visible, false);
});

test('workspace shortcut edits preserve user inheritance and reject inherited collisions', async () => {
  const { catalog } = require('../shortcut-settings');
  const copy = catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
  const move = catalog.find(item => item.command === 'bitfroest.move' && item.key === 'f6');
  const { backend, writes } = setup({ 'shortcuts.bindings': { globalValue: { [copy.id]: 'ctrl+shift+k' } } });
  const data = backend.read('workspace');
  assert.deepEqual(data.shortcuts, {});
  data.shortcuts[move.id] = 'ctrl+shift+k';
  await assert.rejects(backend.write(data, 'workspace'), /Überlappende/);
  assert.equal(writes.length, 0);
  data.shortcuts[move.id] = 'ctrl+shift+j'; await backend.write(data, 'workspace');
  assert.equal(writes[0].target, 2); assert.deepEqual(writes[0].value, { [move.id]: 'ctrl+shift+j' });
});
