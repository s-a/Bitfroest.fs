const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');

function setup(t, language = 'de') {
  const pane = folder => ({ tabs: [folder], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  let now = 1000, sequence = 0;
  const timers = new Map();
  const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'a.txt', type: 'text' }, { id: 'b', name: 'b.txt', type: 'text' }], '/right': []
  } }, { language, beforeApp({ window }) {
    window.Date.now = () => now;
    window.setTimeout = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { fn, due: now + delay }); return id; };
    window.clearTimeout = id => timers.delete(id);
  } });
  app.tick = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
  };
  app.name = text => app.row(text).querySelector('[data-filename]');
  return app;
}

function drag(app, type, target, properties = {}) {
  const event = new app.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 80, ...properties });
  Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, getData() { return ''; } } });
  target.dispatchEvent(event);
  return event;
}

test('a preselected file needs two deliberate name clicks and a delayed edit', t => {
  const app = setup(t);
  app.click(app.name('a.txt')); app.tick(1000);
  assert.equal(app.document.querySelector('.inline-rename'), null);
  app.click(app.name('a.txt'));
  app.tick(799);
  assert.equal(app.document.querySelector('.inline-rename'), null);
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.state().active, 0);
  assert.equal(app.state().panes[0].cursor, 'a');
  assert.deepEqual(app.state().panes[0].selected, ['a']);
  app.tick(1);
  assert.equal(app.document.querySelector('.inline-rename').value, 'a.txt');
});

test('reducing a multiple selection does not schedule rename', t => {
  const app = setup(t);
  app.click(app.name('a.txt')); app.click(app.name('b.txt'), { ctrlKey: true }); app.tick(1000);
  app.click(app.name('b.txt')); app.tick(1000);
  assert.equal(app.document.querySelector('.inline-rename'), null);
});

for (const cancel of ['blur', 'focus', 'pointerdown', 'dblclick', 'key', 'selection', 'dragstart', 'tab']) {
  test(`pending name edit is cancelled by ${cancel}`, t => {
    const app = setup(t);
    app.click(app.name('a.txt')); app.tick(1000); app.click(app.name('a.txt'));
    if (cancel === 'focus') app.document.querySelector('[data-action="copy"]').focus();
    else if (cancel === 'key') app.key('ArrowDown');
    else if (cancel === 'selection') app.click(app.name('b.txt'));
    else if (cancel === 'dragstart') drag(app, 'dragstart', app.row('a.txt'));
    else if (cancel === 'tab') app.action('new-tab');
    else if (cancel === 'blur') app.window.dispatchEvent(new app.window.Event('blur'));
    else app.name('a.txt').dispatchEvent(new app.window.MouseEvent(cancel, { bubbles: true }));
    app.tick(1000);
    assert.equal(app.document.querySelector('.inline-rename'), null);
  });
}

test('a new click after leaving and returning to the tab only selects the file', t => {
  const app = setup(t);
  app.click(app.name('a.txt')); app.tick(1000); app.action('new-tab'); app.action('close-tab');
  app.click(app.name('a.txt')); app.tick(1000);
  assert.equal(app.document.querySelector('.inline-rename'), null);
});

test('explicit rename remains immediate', t => {
  const app = setup(t); app.action('rename-one');
  assert.equal(app.document.querySelector('.inline-rename').value, 'a.txt');
});

for (const language of ['de', 'en']) {
  test(`file dragging shows distinct copy and move symbols with ${language} labels`, t => {
    const app = setup(t, language), target = app.document.querySelector('[data-pane="1"] .list');
    drag(app, 'dragstart', app.row('a.txt'));
    for (const shiftKey of [false, true, false]) {
      const event = drag(app, 'dragover', target, { shiftKey });
      const feedback = app.document.querySelector('.file-drag-feedback');
      assert.ok(feedback);
      assert.equal(feedback.dataset.mode, shiftKey ? 'move' : 'copy');
      assert.match(feedback.getAttribute('aria-label'), language === 'de' ? shiftKey ? /Verschieben/ : /Kopieren/ : shiftKey ? /Move/ : /Copy/);
      const expected = app.document.createElement('div'); expected.innerHTML = app.window.CommanderIcons.svg('workbench', shiftKey ? 'move' : 'copy');
      assert.equal(feedback.querySelector('svg').dataset.iconReviewed, `workbench:${shiftKey ? 'move' : 'copy'}`);
      assert.equal(feedback.querySelector('svg').outerHTML, expected.innerHTML);
      assert.equal(event.dataTransfer.dropEffect, shiftKey ? 'move' : 'copy');
    }
    drag(app, 'dragover', target, { ctrlKey: true, shiftKey: true });
    assert.equal(app.document.querySelector('.file-drag-feedback'), null);
    drag(app, 'dragover', target); drag(app, 'dragend', target);
    assert.equal(app.document.querySelector('.file-drag-feedback'), null);
    assert.equal(app.document.querySelector('.drop-target'), null);
  });
}

test('drag feedback cannot cover a drop target and uses readable theme colors and icons', t => {
  const app = setup(t), target = app.document.querySelector('[data-pane="1"] .list');
  drag(app, 'dragstart', app.row('a.txt')); drag(app, 'dragover', target);
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
  app.document.head.append(style);
  const feedback = app.document.querySelector('.file-drag-feedback'); assert.ok(feedback);
  assert.equal(app.window.getComputedStyle(feedback).pointerEvents, 'none');
  const styleFeedback = app.window.getComputedStyle(feedback);
  assert.equal(styleFeedback.fontSize, app.window.getComputedStyle(app.row('a.txt')).fontSize);
  assert.equal(styleFeedback.fontWeight, '400');
  assert.equal(styleFeedback.padding, '0px');
  assert.equal(styleFeedback.borderTopWidth, '0px');
  assert.equal(styleFeedback.backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(styleFeedback.boxShadow, 'none');
  assert.equal(app.window.getComputedStyle(feedback.querySelector('svg')).width, '16px');
  drag(app, 'dragover', app.row('a.txt'));
  assert.equal(app.document.querySelector('.file-drag-feedback').dataset.allowed, 'false');
  assert.equal(app.document.querySelector('.file-drag-feedback').dataset.mode, 'copy');
});

test('native drag image contains all marked names and the total selection count', t => {
  const app = setup(t); app.click(app.name('b.txt'), { ctrlKey: true });
  const event = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
  let preview;
  const values = new Map();
  Object.defineProperty(event, 'dataTransfer', { value: {
    setData: (key, value) => values.set(key, value),
    setDragImage: element => { preview = element; }
  } });
  app.row('b.txt').dispatchEvent(event);
  assert.ok(preview);
  assert.equal(preview.dataset.count, '2');
  assert.deepEqual([...preview.querySelectorAll('.file-drag-row')].map(row => row.getAttribute('aria-label')), ['a.txt', 'b.txt']);
  assert.deepEqual(JSON.parse(values.get('application/x-bitfroest-files')).ids, ['a', 'b']);
  drag(app, 'dragend', app.row('b.txt'));
  assert.equal(preview.isConnected, false);
});

test('drag preview preserves the rendered rows and icons with a transparent presentation', t => {
  const app = setup(t); app.click(app.name('b.txt'), { ctrlKey: true });
  const rows = [app.row('a.txt'), app.row('b.txt')];
  const image = app.document.createElement('img'); image.className = 'native-icon'; image.src = 'data:image/png;base64,aGVsbG8=';
  rows[0].querySelector('.fileicon').append(image);
  drag(app, 'dragstart', rows[1]);
  drag(app, 'dragover', app.document.querySelector('[data-pane="1"] .list'));
  const preview = app.document.querySelector('.file-drag-feedback .file-drag-preview');
  const ghosts = [...preview.querySelectorAll('.file-drag-row')];
  assert.equal(ghosts.length, 2);
  for (const [index, ghost] of ghosts.entries()) {
    assert.equal(ghost.querySelectorAll('[data-cell]').length, rows[index].querySelectorAll('[data-cell]').length);
    assert.equal(ghost.querySelector('.filename-text').textContent, rows[index].querySelector('.filename-text').textContent);
    assert.equal(ghost.hasAttribute('data-file-row'), false);
    assert.equal(ghost.querySelector('[id],[tabindex],[draggable="true"]'), null);
    assert.equal(ghost.hasAttribute('inert'), true);
  }
  assert.equal(ghosts[0].querySelector('.native-icon').src, image.src);
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
  app.document.head.append(style);
  assert.equal(app.window.getComputedStyle(preview).opacity, '0.6');
  assert.equal(app.window.getComputedStyle(preview).borderTopWidth, '0px');
  assert.equal(app.window.getComputedStyle(preview).pointerEvents, 'none');
});

test('drag preview renders virtualized selected rows with the same columns without changing the list', t => {
  const app = setup(t); app.click(app.name('b.txt'), { ctrlKey: true });
  const original = app.row('a.txt'), cellCount = original.querySelectorAll('[data-cell]').length;
  original.remove();
  drag(app, 'dragstart', app.row('b.txt'));
  drag(app, 'dragover', app.document.querySelector('[data-pane="1"] .list'));
  const ghost = app.document.querySelector('.file-drag-feedback .file-drag-row');
  assert.equal(ghost.getAttribute('aria-label'), 'a.txt');
  assert.equal(ghost.querySelectorAll('[data-cell]').length, cellCount);
  assert.ok(ghost.querySelector('.fileicon,.git-icon'));
  const style = app.document.createElement('style');
  style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
  app.document.head.append(style);
  assert.equal(app.window.getComputedStyle(ghost).position, 'relative');
  assert.equal(ghost.style.height, `${app.window.CommanderIcons.layout().row}px`);
  assert.deepEqual(app.state().panes[0].selected, ['a', 'b']);
  assert.equal(original.isConnected, false);
});

test('drag preview retains source panel spacing and search colors outside the panel', t => {
  const app = setup(t), section = app.document.querySelector('[data-pane="0"]');
  section.style.setProperty('--file-cell-padding', '9px');
  section.querySelector('.file-table').style.setProperty('--file-marker-width', '12px');
  section.querySelector('.file-table').style.setProperty('--file-marker-gap', '3px');
  app.document.querySelector('#panes').style.setProperty('--match-background', 'rgb(200, 100, 0)');
  drag(app, 'dragstart', app.row('a.txt'));
  drag(app, 'dragover', app.document.querySelector('[data-pane="1"] .list'));
  const preview = app.document.querySelector('.file-drag-feedback .file-drag-preview');
  for (const [key, value] of Object.entries({ '--file-cell-padding': '9px', '--file-marker-width': '12px', '--file-marker-gap': '3px', '--match-background': 'rgb(200, 100, 0)' })) assert.equal(preview.style.getPropertyValue(key), value);
});

for (const shiftKey of [false, true]) test(`native drag retains selection feedback over invalid and valid targets with shift=${shiftKey}`, t => {
  const app = setup(t); app.click(app.name('b.txt'), { ctrlKey: true });
  drag(app, 'dragstart', app.row('b.txt'));
  for (const side of [0, 1, 0]) {
    const event = drag(app, 'dragover', app.document.querySelector(`[data-pane="${side}"] .list`), { shiftKey });
    const feedback = app.document.querySelector('.file-drag-feedback');
    assert.equal(feedback.dataset.count, '2');
    assert.equal(feedback.dataset.mode, shiftKey ? 'move' : 'copy');
    assert.equal(feedback.dataset.allowed, String(side === 1));
    assert.deepEqual([...feedback.querySelectorAll('.file-drag-row')].map(row => row.getAttribute('aria-label')), ['a.txt', 'b.txt']);
    assert.equal(event.dataTransfer.dropEffect, side ? shiftKey ? 'move' : 'copy' : 'none');
  }
  drag(app, 'dragend', app.row('b.txt'));
  assert.equal(app.document.body.dataset.fileDragCursor, undefined);
});
