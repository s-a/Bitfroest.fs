const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');

test('auxiliary editor windows expose an icon-only file manager launcher for every editor type', () => {
  const command = manifest.contributes.commands.find(item => item.command === 'bitfroest.show');
  assert.equal(command.icon, '$(folder)');
  assert.equal(command.enablement, 'bitfroest.canOpen');
  const entries = manifest.contributes.menus['editor/title'].filter(item => item.command === command.command);
  assert.equal(entries.length, 1);
  assert.match(entries[0].group, /^navigation(?:@\d+)?$/);
  assert.equal(entries[0].when, 'isAuxiliaryWindow && activeWebviewPanelId != bitfroestPrototype');
  assert.ok(command.title, 'the icon keeps its localized tooltip and accessible command title');
});
