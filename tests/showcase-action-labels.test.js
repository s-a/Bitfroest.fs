const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { installPointer } = require('../scripts/showcases/gestures.cjs');
const { installPresentation, presentationTiming } = require('../scripts/showcases/presentation.cjs');
const { executeSequence } = require('../scripts/showcases/sequence.cjs');

function presentation() {
  const dom = new JSDOM('<html><head></head><body><div class="monaco-workbench"></div></body></html>', { runScripts: 'outside-only' });
  dom.window.eval(`(${installPointer.toString()})()`);
  dom.window.eval(`(${installPresentation.toString()})(${JSON.stringify(presentationTiming)})`);
  return { dom, doc: dom.window.document, ui: dom.window.__showcasePresentation };
}

test('mouse and keyboard labels name the product action and appear only after input', () => {
  const h = presentation();
  try {
    const pointerLabel = h.doc.querySelector('.showcase-key'), panel = h.doc.querySelector('#showcase-keys');
    h.ui.pointer('mouseMoved', { x: 200, y: 200 }, 'none', 'Select file');
    assert.equal(pointerLabel.hidden, true);
    h.ui.pointer('mousePressed', { x: 200, y: 200 }, 'left', 'Select file');
    assert.equal(pointerLabel.textContent, 'Left click (Select file)');
    h.ui.key('keyDown', 'Escape', 'Clear current selection');
    assert.equal(panel.dataset.effect, 'Clear current selection');
    assert.equal(panel.querySelector('.showcase-key-effect').textContent, '(Clear current selection)');
    h.ui.key('keyUp', 'Escape');
    assert.equal(panel.querySelector('kbd').dataset.state, 'released');
  } finally { h.dom.window.close(); }
});

test('recording steps pass their action captions to the mouse and keyboard overlays', async () => {
  const seen = [];
  await executeSequence([
    { type: 'click', effect: 'Open menu' },
    { type: 'key', key: 'Escape', effect: 'Close menu' }
  ], { mouse: async (...args) => seen.push(['mouse', ...args]), key: async (...args) => seen.push(['key', ...args]) });
  assert.deepEqual(seen, [['mouse', 'press', 'left', 'Open menu'], ['mouse', 'release', 'left', 'Open menu'], ['key', 'Escape', 'Close menu']]);
});
