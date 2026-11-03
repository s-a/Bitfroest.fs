const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');

function setup(t, count = 3) {
  let now = 0, sequence = 0;
  const timers = new Map(), ids = Array.from({ length: count }, (_, index) => `f${index}`);
  const pane = folder => ({ tabs: [folder], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const saved = { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': ids.map(id => ({ id, name: `${id}.txt`, type: 'text' })), '/right': []
  } };
  saved.panes[0].selected = ids.slice(0, -1); saved.panes[0].cursor = ids[0];
  const app = createApp(t, saved, { beforeApp({ window }) {
    window.setTimeout = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { fn, due: now + delay }); return id; };
    window.clearTimeout = id => timers.delete(id);
  } });
  app.tick = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.fn(); };
  app.rows = [...app.document.querySelectorAll('[data-pane="0"] [data-file-row][data-id]')];
  app.rows.forEach((row, index) => { row.style.height = '20px'; row.getBoundingClientRect = () => ({ left: 100, top: 200 + index * 20, right: 700, bottom: 220 + index * 20, width: 600, height: 20 }); });
  return app;
}
function pointer(app, type, target, extra = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 130, clientY: 230, ...extra })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
}
function native(app, type, target, extra = {}) {
  const event = new app.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 130, clientY: 230, ...extra });
  Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, setDragImage() {}, getData() { return ''; } } });
  target.dispatchEvent(event); return event;
}

test('right hold paints every marked filename and clears all cues together', t => {
  const app = setup(t);
  pointer(app, 'pointerdown', app.rows[1], { button: 2, buttons: 2 });
  assert.equal(app.rows[0].querySelector('[data-filename]').classList.contains('drag-pending'), true);
  assert.equal(app.rows[1].querySelector('[data-filename]').classList.contains('drag-pending'), true);
  assert.equal(app.rows[2].querySelector('[data-filename]').classList.contains('drag-pending'), false);
  app.tick(399); assert.equal(app.document.querySelectorAll('.drag-pending').length, 2);
  app.tick(1); assert.equal(app.document.querySelectorAll('.drag-pending').length, 0);
  assert.equal(app.document.body.dataset.fileDragCursor, 'ready');
  pointer(app, 'pointerup', app.rows[1], { button: 2 });
  pointer(app, 'pointerdown', app.rows[2], { button: 2, buttons: 2 });
  assert.equal(app.document.querySelectorAll('.drag-pending').length, 1);
  pointer(app, 'pointercancel', app.rows[2], { button: 2 });
  assert.equal(app.document.querySelectorAll('.drag-pending').length, 0);
});

test('preview lifts at the grabbed row and tracks leftward movement without viewport pinning', t => {
  const app = setup(t), row = app.rows[1];
  pointer(app, 'pointerdown', row);
  pointer(app, 'pointermove', row, { clientX: 140, clientY: 240 });
  const feedback = app.document.querySelector('.file-drag-feedback'), preview = feedback.querySelector('.file-drag-preview');
  assert.equal(feedback.style.left, '110px'); assert.equal(feedback.style.top, '210px');
  assert.equal(feedback.children.length, 1); assert.equal(feedback.firstElementChild, preview);
  feedback.getBoundingClientRect = () => ({ width: 600, height: 40 });
  Object.defineProperty(app.window, 'innerWidth', { value: 300 });
  pointer(app, 'pointermove', row, { clientX: 5, clientY: 190, shiftKey: true });
  assert.equal(feedback.style.left, '-25px'); assert.equal(feedback.style.top, '160px');
  assert.equal(feedback.querySelector('.file-drag-preview'), preview);
  assert.equal(feedback.dataset.mode, 'move');
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8')); app.document.head.append(style);
  assert.equal(app.window.getComputedStyle(feedback).transitionDuration, '0s');
  assert.equal(app.window.getComputedStyle(feedback).width, 'max-content');
  assert.match(style.textContent, /\.file-drag-row[^}]*mask-image:\s*linear-gradient\(to right,\s*transparent/);
});

test('the grabbed marked row stays in a five-row preview even beyond the first five entries', t => {
  const app = setup(t, 9), row = app.rows.find(row => row.dataset.id === 'f6');
  pointer(app, 'pointerdown', row, { clientY: 330 });
  pointer(app, 'pointermove', row, { clientX: 140, clientY: 340 });
  const feedback = app.document.querySelector('.file-drag-feedback');
  const ghosts = [...feedback.querySelectorAll('.file-drag-row')];
  assert.equal(ghosts.length, 5); assert.ok(ghosts.some(row => row.getAttribute('aria-label') === 'f6.txt'));
  assert.equal(feedback.style.left, '110px'); assert.equal(feedback.style.top, '250px');
  assert.equal(feedback.dataset.count, '8');
});

test('a late native drag after pointer cancellation cannot create a second preview', t => {
  const app = setup(t), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.rows[1]); pointer(app, 'pointercancel', app.rows[1]);
  assert.equal(native(app, 'dragstart', app.rows[1]).defaultPrevented, true);
  native(app, 'dragover', target);
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 0);
});

test('switching from a native drag to a right hold discards the old drag payload', t => {
  const app = setup(t), target = app.document.querySelector('[data-pane="1"] .list');
  native(app, 'dragstart', app.rows[0]);
  pointer(app, 'pointerdown', app.rows[1], { button: 2, buttons: 2 }); app.tick(500);
  pointer(app, 'pointermove', target, { button: 2, buttons: 2, clientX: 800 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 1);
  native(app, 'drop', target);
  assert.equal(app.document.querySelector('#modal').open, false);
  pointer(app, 'pointerup', target, { button: 2, clientX: 800 });
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('a fast left-to-right pointer restart leaves one preview and ignores the old button release', t => {
  const app = setup(t), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.rows[1]); pointer(app, 'pointermove', target, { clientX: 800 });
  pointer(app, 'pointerdown', app.rows[1], { button: 2, buttons: 2 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 0);
  app.tick(400); pointer(app, 'pointermove', target, { button: 2, buttons: 2, clientX: 810 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 1);
  pointer(app, 'pointerup', target, { button: 0, buttons: 2, clientX: 810 });
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 1);
  pointer(app, 'pointerup', target, { button: 2, buttons: 0, clientX: 810 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 0);
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('pressing the second mouse button during a left drag cancels the chord without a transfer', t => {
  const app = setup(t), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.rows[1]); pointer(app, 'pointermove', target, { clientX: 800 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 1);
  pointer(app, 'pointermove', target, { button: 2, buttons: 3, clientX: 810 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 0);
  app.tick(1000);
  assert.equal(native(app, 'dragstart', app.rows[1]).defaultPrevented, true);
  pointer(app, 'pointerup', target, { button: 2, buttons: 0, clientX: 810 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview').length, 0);
  assert.equal(app.document.querySelectorAll('.drag-pending').length, 0);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('unsupported link modifiers retain the same preview and restore copy without flicker', t => {
  const app = setup(t), row = app.rows[1];
  pointer(app, 'pointerdown', row); pointer(app, 'pointermove', row, { clientX: 140 });
  const feedback = app.document.querySelector('.file-drag-feedback'), preview = feedback.firstElementChild;
  pointer(app, 'pointermove', row, { clientX: 145, ctrlKey: true, shiftKey: true });
  assert.equal(app.document.querySelector('.file-drag-feedback'), feedback);
  assert.equal(feedback.firstElementChild, preview); assert.equal(feedback.dataset.allowed, 'false');
  pointer(app, 'pointermove', row, { clientX: 150 });
  assert.equal(feedback.firstElementChild, preview); assert.equal(feedback.dataset.mode, 'copy');
});

for (const ready of [false, true]) test(`right hold followed by a button chord cannot arm later or transfer with ready=${ready}`, t => {
  const app = setup(t), target = app.document.querySelector('[data-pane="1"] .list');
  pointer(app, 'pointerdown', app.rows[1], { button: 2, buttons: 2 });
  app.tick(ready ? 400 : 200);
  pointer(app, 'pointermove', target, { button: 0, buttons: 3, clientX: 800 });
  app.tick(1000);
  pointer(app, 'pointermove', target, { button: 2, buttons: 1, clientX: 810 });
  pointer(app, 'pointerup', target, { button: 0, buttons: 0, clientX: 810 });
  assert.equal(app.document.querySelectorAll('.file-drag-preview,.drag-pending').length, 0);
  assert.equal(app.document.body.dataset.fileDragCursor, undefined);
  assert.equal(app.document.querySelector('#modal').open, false);
});

for (const count of [3, 8]) for (const route of ['pointer', 'native']) test(`selection count is below the faded rows for ${route} dragging with ${count - 1} marked files`, t => {
  const app = setup(t, count), target = app.document.querySelector('[data-pane="1"] .list');
  if (route === 'pointer') {
    pointer(app, 'pointerdown', app.rows[1]); pointer(app, 'pointermove', target, { clientX: 800 });
  } else {
    native(app, 'dragstart', app.rows[1]); native(app, 'dragover', target);
  }
  const preview = app.document.querySelector('.file-drag-feedback .file-drag-preview');
  const badge = preview.querySelector('.file-drag-count'), rows = [...preview.querySelectorAll('.file-drag-row')];
  assert.equal(badge.textContent, String(count - 1));
  assert.equal(preview.lastElementChild, badge, 'the count follows all rows and remaining-item information');
  assert.equal(rows.length, Math.min(5, count - 1));
  assert.equal(badge.previousElementSibling, preview.querySelector('.file-drag-more') || rows.at(-1));
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8')); app.document.head.append(style);
  assert.equal(app.window.getComputedStyle(badge).position, 'static');
  assert.equal(app.window.getComputedStyle(badge).display, 'block');
  assert.doesNotMatch(app.window.getComputedStyle(preview).maskImage, /gradient/);
  assert.doesNotMatch(app.window.getComputedStyle(badge).maskImage, /gradient/);
  assert.match(app.window.getComputedStyle(rows[0]).maskImage, /linear-gradient\(to right, transparent/);
  if (route === 'pointer') pointer(app, 'pointerup', target, { clientX: 800 });
  else native(app, 'dragend', target);
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
});

test('drag rings follow the unchanged system pointer without a second arrow or a shifting preview', t => {
  const app = setup(t), row = app.rows[1], target = app.document.querySelector('[data-pane="1"] .list');
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8')); app.document.head.append(style);
  pointer(app, 'pointerdown', row, { button: 2, buttons: 2 });
  pointer(app, 'pointermove', row, { button: 2, buttons: 2, clientX: 132, clientY: 231 });
  app.tick(399); assert.equal(app.document.body.dataset.fileDragCursor, undefined);
  app.tick(1);
  assert.equal(app.window.getComputedStyle(row).cursor, 'default');
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '128px');
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-y'), '227px');
  assert.equal(app.document.querySelector('.file-drag-feedback'), null);
  pointer(app, 'pointermove', row, { button: 2, buttons: 2, clientX: 133, clientY: 231 });
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '129px');
  pointer(app, 'pointermove', target, { button: 2, buttons: 2, clientX: 800 });
  assert.equal(app.window.getComputedStyle(row).cursor, 'default');
  const preview = app.document.querySelector('.file-drag-feedback .file-drag-preview');
  assert.equal(app.document.querySelector('.file-drag-feedback').children.length, 1);
  app.key('Escape'); pointer(app, 'pointerup', target, { button: 2, clientX: 800 });
  assert.equal(app.document.body.dataset.fileDragCursor, undefined); assert.equal(preview.isConnected, false);
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '');
  pointer(app, 'pointerdown', row); pointer(app, 'pointermove', target, { clientX: 810 });
  const feedback = app.document.querySelector('.file-drag-feedback'), ghost = feedback.firstElementChild;
  const left = feedback.style.left, top = feedback.style.top;
  pointer(app, 'pointermove', target, { clientX: 810, shiftKey: true });
  assert.equal(app.window.getComputedStyle(row).cursor, 'default');
  assert.equal(feedback.firstElementChild, ghost); assert.equal(feedback.style.left, left); assert.equal(feedback.style.top, top);
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '806px');
  pointer(app, 'pointermove', row, { clientX: 140 });
  assert.equal(app.window.getComputedStyle(row).cursor, 'no-drop');
  pointer(app, 'pointercancel', row);
  assert.equal(app.document.body.dataset.fileDragCursor, undefined);
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '');
  const ring = [...style.sheet.cssRules].find(rule => rule.selectorText?.includes('body[data-file-drag-cursor]::after'));
  assert.ok(ring); assert.match(ring.style.backgroundImage || ring.style.getPropertyValue('background-image'), /drag-click-rings\.svg/);
  assert.equal(ring.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(ring.style.width, '48px'); assert.equal(ring.style.height, '48px');
});

test('the bundled rings retain their geometry without the embedded arrow and have contrast and offline credits', () => {
  const { JSDOM } = require('jsdom');
  const resource = path.join(__dirname, '../media/icons/drag-click-rings.svg'); assert.ok(fs.existsSync(resource));
  const dom = new JSDOM(fs.readFileSync(resource, 'utf8'), { contentType: 'image/svg+xml' });
  try {
    const svg = dom.window.document.documentElement, glyph = svg.querySelector('path'), geometry = glyph.getAttribute('d');
    assert.equal(svg.getAttribute('width'), '48'); assert.equal(svg.getAttribute('height'), '48');
    assert.equal(svg.getAttribute('viewBox'), '0 -960 960 960');
    assert.match(geometry, /^M480-240/); assert.match(geometry, /M324-111\.5/);
    assert.doesNotMatch(geometry, /M421-460|L80-880/);
    assert.equal(glyph.getAttribute('fill'), '#fff'); assert.equal(glyph.getAttribute('stroke'), '#000');
    assert.equal(glyph.getAttribute('paint-order'), 'stroke'); assert.equal(glyph.getAttribute('stroke-width'), '32');
    assert.equal(svg.querySelector('script,image,use,foreignObject'), null);
  } finally { dom.window.close(); }
  const components = JSON.parse(fs.readFileSync(path.join(__dirname, '../licenses/components.json'), 'utf8'));
  const credits = components.find(component => component.name === 'Material Symbols'); assert.ok(credits);
  assert.equal(credits.license, 'Apache-2.0'); assert.ok(credits.files.includes('LICENSE'));
});

for (const end of ['pointerup', 'pointercancel', 'blur', 'pagehide', 'escape', 'chord', 'navigation', 'dialog']) test(`ready drag rings are cleared on ${end}`, t => {
  const app = setup(t), row = app.rows[1];
  pointer(app, 'pointerdown', row, { button: 2, buttons: 2 }); app.tick(400);
  assert.equal(app.document.body.dataset.fileDragCursor, 'ready');
  assert.notEqual(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '');
  if (end === 'blur' || end === 'pagehide') app.window.dispatchEvent(new app.window.Event(end));
  else if (end === 'escape') app.key('Escape');
  else if (end === 'navigation') app.action('new-tab');
  else if (end === 'dialog') app.action('mkdir');
  else if (end === 'chord') pointer(app, 'pointermove', row, { button: 0, buttons: 3 });
  else pointer(app, end, row, { button: 2 });
  assert.equal(app.document.body.dataset.fileDragCursor, undefined);
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-x'), '');
  assert.equal(app.document.body.style.getPropertyValue('--file-drag-cursor-y'), '');
});
