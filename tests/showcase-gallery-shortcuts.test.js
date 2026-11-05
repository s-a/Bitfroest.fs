const test = require('node:test');
const assert = require('node:assert/strict');
const { renderGallery } = require('../scripts/showcases/publish.cjs');

test('gallery headings lead with escaped shortcut keycaps from the catalog', () => {
  const manifest = { sections: [{ id: 'copy', title: 'Old title', status: 'rendered', images: [
    { file: '0001-windows-en-dark-copy-dialog.gif', alt: 'Copy files' }
  ] }] };
  const catalog = [{ id: 'copy', title: 'Copy files dialog', shortcuts: ['F5', 'Shift+F4'] }];
  const output = renderGallery(manifest, catalog);
  assert.match(output, /<summary><kbd>F5<\/kbd> <kbd>Shift\+F4<\/kbd> Copy files dialog<\/summary>/);
  assert.doesNotMatch(output, /Old title/);
  assert.equal(renderGallery(manifest, [{ id: 'copy', title: 'Copy', shortcuts: ['<img>'] }]).includes('<kbd>&lt;img&gt;</kbd>'), true);
});

test('gallery groups rendered showcases under their catalog categories', () => {
  const manifest = { sections: [
    { id: 'copy', title: 'Copy', status: 'rendered', images: [{ file: '0001-windows-en-dark-copy.gif', alt: 'Copy' }] },
    { id: 'git', title: 'Git', status: 'rendered', images: [{ file: '0002-windows-en-dark-git.gif', alt: 'Git' }] }
  ] };
  const output = renderGallery(manifest, [
    { id: 'copy', title: 'Copy files', category: 'Basic File Operations' },
    { id: 'git', title: 'Git status', category: 'Git Operations' }
  ]);
  assert.match(output, /### Basic File Operations[\s\S]*?Copy files[\s\S]*?### Git Operations[\s\S]*?Git status/);
  assert.equal((output.match(/### /g) || []).length, 2);
});
