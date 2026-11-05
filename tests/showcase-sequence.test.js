const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSequence, executeSequence, inspectState, assertSafePointer } = require('../scripts/showcases/sequence.cjs');
const { JSDOM } = require('jsdom');

test('click labels wait for the corresponding dispatched press and never precede it', async () => {
  const { dispatchMouseInput } = require('../scripts/showcases/gestures.cjs');
  const events = [];
  let finish;
  const pending = dispatchMouseInput({ type: 'mousePressed', button: 'right' }, async () => {
    events.push('press'); await new Promise(resolve => { finish = resolve; });
  }, async (label, down) => events.push({ label, down }));
  assert.deepEqual(events, ['press']);
  finish(); await pending;
  assert.deepEqual(events, ['press', { label: 'Right click', down: true }]);
  await dispatchMouseInput({ type: 'mouseMoved' }, async () => {}, async () => assert.fail('Movement must not announce a click'));
});

test('renumbering a video also renumbers its gallery fallback', () => {
  const { renumberManifest, numberCatalog } = require('../scripts/showcases/run.cjs');
  const catalog = numberCatalog([{ id: 'rename', captures: [{ id: 'editor', format: 'webm' }] }]);
  const previous = { sections: [{ id: 'rename', images: [{ file: '0009-windows-en-dark-rename-editor.webm', fallback: '0009-windows-en-dark-rename-editor.gif' }] }] };
  assert.equal(renumberManifest(catalog, previous).sections[0].images[0].fallback, '0001-windows-en-dark-rename-editor.gif');
});

test('WebM uses VP9 live-frame encoding and publishes a GIF fallback instead of a video image', () => {
  const { encodingArgs } = require('../scripts/showcases/gestures.cjs');
  const args = encodingArgs('demo.webm', true, 4.2);
  assert.ok(args.includes('libvpx-vp9'));
  assert.ok(args.includes('frames.txt'));
  const gifArgs = encodingArgs('demo.gif', false, 4.2, 'demo.webm');
  assert.equal(gifArgs[gifArgs.indexOf('-i') + 1], 'demo.webm');
  assert.ok(!gifArgs.includes('frames.txt'));
  const { renderGallery, mediaName } = require('../scripts/showcases/publish.cjs');
  const file = '0001-windows-en-dark-rename-editor.webm';
  assert.equal(mediaName(file), file);
  const text = renderGallery({ sections: [{ id: 'rename', title: 'Rename', description: 'Cancel edits.', status: 'rendered', images: [{ file, fallback: file.replace('.webm', '.gif'), alt: 'Rename' }] }] });
  assert.match(text, /!\[Rename\]\([^\n]+\.gif\)/);
  assert.doesNotMatch(text, /webm/i);
});

test('gallery publication copies only the GIF and removes the formerly linked video', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { publish } = require('../scripts/showcases/publish.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-gif-only-'));
  const video = '0001-windows-en-dark-rename-editor.webm', gif = video.replace('.webm', '.gif');
  try {
    const input = path.join(root, '.tmp/showcases'), output = path.join(root, 'media/marketplace/showcases');
    fs.mkdirSync(input, { recursive: true }); fs.mkdirSync(output, { recursive: true });
    const manifest = { sections: [{ id: 'rename', title: 'Rename', description: 'Cancel edits.', status: 'rendered', images: [{ file: video, fallback: gif, alt: 'Rename' }] }] };
    fs.writeFileSync(path.join(input, 'showcases.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(input, gif), 'GIF89a');
    fs.writeFileSync(path.join(output, video), 'previous recording');
    fs.writeFileSync(path.join(root, 'README.md'), `# Product\n<!-- showcase-gallery:start -->\n[Watch WebM](media/marketplace/showcases/${video})\n<!-- showcase-gallery:end -->\n`);
    publish(root);
    assert.equal(fs.existsSync(path.join(output, video)), false);
    assert.equal(fs.readFileSync(path.join(output, gif), 'utf8'), 'GIF89a');
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /webm/i);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('catalog sequences execute ordered real inputs and retain observed checks', async () => {
  const steps = [
    { type: 'move', target: { name: 'Notes.txt' }, duration: 500 },
    { type: 'press', button: 'right' }, { type: 'pause', duration: 600 },
    { type: 'move', target: { selector: '.list', side: 1 } }, { type: 'release', button: 'right' },
    { type: 'key', key: 'Escape' }, { type: 'check', selector: '.inline-rename', absent: true }
  ];
  const calls = [];
  const evidence = await executeSequence(steps, {
    move: async step => calls.push(['move', step.target]),
    mouse: async (type, button) => calls.push([type, button]),
    pause: async ms => calls.push(['pause', ms]),
    key: async key => calls.push(['key', key]),
    check: async step => { calls.push(['check', step.selector]); return { matched: true, visible: false }; }
  });
  assert.deepEqual(calls.map(call => call[0]), ['move', 'press', 'pause', 'move', 'release', 'key', 'check']);
  assert.equal(evidence.length, steps.length);
  assert.deepEqual(evidence.at(-1).observed, { matched: true, visible: false });
  assert.ok(evidence.every(item => item.finishedAt >= item.startedAt));
});

test('sequences reject unsafe keys, malformed targets and unbalanced mouse buttons before input', async () => {
  for (const steps of [[], [{ type: 'key', key: 'Enter' }], [{ type: 'key', key: 'Delete' }],
    [{ type: 'key', key: 'Ctrl+V' }], [{ type: 'pause', duration: -1 }],
    [{ type: 'move', target: { selector: '.list', side: 4 } }],
    [{ type: 'press', button: 'right' }], [{ type: 'release', button: 'left' }],
    [{ type: 'check', selector: '.list', absent: true, text: 'Files' }], [{ type: 'script', expression: 'anything' }]]) {
    assert.throws(() => validateSequence(steps));
    await assert.rejects(executeSequence(steps, {}));
  }
});

test('sequences allow file-manager keys used to open nonconfirming showcases', () => {
  for (const key of ['F2', 'F3', 'F5', 'F6', 'F7', 'F8', 'Shift+F4', 'Shift+F8']) {
    assert.doesNotThrow(() => validateSequence([{ type: 'key', key }]));
  }
});

test('sequences allow the read-only editor Find chord', () => {
  assert.doesNotThrow(() => validateSequence([
    { type: 'key', key: 'Ctrl+F', effect: 'Find in diff' },
    { type: 'key', key: 'Escape', effect: 'Close diff search' }
  ]));
});

test('sequences allow the nonconfirming numeric keypad selection commands', () => {
  assert.doesNotThrow(() => validateSequence([
    { type: 'key', key: 'NumpadAdd', effect: 'Select files by mask' },
    { type: 'key', key: 'Escape', effect: 'Cancel group selection' },
    { type: 'key', key: 'NumpadSubtract', effect: 'Deselect files by mask' },
    { type: 'key', key: 'Ctrl+NumpadSubtract', effect: 'Clear current selection' }
  ]));
});

test('sequences allow the documented archive action chords', () => {
  assert.doesNotThrow(() => validateSequence([
    { type: 'key', key: 'Alt+F5', effect: 'Open packing options' },
    { type: 'key', key: 'Escape', effect: 'Cancel packing options' },
    { type: 'key', key: 'Alt+F9', effect: 'Open extraction options' }
  ]));
});

test('failed interface checks stop the sequence before further input', async () => {
  let keys = 0;
  await assert.rejects(executeSequence([{ type: 'check', selector: '.inline-rename' }, { type: 'key', key: 'F2' }], {
    check: async () => { throw new Error('Expected state not observed'); }, key: async () => keys++
  }), /step 1.*Expected state/);
  assert.equal(keys, 0);
});

test('interface checks read visibility, focus, text and value without changing the product', () => {
  const dom = new JSDOM('<input class="inline-rename" value="Notes.txt"><span hidden>Hidden</span>');
  try {
    const input = dom.window.document.querySelector('input');
    const hiddenWidget = dom.window.document.createElement('div'); hiddenWidget.setAttribute('aria-hidden', 'true'); dom.window.document.body.append(hiddenWidget);
    input.getBoundingClientRect = () => ({ width: 100, height: 20 });
    hiddenWidget.getBoundingClientRect = () => ({ width: 100, height: 20 });
    input.focus();
    assert.equal(inspectState({ selector: 'input', value: 'Notes.txt', focused: true }, dom.window.document).matched, true);
    assert.equal(inspectState({ selector: 'input', value: 'Other.txt' }, dom.window.document).matched, false);
    assert.equal(inspectState({ selector: 'span', absent: true }, dom.window.document).matched, true);
    assert.equal(inspectState({ selector: 'div', absent: true }, dom.window.document).matched, true);
    assert.equal(input.value, 'Notes.txt');
  } finally { dom.window.close(); }
});

test('pointer safety blocks confirmation controls but permits cancellation and file selection', () => {
  const dom = new JSDOM('<div data-file-row>Notes.txt</div><dialog open><button id="modal-ok">OK</button><button id="modal-cancel">Cancel</button></dialog>');
  try {
    const doc = dom.window.document;
    assert.throws(() => assertSafePointer(doc.querySelector('#modal-ok')), /confirmation/);
    assert.doesNotThrow(() => assertSafePointer(doc.querySelector('#modal-cancel')));
    assert.doesNotThrow(() => assertSafePointer(doc.querySelector('[data-file-row]')));
  } finally { dom.window.close(); }
});
