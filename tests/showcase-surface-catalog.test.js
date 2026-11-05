const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog } = require('../scripts/showcases/run.cjs');

test('animated native surfaces retain their command setup and add a real interaction sequence', () => {
  const catalog = [{ id: 'branches', title: 'Local branches', description: 'Inspect branch choices.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{
    id: 'quickpick', format: 'gif', surface: 'quickpick', command: 'bitfroest.showLocalBranches', expect: '.quick-input-widget', text: 'Available branches',
    steps: [{ type: 'check', selector: '.quick-input-widget', text: 'Available branches' }, { type: 'key', key: 'Escape', effect: 'Close branch list' }]
  }] }];
  assert.doesNotThrow(() => validateCatalog(catalog));
});
