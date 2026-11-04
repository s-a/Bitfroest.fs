const definitions = require('./interaction-catalog.json');
const { localizedCatalog } = require('../../shortcut-settings');

function interactionInventory(manifest) {
  const recorded = id => manifest.sections.find(section => section.id === id && section.status === 'rendered')?.images.filter(image => image.format === 'gif') || [];
  const describe = (item, sceneId) => {
    const images = sceneId ? recorded(sceneId) : [];
    return { ...item, status: images.length ? 'recorded' : 'pending', images: images.map(image => image.file),
      ...(!images.length ? { reason: 'The source behavior is inventoried; a verified animation is still required.' } : {}) };
  };
  const shortcuts = localizedCatalog('en').map(item => describe({ id: item.id, kind: 'keyboard', title: item.title, detail: item.detail,
    command: item.command, keys: item.key, macKeys: item.mac, when: item.when, args: item.args,
    sources: ['shortcut-settings.js', 'package.json', 'media/commander-shortcuts.js'] }, item.command === 'bitfroest.path' && item.key === 'ctrl+l' ? 'shortcut-ctrl-l' : undefined));
  return { shortcuts, gestures: definitions.map(item => describe(item, item.sceneId)) };
}

module.exports = { interactionInventory };
