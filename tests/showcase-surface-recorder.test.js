const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { EventEmitter } = require('node:events');
const { createSurfaceRecorder, assertSafeSurfaceTarget, targetRect } = require('../scripts/showcases/surface-recorder.cjs');
const { captureSurface, visibleInputRects } = require('../scripts/showcases/surfaces.cjs');

function gifHeader(width, height) {
  const bytes = Buffer.alloc(10);
  bytes.write('GIF89a', 0, 'ascii'); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8);
  return bytes;
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-surface-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dom = new JSDOM('<html><head></head><body><main class="monaco-workbench"><button id="target">Target</button><input id="name"></main></body></html>', { runScripts: 'outside-only' });
  dom.window.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
  const calls = [];
  class Page extends EventEmitter {
    async call(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.enable') return {};
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png-frame').toString('base64') };
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 };
      if (method === 'DOM.getBoxModel') return { model: { content: [30, 40, 300, 40, 300, 400, 30, 400] } };
      if (method === 'Runtime.evaluate') {
        const expression = params.expression || '';
        if (expression.includes('expected: text')) return { result: { value: { visible: true, ready: true, text: 'Sample input', owner: '', expected: 'Sample input' } } };
        if (expression.includes('matched:')) return { result: { value: { visible: true, text: 'Sample input', value: 'Sample name', focused: true, matched: true } } };
        if (expression.includes('targetRect')) return { result: { value: { x: 100, y: 120 } } };
        if (expression.includes('window.innerWidth / 2')) return { result: { value: { x: 640, y: 450 } } };
        if (expression.includes('activeElement') && expression.includes('readOnly')) return { result: { value: true } };
        if (expression.includes('querySelectorAll') && expression.includes('getBoundingClientRect')) return { result: { value: [] } };
      }
      if (method === 'Page.startScreencast') queueMicrotask(() => this.emit('Page.screencastFrame', { sessionId: 3, data: Buffer.from('raw-frame').toString('base64'), metadata: { timestamp: 10 } }));
      if (method === 'Input.insertText') {
        const input = dom.window.document.activeElement;
        input.value += params.text; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }
      return {};
    }
  }
  const page = new Page();
  const evaluator = dom.window.eval.bind(dom.window);
  const pageEvaluate = async (fn, ...args) => evaluator(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`);
  const targetEvaluate = async (fn, ...args) => fn(...args, dom.window.document);
  const encoder = (binary, args, options) => {
    const output = args.at(-1);
    fs.writeFileSync(output, output.endsWith('.webm') ? Buffer.from('webm-frame') : gifHeader(640, 400));
    return { status: 0, error: null, stderr: '' };
  };
  let clock = 10000;
  const now = () => { clock += 16; return clock; };
  const sleep = async milliseconds => { clock += milliseconds; };
  return { dom, page, calls, directory, pageEvaluate, targetEvaluate, encoder, now, sleep };
}

test('captureSurface executes a sequence and forwards safe action labels to the recording', async t => {
  const h = harness(t), input = h.dom.window.document.querySelector('#name'); input.focus();
  h.page.contexts = [{ id: 'surface-context' }];
  const result = await captureSurface({
    capture: { surface: 'markdown', format: 'webm', expect: '.monaco-workbench', text: 'Sample input', steps: [
      { type: 'type', selector: '#name', text: 'Sample name', value: 'Sample name' },
      { type: 'click', target: { selector: '#target' }, effect: 'Focus tab' },
      { type: 'key', key: 'F2', effect: 'Rename' },
      { type: 'check', selector: '#name', value: 'Sample name', focused: true }
    ] },
    targets: async () => [
      { id: 'webview', type: 'iframe', parentId: 'host-page', url: 'vscode-webview://extensionId=bitfroest.bitfroest-fs-prototype', webSocketDebuggerUrl: 'ws://frame' },
      { id: 'host-page', type: 'page', webSocketDebuggerUrl: 'ws://host' }
    ],
    connect: async () => h.page, connections: [], invoke: async () => ({}), waitFor: async read => read(),
    run: h.directory, file: '0001-windows-en-dark-surface.webm',
    encode: h.encoder
  });
  assert.equal(result.format, 'webm');
  assert.equal(Buffer.from(result.data, 'base64').toString(), 'webm-frame');
  assert.equal(Buffer.from(result.fallback, 'base64').toString('ascii', 0, 3), 'GIF');
  assert.deepEqual([result.width, result.height], [640, 400]);
  assert.equal(input.value, 'Sample name');
  assert.ok(h.calls.some(call => call.method === 'Input.insertText'));
  const evidence = JSON.parse(fs.readFileSync(path.join(h.directory, '0001-windows-en-dark-surface', 'evidence.json'), 'utf8'));
  assert.ok(evidence.events.some(event => event.type === 'click' && event.effect === 'Focus tab'));
  assert.ok(evidence.events.some(event => event.type === 'keyDown' && event.key === 'F2' && event.effect === 'Rename'));
});

test('captureSurface keeps the existing PNG return shape and screenshot path', async t => {
  const h = harness(t);
  h.page.contexts = [{ id: 'surface-context' }];
  const result = await captureSurface({
    capture: { surface: 'inputbox', expect: '.monaco-workbench', text: 'Sample input' },
    targets: async () => [{ id: 'host-page', type: 'page', webSocketDebuggerUrl: 'ws://host' }],
    connect: async () => h.page, connections: [], invoke: async () => ({}), waitFor: async read => read()
  });
  assert.equal(result.data, Buffer.from('png-frame').toString('base64'));
  assert.equal(result.format, undefined);
  assert.ok(h.calls.some(call => call.method === 'Page.captureScreenshot'));
});

test('surface overlay protection covers visible editable fields and skips controls', () => {
  const dom = new JSDOM('<body><input id="text"><input id="check" type="checkbox"><input id="hidden" type="hidden"><textarea id="disabled" disabled></textarea></body>');
  try {
    for (const element of dom.window.document.querySelectorAll('input,textarea')) {
      element.getBoundingClientRect = () => element.id === 'text'
        ? { left: 120, top: 220, right: 360, bottom: 245, width: 240, height: 25 }
        : { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 };
    }
    assert.deepEqual(visibleInputRects(dom.window.document), [{ left: 120, top: 220, right: 360, bottom: 245 }]);
  } finally { dom.window.close(); }
});

test('surface recording captures real CDP frames and coordinates a webview mouse target with its host offset', async t => {
  const h = harness(t);
  const targetElement = h.dom.window.document.querySelector('#target');
  targetElement.getBoundingClientRect = () => ({ x: 100, y: 120, left: 100, top: 120, right: 180, bottom: 150, width: 80, height: 30 });
  const recorder = await createSurfaceRecorder({
    page: h.page, target: { id: 'webview-frame', type: 'iframe' },
    pageEvaluate: h.pageEvaluate, targetEvaluate: h.targetEvaluate,
    frameDirectory: path.join(h.directory, 'frames'), outputFile: path.join(h.directory, 'surface.gif'),
    encode: h.encoder, now: h.now, sleep: h.sleep
  });
  await recorder.click('#target');
  const result = await recorder.finish();
  assert.equal(result.frames, 1);
  assert.deepEqual([result.width, result.height], [640, 400]);
  const press = h.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed');
  assert.equal(press.params.x, 170);
  assert.equal(press.params.y, 175);
  assert.ok(h.calls.some(call => call.method === 'Page.startScreencast'));
  assert.ok(h.calls.some(call => call.method === 'Page.screencastFrameAck'));
  assert.ok(h.calls.some(call => call.method === 'Page.stopScreencast'));
  assert.equal(h.dom.window.document.querySelector('#showcase-pointer'), null);
});

test('surface recording rejects confirmation controls and only types into focused text inputs', async t => {
  const h = harness(t);
  const input = h.dom.window.document.querySelector('#name'); input.focus();
  const confirmation = h.dom.window.document.createElement('section'); confirmation.setAttribute('role', 'dialog');
  confirmation.innerHTML = '<button type="submit" id="modal-ok">Confirm</button>';
  h.dom.window.document.body.append(confirmation);
  confirmation.querySelector('#modal-ok').getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 });
  const recorder = await createSurfaceRecorder({
    page: h.page, target: { id: 'host-page', type: 'page' },
    pageEvaluate: h.pageEvaluate, targetEvaluate: h.targetEvaluate,
    frameDirectory: path.join(h.directory, 'frames'), outputFile: path.join(h.directory, 'surface.gif'),
    encode: h.encoder, now: h.now, sleep: h.sleep
  });
  await assert.rejects(recorder.click('#modal-ok', 'left', { allowDialogContent: true }), /confirmation control/);
  await recorder.typeText('Sample name');
  assert.equal(input.value, 'Sample name');
  input.blur();
  await assert.rejects(recorder.typeText('unfocused'), /focused editable text field/);
  await assert.rejects(recorder.key('Enter'), /Unsupported or unsafe recording key/);
  const result = await recorder.finish();
  assert.equal(result.frames, 1);
  assert.ok(h.calls.some(call => call.method === 'Input.insertText' && call.params.text === 'Sample name'));
});

test('surface action labels appear beside clicks and keyboard chords', async t => {
  const h = harness(t), target = h.dom.window.document.querySelector('#target');
  target.getBoundingClientRect = () => ({ x: 100, y: 120, left: 100, top: 120, right: 180, bottom: 150, width: 80, height: 30 });
  const recorder = await createSurfaceRecorder({
    page: h.page, target: { id: 'host-page', type: 'page' }, pageEvaluate: h.pageEvaluate, targetEvaluate: h.targetEvaluate,
    frameDirectory: path.join(h.directory, 'frames'), outputFile: path.join(h.directory, 'labels.gif'),
    encode: h.encoder, now: h.now, sleep: h.sleep
  });
  await recorder.click('#target', 'right', { effect: 'Open tab' });
  const mouseLabel = h.dom.window.document.querySelector('.showcase-key');
  assert.equal(mouseLabel.textContent, 'Right click (Open tab)');
  await recorder.key('F2', 'Rename');
  assert.equal(h.dom.window.document.querySelector('#showcase-keys .showcase-key-effect')?.textContent, '(Rename)');
  await recorder.finish();
});

test('surface safety allows enabled tabs in dialogs and rejects disabled tabs and confirmations', () => {
  const dom = new JSDOM('<section role="dialog"><button role="tab" id="enabled">Enabled tab</button><button role="tab" aria-disabled="true" id="disabled">Disabled tab</button><button type="submit" id="confirm">Confirm</button></section>');
  try {
    assert.doesNotThrow(() => assertSafeSurfaceTarget(dom.window.document.querySelector('#enabled')));
    assert.throws(() => assertSafeSurfaceTarget(dom.window.document.querySelector('#disabled')), /confirmation control/);
    assert.throws(() => assertSafeSurfaceTarget(dom.window.document.querySelector('#confirm')), /confirmation control/);
  } finally { dom.window.close(); }
});

test('surface target safety survives evaluation in the captured page context', () => {
  const dom = new JSDOM('<section role="dialog"><button id="confirm" type="submit">Confirm</button><button id="tab" role="tab">Options</button></section>', { runScripts: 'outside-only' });
  try {
    const doc = dom.window.document, tab = doc.querySelector('#tab');
    tab.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 30 });
    const evaluate = dom.window.eval.bind(dom.window);
    const point = evaluate(`(${targetRect.toString()})('#tab', true, document)`);
    assert.equal(point.x, 50); assert.equal(point.y, 35);
    assert.throws(() => evaluate(`(${targetRect.toString()})('#confirm', true, document)`), /confirmation control/);
  } finally { dom.window.close(); }
});
