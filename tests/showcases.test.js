const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog, filename, assertProductState, waitFor, buildManifest, parseOptions, numberCatalog, assertSurfaceState } = require('../scripts/showcases/run.cjs');

const scene = () => ({ id: 'new-folder', title: 'Create a folder', description: 'Open the folder dialog.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{ id: 'dialog', action: 'mkdir', expect: 'dialog[open]', text: 'New folder' }] });
test('the npm entry uses the repository demo and accepts explicit overrides', () => {
  const path = require('node:path');
  assert.equal(require('../package.json').scripts.showcase, 'node scripts/showcases/run.cjs');
  assert.deepEqual(parseOptions([], 'C:/Code/Code.exe', 'C:/project'), {
    code: 'C:/Code/Code.exe', demo: path.join('C:/project', '.tmp/demo'), selected: undefined
  });
  assert.deepEqual(parseOptions(['--code', 'D:/Code.exe', '--demo', 'D:/demo', '--scene', 'main'], 'C:/Code.exe', 'C:/project'), {
    code: 'D:/Code.exe', demo: 'D:/demo', selected: 'main'
  });
  assert.throws(() => parseOptions(['--scene'], 'C:/Code.exe', 'C:/project'), /Missing value/);
  assert.throws(() => parseOptions(['--unknown', 'value'], 'C:/Code.exe', 'C:/project'), /Unknown option/);
});
test('showcase names remain stable and reject duplicate or unsafe output paths', () => {
  assert.equal(filename(scene()), '0001-windows-en-dark-new-folder.png');
  assert.equal(validateCatalog([scene()]).length, 1);
  assert.throws(() => validateCatalog([scene(), scene()]), /Duplicate/);
  assert.throws(() => validateCatalog([{ ...scene(), id: '../escape' }]), /identifier/);
  assert.throws(() => validateCatalog([{ ...scene(), paths: ['relative', 'C:/demo'] }]), /absolute/);
});
test('numbering follows the whole catalog and supports both screenshots and animations', () => {
  const catalog = [scene(), { ...scene(), id: 'gesture', captures: [{ ...scene().captures[0], format: 'gif' }] }];
  numberCatalog(catalog);
  assert.equal(filename(catalog[0], catalog[0].captures[0]), '0001-windows-en-dark-new-folder-dialog.png');
  assert.equal(filename(catalog[1], catalog[1].captures[0]), '0002-windows-en-dark-gesture-dialog.gif');
});
test('native editor and separate product surfaces require their own real readiness evidence', () => {
  const state = { visible: true, ready: true, text: 'Git History', owner: 'bitfroest.bitfroest-fs-prototype', kind: 'webview' };
  assertSurfaceState(state, { surface: 'git-history', text: 'Git History' });
  assert.throws(() => assertSurfaceState({ ...state, owner: 'other.extension' }, { surface: 'git-history', text: 'Git History' }));
  assert.throws(() => assertSurfaceState({ ...state, kind: 'editor', diff: false }, { surface: 'editor', text: 'Git History' }));
  assertSurfaceState({ ...state, kind: 'editor', diff: true }, { surface: 'editor', text: 'Git History' });
});
test('captures require the actual Windows filesystem state and expected visible mask', () => {
  const state = { platform: 'win32', realFilesystem: true, visible: true, iconsReady: true, text: 'New folder', paths: ['C:\\demo\\left', 'C:\\demo\\right'], pending: false };
  assertProductState(state, scene(), scene().captures[0]);
  for (const change of [{ platform: 'linux' }, { realFilesystem: false }, { visible: false }, { iconsReady: false }, { text: 'Preparing' }, { pending: true }, { paths: ['C:/elsewhere', 'C:/demo/right'] }]) {
    assert.throws(() => assertProductState({ ...state, ...change }, scene(), scene().captures[0]));
  }
});
test('the manifest preserves reading order, descriptions and multiple images per section', () => {
  const main = { ...scene(), id: 'main', captures: [{ id: 'overview', expect: '.pane', text: 'Files' }] };
  const child = { ...scene(), parentId: 'main', captures: [...scene().captures, { id: 'details', expect: 'dialog', text: 'Details' }] };
  validateCatalog([main, child]);
  const images = [{ scene: 'main', capture: 'overview', file: 'main.png' }, { scene: child.id, capture: 'dialog', file: 'dialog.png' }, { scene: child.id, capture: 'details', file: 'details.png' }];
  const result = buildManifest([main, child], images, { platform: 'win32' });
  assert.deepEqual(result.sections.map(item => item.id), ['main', 'new-folder']);
  assert.equal(result.sections[1].description, child.description);
  assert.equal(result.sections[1].parentId, 'main');
  assert.deepEqual(result.sections[1].images.map(item => item.file), ['dialog.png', 'details.png']);
  assert.throws(() => buildManifest([main, child], images.slice(0, 2), {}), /Missing capture/);
  assert.throws(() => validateCatalog([child, main]), /parent/);
});
test('readiness polling uses observed completion and reports bounded failure', async () => {
  let attempts = 0;
  assert.equal(await waitFor(async () => ++attempts === 3 ? 'ready' : null, 100, 1), 'ready');
  await assert.rejects(waitFor(async () => false, 5, 1), /Timed out/);
});
test('inventory-only masks remain explicit and never receive invented image references', () => {
  const item = { ...scene(), id: 'conflict', status: 'pending', reason: 'Requires a real transfer conflict.', captures: [] };
  validateCatalog([item]);
  const section = buildManifest([item], [], {}).sections[0];
  assert.equal(section.status, 'pending');
  assert.equal(section.reason, item.reason);
  assert.deepEqual(section.images, []);
  assert.throws(() => validateCatalog([{ ...item, reason: '' }]), /reason/);
});
test('the registered inventory has source evidence, safe actions and a main-view-first order', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'scripts/showcases/catalog.json'), 'utf8').replaceAll('${demo}', 'C:/demo'));
  validateCatalog(catalog);
  assert.equal(catalog[0].id, 'main');
  for (const item of catalog) {
    assert.ok(item.sources.length, item.id);
    for (const source of item.sources) assert.ok(fs.existsSync(path.join(root, source)), `${item.id}: ${source}`);
  }
  assert.throws(() => validateCatalog([{ ...scene(), captures: [{ ...scene().captures[0], action: 'clipboard-paste' }] }]), /Unsupported/);
  assert.throws(() => validateCatalog([{ ...scene(), captures: [{ ...scene().captures[0], listerAction: 'write-file' }] }]), /Unsupported/);
});
test('published showcase media stay out of extension packages', () => {
  const fs = require('node:fs'), path = require('node:path');
  const ignored = fs.readFileSync(path.resolve(__dirname, '../.vscodeignore'), 'utf8');
  assert.match(ignored, /^media\/marketplace\/showcases\/\*\*$/m);
  assert.doesNotMatch(ignored, /^!media\/marketplace\/showcases/m);
});
test('updating one scene preserves the other recorded scenes and their provenance', () => {
  const first = { ...scene(), id: 'main' }, second = { ...scene(), id: 'copy' };
  const previous = buildManifest([first, second], [{ scene: 'main', capture: 'dialog', file: '0001-main.png' }, { scene: 'copy', capture: 'dialog', file: '0002-copy.png' }], { commit: 'before' });
  const updated = buildManifest([first, second], [{ scene: 'copy', capture: 'dialog', file: '0002-copy.png' }], { commit: 'after' }, previous);
  assert.deepEqual(updated.sections[0], previous.sections[0]);
  assert.equal(updated.sections[1].host.commit, 'after');
  const initial = buildManifest([first, second], [{ scene: 'copy', capture: 'dialog', file: '0002-copy.png' }], {});
  assert.equal(initial.sections[0].status, 'unrecorded');
  assert.deepEqual(initial.sections[0].images, []);
});
test('the README gallery includes recorded media only and preserves surrounding documentation', () => {
  const { updateReadme, mediaName } = require('../scripts/showcases/publish.cjs');
  const manifest = { sections: [
    { id: 'gesture', title: 'Enter a path', description: 'Ctrl+L focuses the path.', status: 'rendered', images: [{ file: '0002-windows-en-dark-shortcut-ctrl-l-gesture.gif', alt: 'Ctrl+L' }] },
    { id: 'pending', title: 'Not captured', status: 'pending', images: [] }
  ] };
  const readme = '# Product\n\nExisting introduction.\n\n## Configuration\n\nExisting settings.\n';
  const result = updateReadme(readme, manifest);
  assert.match(result, /Existing introduction\./);
  assert.match(result, /Existing settings\./);
  assert.match(result, /media\/marketplace\/showcases\/0002-/);
  assert.doesNotMatch(result, /Not captured/);
  assert.equal(updateReadme(result, manifest), result);
  assert.throws(() => mediaName('../escape.gif'), /Invalid/);
});
test('interaction inventory tracks every registered shortcut and distinguishes recorded gestures', () => {
  const { interactionInventory } = require('../scripts/showcases/inventory.cjs');
  const { localizedCatalog } = require('../shortcut-settings');
  const result = interactionInventory({ sections: [{ id: 'shortcut-ctrl-l', status: 'rendered', images: [{ file: '0005-windows-en-dark-shortcut-ctrl-l-gesture.gif', format: 'gif' }] }] });
  assert.deepEqual(result.shortcuts.map(item => item.id), localizedCatalog('en').map(item => item.id));
  assert.equal(result.shortcuts.find(item => item.command === 'bitfroest.path').status, 'recorded');
  assert.ok(result.gestures.some(item => item.kind === 'drag-and-drop' && item.status === 'pending'));
});
