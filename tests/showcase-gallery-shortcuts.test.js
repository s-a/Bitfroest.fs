const test = require('node:test');
const assert = require('node:assert/strict');
const { renderGallery } = require('../scripts/showcases/publish.cjs');

test('default capture selects the same basic file-operation walkthroughs', () => {
  const { selectScenes } = require('../scripts/showcases/run.cjs');
  const catalog = ['main', 'new-folder', 'new-file', 'delete-confirmations', 'folder-locks', 'archive-options'].map(id => ({ id }));
  assert.deepEqual(selectScenes(catalog).map(scene => scene.id), ['new-folder', 'new-file', 'delete-confirmations']);
  assert.deepEqual(selectScenes(catalog, 'archive-options').map(scene => scene.id), ['archive-options']);
});

test('gallery includes the basic walkthroughs and the targeted file-lock recording', () => {
  const sections = ['new-folder', 'new-file', 'delete-confirmations', 'folder-locks', 'archive-options', 'main'].map((id, i) => ({
    id, title: id, status: 'rendered', images: [{ file: `${String(i + 1).padStart(4, '0')}-windows-en-dark-${id}-story.gif`, alt: id }]
  }));
  const output = renderGallery({ sections });
  for (const id of ['new-folder', 'new-file', 'delete-confirmations', 'folder-locks']) assert.ok(output.includes(id));
  for (const id of ['archive-options', 'main']) assert.ok(!output.includes(id));
});

test('handover animation appears above and inside the gallery after repeated publication', () => {
  const { updateReadme } = require('../scripts/showcases/publish.cjs');
  const manifest = { sections: [{ id: 'new-file', title: 'Create and organize handover notes', status: 'rendered', images: [{ file: '0010-windows-en-dark-new-file-story.gif', alt: 'Create and organize handover notes' }] }] };
  const before = '**A two-panel file manager for Visual Studio Code.** Example.\n\n![Overview](media/marketplace/showcases/0001-windows-en-dark-main-overview.gif)\n\n<!-- showcase-gallery:start -->\n<!-- showcase-gallery:end -->';
  const after = updateReadme(updateReadme(before, manifest), manifest);
  assert.match(after, /new-file-story\.gif\)[\s\S]*<!-- showcase-gallery:start -->[\s\S]*new-file-story\.gif\)/);
  assert.equal((after.match(/new-file-story\.gif/g) || []).length, 2);
  assert.doesNotMatch(after, /main-overview\.gif/);
});

test('gallery headings lead with escaped shortcut keycaps from the catalog', () => {
  const manifest = { sections: [{ id: 'new-folder', title: 'Old title', status: 'rendered', images: [
    { file: '0001-windows-en-dark-copy-dialog.gif', alt: 'Copy files' }
  ] }] };
  const catalog = [{ id: 'new-folder', title: 'Copy files dialog', shortcuts: ['F5', 'Shift+F4'] }];
  const output = renderGallery(manifest, catalog);
  assert.match(output, /<summary><kbd>F5<\/kbd> <kbd>Shift\+F4<\/kbd> Copy files dialog<\/summary>/);
  assert.doesNotMatch(output, /Old title/);
  assert.equal(renderGallery(manifest, [{ id: 'new-folder', title: 'Copy', shortcuts: ['<img>'] }]).includes('<kbd>&lt;img&gt;</kbd>'), true);
});

test('gallery groups rendered showcases under their catalog categories', () => {
  const manifest = { sections: [
    { id: 'new-folder', title: 'Copy', status: 'rendered', images: [{ file: '0001-windows-en-dark-copy.gif', alt: 'Copy' }] },
    { id: 'new-file', title: 'File', status: 'rendered', images: [{ file: '0002-windows-en-dark-file.gif', alt: 'File' }] }
  ] };
  const output = renderGallery(manifest, [
    { id: 'new-folder', title: 'Copy files', category: 'Basic File Operations' },
    { id: 'new-file', title: 'New file', category: 'Other' }
  ]);
  assert.match(output, /### Basic File Operations[\s\S]*?Copy files[\s\S]*?### Other[\s\S]*?New file/);
  assert.equal((output.match(/### /g) || []).length, 2);
});
