const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog, filename, assertProductState, waitFor, buildManifest, parseOptions, numberCatalog, assertSurfaceState } = require('../scripts/showcases/run.cjs');

const scene = () => ({ id: 'new-folder', title: 'Create a folder', description: 'Open the folder dialog.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{ id: 'dialog', action: 'mkdir', expect: 'dialog[open]', text: 'New folder' }] });

test('gallery entries show current catalog headings and media without duplicate explanations', () => {
  const { renderGallery } = require('../scripts/showcases/publish.cjs');
  const manifest = { sections: [{ id: 'path-copy', title: 'Copy a folder path', description: 'Old capture description.', status: 'rendered',
    host: { commit: 'recorded' }, images: [{ file: '0002-windows-en-dark-path-copy-gesture.gif', alt: 'Copy a folder path' }] }] };
  const original = JSON.stringify(manifest);
  const text = renderGallery(manifest, [{ id: 'path-copy', title: 'Copy folder path to clipboard' }]);
  assert.match(text, /<summary>Copy folder path to clipboard<\/summary>\n\n!\[Copy folder path to clipboard\]/);
  assert.doesNotMatch(text, /<small>|Old capture description|Copy the current folder path/);
  assert.equal(JSON.stringify(manifest), original);
});

test('X-Ray walkthrough selects another file and checks click and hover previews', () => {
  const scene = require('../scripts/showcases/catalog.json').find(entry => entry.id === 'xray-click');
  assert.ok(scene);
  assert.equal(scene.captures.length, 1);
  const steps = scene.captures[0].steps;
  const labels = steps.filter(step => step.type === 'click').map(step => step.effect);
  assert.deepEqual(labels, ['Select Notes.txt', 'Enable click preview', 'Preview X-Ray-Sample.sql', 'Switch to hover preview']);
  const checks = steps.filter(step => step.type === 'check').map(step => [step.selector, step.text]);
  assert.deepEqual(checks, [
    ['[data-xray-toggle][data-mode="click"]', undefined],
    ['[data-xray] .xray-title', 'X-Ray-Sample.sql'],
    ['[data-xray-toggle][data-mode="hover"]', undefined],
    ['[data-xray] .xray-title', 'X-Ray-Sample.ps1']
  ]);
});

test('capture clicks include the focus transition between pressing and releasing', () => {
  const { JSDOM } = require('jsdom');
  const { clickControl } = require('../scripts/showcases/run.cjs');
  const dom = new JSDOM('<button id="eye" type="button">Eye</button>');
  try {
    const button = dom.window.document.querySelector('button'), events = [];
    button.getBoundingClientRect = () => ({ width: 20 });
    for (const type of ['mousedown', 'focus', 'mouseup', 'click']) button.addEventListener(type, () => events.push(type));
    clickControl('#eye', dom.window.document);
    assert.deepEqual(events, ['mousedown', 'focus', 'mouseup', 'click']);
  } finally { dom.window.close(); }
});

test('each gesture pointer is already centered when its first visible element is appended', () => {
  const { JSDOM } = require('jsdom');
  const { installPointer } = require('../scripts/showcases/gestures.cjs');
  for (const [width, height] of [[1920, 1080], [1280, 768]]) {
    const dom = new JSDOM('<html><head></head><body><div class="monaco-workbench"></div></body></html>', { runScripts: 'outside-only' });
    try {
      Object.assign(dom.window, { innerWidth: width, innerHeight: height });
      const body = dom.window.document.body, append = body.append;
      let first;
      body.append = function (...nodes) {
        const pointer = nodes.find(node => node.id === 'showcase-pointer');
        if (pointer) first = { x: Number.parseFloat(pointer.style.left), y: Number.parseFloat(pointer.style.top) };
        return append.apply(this, nodes);
      };
      const position = dom.window.eval(`(${installPointer.toString()})()`);
      assert.deepEqual(first, { x: width / 2, y: height / 2 });
      assert.deepEqual({ ...position }, first);
    } finally { dom.window.close(); }
  }
});

test('lock documentation permits only inspection and unconfirmed operation previews', () => {
  for (const lockAction of ['unlock', 'terminate', 'delete', 'schedule', 'run']) {
    const value = scene();
    value.captures[0].lockAction = lockAction;
    assert.throws(() => validateCatalog([value]), /lock.*preview/i);
  }
});

test('isolated lock documentation uses the actual custom workbench dialogs', () => {
  const { profileSettings } = require('../scripts/showcases/run.cjs');
  assert.equal(profileSettings('C:/demo')['window.dialogStyle'], 'custom');
  for (const surface of ['inputbox', 'confirmation']) {
    const capture = { surface, text: 'Folder locks' };
    assert.doesNotThrow(() => assertSurfaceState({ visible: true, ready: true, text: 'Folder locks', kind: surface }, capture));
    assert.throws(() => assertSurfaceState({ visible: true, ready: true, text: 'Folder locks', kind: 'webview' }, capture), /surface/);
  }
});
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
  assertSurfaceState({ ...state, owner: '', kind: 'quickpick' }, { surface: 'quickpick', text: 'Git History' });
  assert.throws(() => assertSurfaceState(state, { surface: 'quickpick', text: 'Git History' }));
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

test('pointer movement follows elapsed time despite variable dispatch latency', async () => {
  const { animatePointer } = require('../scripts/showcases/gestures.cjs');
  let clock = 0;
  const points = [];
  await animatePointer({ start: { x: 0, y: 10 }, end: { x: 600, y: 70 }, duration: 600,
    now: () => clock, sleep: async ms => { clock += ms; },
    update: async point => { points.push({ ...point, time: clock }); clock += points.length % 3 ? 2 : 25; } });
  assert.deepEqual({ x: points.at(-1).x, y: points.at(-1).y }, { x: 600, y: 70 });
  assert.ok(points.length >= 25);
  assert.ok(clock < 650);
  for (const point of points) {
    const t = Math.min(1, point.time / 600), eased = t * t * (3 - 2 * t);
    assert.ok(Math.abs(point.x - 600 * eased) < .001);
  }
});

test('each button press queues one finite pulse, including two distinct double-click presses', () => {
  const { pulsePointer } = require('../scripts/showcases/gestures.cjs');
  const animations = [], ring = { dataset: {}, animate: (frames, options) => animations.push({ frames, options }) };
  pulsePointer(ring, 100);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].options.iterations, 1);
  assert.equal(animations[0].options.delay, 0);
  pulsePointer(ring, 180);
  assert.equal(animations.length, 2);
  assert.equal(animations[1].options.iterations, 1);
  assert.equal(animations[1].options.delay, 300);
  pulsePointer(ring, 1500);
  assert.equal(animations[2].options.delay, 0);
});

test('recording timing retains the final reading pause and a consistent image timebase', () => {
  const { frameList } = require('../scripts/showcases/gestures.cjs');
  const lines = frameList([{ name: 'first.png', timestamp: 1000 }, { name: 'last.png', timestamp: 1200 }], 2600);
  const duration = lines.filter(line => line.startsWith('duration ')).reduce((sum, line) => sum + Number(line.slice(9)), 0);
  assert.ok(Math.abs(duration - 1.6) < .000001);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('file ')) assert.equal(lines[index + 1], 'option framerate 1000');
  }
});

test('showcase favorites contain only known demo folders and never inherit settings', () => {
  const { profileSettings } = require('../scripts/showcases/run.cjs');
  const path = require('node:path');
  const demo = path.resolve('C:/safe-demo');
  const settings = profileSettings(demo);
  const favorites = settings['bitfroest.favorites.items'];
  assert.deepEqual(favorites.map(item => item.name), ['Project sources', 'Documents', 'Delivery inbox']);
  assert.deepEqual(favorites.map(item => item.path), ['left/bitfroest.fs', 'left/documents', 'right/inbox'].map(folder => path.join(demo, folder)));
  assert.ok(favorites.every(item => item.type === 'favorite' && item.parent === null));
  favorites[0].path = 'C:/private';
  assert.notEqual(profileSettings(demo)['bitfroest.favorites.items'][0].path, 'C:/private');
});

test('catalog additions renumber existing media without changing recorded provenance', () => {
  const { renumberManifest } = require('../scripts/showcases/run.cjs');
  const catalog = numberCatalog([scene(), { ...scene(), id: 'next' }]);
  const previous = { sections: [{ id: 'next', recordedAt: 'original', host: { commit: 'original' }, images: [{ file: '0001-windows-en-dark-next-dialog.png', alt: 'Existing' }] }] };
  const result = renumberManifest(catalog, previous);
  assert.equal(result.sections[0].images[0].file, '0002-windows-en-dark-next-dialog.png');
  assert.deepEqual(result.sections[0].host, previous.sections[0].host);
  assert.equal(result.sections[0].recordedAt, 'original');
  assert.equal(previous.sections[0].images[0].file, '0001-windows-en-dark-next-dialog.png');
});

test('capture clicks allow standalone buttons but reject submitting a real form', () => {
  const { clickControl } = require('../scripts/showcases/run.cjs');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button id="standalone">Click</button><form><button id="submit">Submit</button></form>');
  try {
    let clicked = 0;
    for (const button of dom.window.document.querySelectorAll('button')) {
      button.getBoundingClientRect = () => ({ width: 24 });
      button.addEventListener('click', () => clicked++);
    }
    clickControl('#standalone', dom.window.document);
    assert.equal(clicked, 1);
    assert.throws(() => clickControl('#submit', dom.window.document), /unavailable/);
    assert.equal(clicked, 1);
  } finally { dom.window.close(); }
});

test('publishing renumbered media removes previous gallery references and preserves unrelated files', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { publish, updateReadme } = require('../scripts/showcases/publish.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-publish-'));
  const old = '0001-windows-en-dark-next-dialog.png', current = '0002-windows-en-dark-next-dialog.png';
  try {
    fs.mkdirSync(path.join(root, '.tmp/showcases'), { recursive: true });
    fs.mkdirSync(path.join(root, 'media/marketplace/showcases'), { recursive: true });
    const manifest = { sections: [{ id: 'next', title: 'Next', description: 'Next view.', status: 'rendered', images: [{ file: current, alt: 'Next' }] }] };
    const earlier = { sections: [{ ...manifest.sections[0], images: [{ file: old, alt: 'Old' }] }] };
    fs.writeFileSync(path.join(root, 'README.md'), updateReadme('# Product\n\n## Configuration\n', earlier));
    fs.writeFileSync(path.join(root, '.tmp/showcases/showcases.json'), JSON.stringify(manifest));
    fs.mkdirSync(path.join(root, 'scripts/showcases'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/showcases/catalog.json'), JSON.stringify([{ id: 'next', title: 'Current catalog title' }]));
    fs.writeFileSync(path.join(root, '.tmp/showcases', current), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.writeFileSync(path.join(root, 'media/marketplace/showcases', old), 'old');
    fs.writeFileSync(path.join(root, 'media/marketplace/showcases/keep.png'), 'unrelated');
    publish(root);
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /<summary>Current catalog title<\/summary>/);
    assert.equal(fs.existsSync(path.join(root, 'media/marketplace/showcases', old)), false);
    assert.equal(fs.existsSync(path.join(root, 'media/marketplace/showcases', current)), true);
    assert.equal(fs.readFileSync(path.join(root, 'media/marketplace/showcases/keep.png'), 'utf8'), 'unrelated');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
