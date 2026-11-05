const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { installPointer } = require('../scripts/showcases/gestures.cjs');
const { installPresentation, createPacing, presentationTiming } = require('../scripts/showcases/presentation.cjs');

function harness() {
  const dom = new JSDOM('<html><head></head><body><div class="monaco-workbench"></div></body></html>', { runScripts: 'outside-only' });
  let clock = 0, next = 0;
  const timers = new Map();
  dom.window.setTimeout = (fn, ms) => { timers.set(++next, { fn, at: clock + ms }); return next; };
  dom.window.clearTimeout = id => timers.delete(id);
  dom.window.eval(`(${installPointer.toString()})()`);
  dom.window.eval(`(${installPresentation.toString()})(${JSON.stringify(presentationTiming)})`);
  return { dom, doc: dom.window.document, ui: dom.window.__showcasePresentation,
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      clock = until;
    }, timers };
}

test('click hints expire without losing the held-button marker and movement never restarts them', () => {
  const h = harness();
  try {
    const label = h.doc.querySelector('.showcase-key'), pointer = h.doc.querySelector('#showcase-pointer');
    h.ui.pointer('mouseMoved', { x: 100, y: 200 }, 'none');
    assert.equal(label.hidden, true);
    h.ui.pointer('mousePressed', { x: 100, y: 200 }, 'right');
    assert.equal(label.textContent, 'Right click');
    assert.equal(pointer.dataset.down, 'true');
    h.advance(presentationTiming.hint);
    assert.equal(label.style.opacity, '0');
    h.ui.pointer('mouseMoved', { x: 200, y: 250 }, 'right');
    h.advance(presentationTiming.fade);
    assert.equal(label.hidden, true);
    assert.equal(pointer.dataset.down, 'true');
    h.ui.pointer('mouseReleased', { x: 200, y: 250 }, 'right');
    assert.equal(pointer.dataset.down, 'false');
    assert.equal(label.hidden, true);
  } finally { h.dom.window.close(); }
});

test('keyboard chords distinguish releases, expire only after release and survive a previous fade timer', () => {
  const h = harness();
  try {
    const panel = h.doc.querySelector('#showcase-keys');
    h.ui.key('keyDown', 'Control'); h.ui.key('keyDown', 'l');
    assert.deepEqual([...panel.querySelectorAll('kbd')].map(e => e.textContent), ['Ctrl', 'L']);
    h.advance(5000);
    assert.equal(panel.style.opacity, '1');
    h.ui.key('keyUp', 'l');
    assert.equal(panel.querySelectorAll('kbd[data-pressed="true"]').length, 1);
    h.ui.key('keyUp', 'Control');
    h.advance(presentationTiming.hint);
    assert.equal(panel.style.opacity, '0');
    h.ui.key('keyDown', 'F2');
    h.advance(presentationTiming.fade);
    assert.notEqual(panel.style.display, 'none');
    assert.equal(panel.textContent, 'F2');
    h.ui.key('keyUp', 'F2'); h.advance(presentationTiming.hint + presentationTiming.fade);
    assert.equal(panel.style.display, 'none');
  } finally { h.dom.window.close(); }
});

test('both overlays stay inside the viewport and avoid a focused product input', () => {
  const h = harness();
  try {
    const label = h.doc.querySelector('.showcase-key'), panel = h.doc.querySelector('#showcase-keys');
    label.getBoundingClientRect = () => ({ width: 100, height: 30 });
    panel.getBoundingClientRect = () => ({ width: 160, height: 55 });
    h.ui.protect([{ left: 820, top: 650, right: 1024, bottom: 768 }]);
    h.ui.pointer('mousePressed', { x: 1005, y: 735 }, 'left'); h.ui.key('keyDown', 'F2');
    for (const [element, width, height] of [[label, 100, 30], [panel, 160, 55]]) {
      const x = parseFloat(element.style.left) + (element === label ? 1005 : 0);
      const y = parseFloat(element.style.top) + (element === label ? 735 : 0);
      assert.ok(x >= 12 && y >= 12 && x + width <= 1012 && y + height <= 756);
      assert.ok(x + width <= 820 || y + height <= 650);
    }
    h.ui.dispose();
    assert.equal(h.timers.size, 0);
    assert.equal(h.doc.querySelector('.showcase-held'), null);
  } finally { h.dom.window.close(); }
});

test('reading time follows verified states, counts existing pauses and uses shared loop pauses', async () => {
  let time = 0;
  const waits = [];
  const pacing = createPacing({ now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  await pacing.begin(); assert.equal(time, presentationTiming.opening);
  pacing.verified(); time += 350;
  await pacing.beforeInput(); assert.equal(waits.at(-1), presentationTiming.reading - 350);
  pacing.verified(); time += presentationTiming.reading + 100;
  const count = waits.length;
  await pacing.beforeInput(); assert.equal(waits.length, count);
  await pacing.end(); assert.equal(waits.at(-1), presentationTiming.ending);
});
