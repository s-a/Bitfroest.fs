const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture(t, count = 0) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const rows = [
    { id: '1', name: 'Terror.txt', type: 'text', size: 12 },
    { id: '2', name: 'Another Terror.txt', type: 'text', size: 24 },
    { id: '3', name: 'River.txt', type: 'text', size: 36 },
    ...Array.from({ length: count }, (_, i) => ({ id: `extra-${i}`, name: `document-${i}.txt`, type: 'text', size: i }))
  ];
  return createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': rows, '/right': [{ id: 'other', name: 'Other.txt', type: 'text', size: 1 }] } });
}

function timedKey(app, key, timeStamp) {
  const event = new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  app.document.activeElement.dispatchEvent(event);
}

test('directory navigation and history discard old searches, filters and marked entries', t => {
  const saved = fixture(t).state();
  saved.folders['/left/child'] = [{ id: 'child', name: 'Child report.txt', type: 'text', size: 1 }];
  const app = createApp(t, saved);
  app.click(app.row('River.txt')); app.key(' ');
  for (const key of 'Terror') app.key(key);
  app.key('b', { ctrlKey: true }); app.key('f', { ctrlKey: true, shiftKey: true });
  const input = app.document.querySelector('.pane.active .path-input');
  input.focus(); input.value = '/left/child'; app.key('Enter', {}, input);
  const reset = () => {
    const pane = app.state().panes[0];
    assert.equal(pane.filter, ''); assert.equal(pane.searchFilter, false);
    assert.deepEqual(pane.selected, []); assert.deepEqual(pane.spaceMarked, []);
    assert.equal(app.document.querySelector('.pane.active mark'), null);
  };
  reset();
  for (const key of 'Child') app.key(key);
  app.key('b', { ctrlKey: true }); app.key('f', { ctrlKey: true, shiftKey: true });
  app.action('back'); reset();
  assert.equal(app.document.querySelectorAll('.pane.active [data-file-row][data-id]').length, 3);
  app.action('forward'); reset();
  assert.ok(app.row('Child report.txt'));
});

test('a new input sequence after inactivity replaces the old search using input timestamps', t => {
  const app = fixture(t);
  let time = 100;
  for (const key of 'Terror') timedKey(app, key, time += 50);
  for (const key of 'River') timedKey(app, key, time += key === 'R' ? 3000 : 50);
  assert.equal(app.state().panes[0].filter, 'River');
  assert.equal(app.row('River.txt').querySelector('mark').textContent, 'River');
  assert.equal(app.row('Terror.txt').querySelector('mark'), null);
  timedKey(app, 'z', time += 3000);
  assert.equal(app.state().panes[0].filter, 'z');
  timedKey(app, 'T', time + 3000);
  assert.equal(app.state().panes[0].filter, 'T');
});

test('spaces in a running query are searchable and Escape restores space marking and another search', t => {
  const app = fixture(t);
  for (const key of 'Another Terror') app.key(key);
  assert.equal(app.state().panes[0].filter, 'Another Terror');
  assert.equal(app.row('Another Terror.txt').querySelector('mark').textContent, 'Another Terror');
  assert.deepEqual(app.state().panes[0].selected, []);
  app.key('Escape'); app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, ['2']);
  for (const key of 'River') app.key(key);
  assert.equal(app.state().panes[0].filter, 'River');
});

test('sorting through headers or commands retains the search and reveals the current hit', async t => {
  const app = fixture(t);
  const scrolled = [];
  app.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.dataset.id); };
  for (const key of 'Terror') app.key(key);
  const cursor = app.state().panes[0].cursor;
  const row = app.document.querySelector(`.pane.active [data-file-row][data-id="${cursor}"]`);
  for (const sort of ['name', 'size', 'type', 'date', 'name']) {
    scrolled.length = 0;
    app.click(app.document.querySelector(`.pane.active [data-sort="${sort}"]`));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(app.grid().getRenderedNodes().some(node => node.id === cursor));
    assert.equal(app.state().panes[0].filter, 'Terror');
    assert.equal(app.document.querySelector(`.pane.active [data-file-row][data-id="${cursor}"]`), row);
    assert.equal(row.querySelector('[data-filename] mark').textContent, 'Terror');
  }
  scrolled.length = 0; app.action('sort:size');
  assert.equal(scrolled.at(-1), cursor);
});

test('Ctrl Shift F shows only matching names, updates the filtered list and restores all entries on Escape', t => {
  const app = fixture(t);
  const shown = () => [...app.document.querySelectorAll('.pane.active [data-file-row][data-id]')].map(row => row.dataset.id).sort();
  for (const key of 'Terror') app.key(key);
  app.key('f', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(shown(), ['1', '2']);
  assert.equal(app.state().panes[0].searchFilter, true);
  assert.match(app.document.querySelector('.pane.active [data-search-filter]').textContent, /2/);
  assert.deepEqual(app.state().panes[0].selected, []);
  app.key('b', { ctrlKey: true });
  assert.deepEqual([...app.state().panes[0].selected].sort(), ['1', '2']);
  app.action('sort:size'); assert.deepEqual(shown(), ['1', '2']);
  app.key('z'); assert.deepEqual(shown(), []);
  app.key('Backspace'); assert.deepEqual(shown(), ['1', '2']);
  app.key('f', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(shown(), ['1', '2']);
  app.action('new-tab'); assert.deepEqual(shown(), ['1', '2']);
  app.key('Escape'); assert.deepEqual(shown(), ['1', '2', '3']);
  app.click(app.document.querySelector('.pane.active [data-tab="0"]'));
  assert.deepEqual(shown(), ['1', '2']);
  app.key('Tab'); assert.deepEqual(shown(), ['other']);
  app.key('Tab'); assert.deepEqual(shown(), ['1', '2']);
  app.key('Escape');
  assert.deepEqual(shown(), ['1', '2', '3']);
  assert.equal(app.document.querySelector('.pane.active [data-search-filter]'), null);
  assert.equal(app.document.querySelector('.pane.active mark'), null);
  assert.deepEqual([...app.state().panes[0].selected].sort(), ['1', '2']);
});

test('the active filter accepts a new search after inactivity and preserves literal spaces', t => {
  const app = fixture(t);
  let time = 100;
  for (const key of 'Terror') timedKey(app, key, time += 40);
  app.key('f', { ctrlKey: true, shiftKey: true });
  time += 3000;
  for (const key of 'Another Terror') timedKey(app, key, time += 40);
  assert.equal(app.state().panes[0].filter, 'Another Terror');
  assert.equal(app.document.querySelectorAll('.pane.active [data-file-row][data-id]').length, 1);
  assert.equal(app.row('Another Terror.txt').querySelector('mark').textContent, 'Another Terror');
  assert.deepEqual(app.state().panes[0].selected, []);
});

test('Ctrl F starts a replacement query immediately and an empty armed filter is cleared by Escape', t => {
  const app = fixture(t);
  app.key('f', { ctrlKey: true, shiftKey: true });
  assert.equal(app.state().panes[0].searchFilter, true);
  app.key('Escape');
  assert.equal(app.state().panes[0].searchFilter, false);
  for (const key of 'Terror') app.key(key);
  app.key('f', { ctrlKey: true });
  for (const key of 'River') app.key(key);
  assert.equal(app.state().panes[0].filter, 'River');
  assert.equal(app.row('River.txt').querySelector('mark').textContent, 'River');
});

test('Ctrl F retains the query and Ctrl B marks its matches while Ctrl A still marks the whole list', t => {
  const app = fixture(t);
  app.key('f', { ctrlKey: true });
  for (const key of 'Terror') app.key(key);
  app.key('f', { ctrlKey: true });
  assert.equal(app.state().panes[0].filter, 'Terror');
  assert.deepEqual(app.state().panes[0].selected, []);
  app.key('b', { ctrlKey: true });
  assert.deepEqual([...app.state().panes[0].selected].sort(), ['1', '2']);
  app.key('b', { ctrlKey: true });
  assert.equal(app.state().panes[0].selected.length, 2);
  assert.equal(app.row('Terror.txt').getAttribute('aria-selected'), 'true');
  assert.equal(app.row('River.txt').getAttribute('aria-selected'), 'false');
  assert.deepEqual(app.state().panes[1].selected, []);
  app.key('a', { ctrlKey: true });
  assert.deepEqual([...app.state().panes[0].selected].sort(), ['1', '2', '3']);
  app.key('Escape');
  assert.equal(app.document.querySelector('.pane.active mark'), null);
  assert.equal(app.state().panes[0].selected.length, 3);
});

test('marking search matches includes folders, retains prior marks and ignores empty or missing queries and text inputs', t => {
  const saved = fixture(t).state();
  saved.folders['/left'].push({ id: 'folder', name: 'Terror folder', type: 'folder', size: 0 });
  const app = createApp(t, saved);
  app.click(app.row('River.txt'));
  app.key('b', { ctrlKey: true });
  assert.deepEqual(app.state().panes[0].selected, ['3']);
  for (const key of 'Terror') app.key(key);
  const input = app.document.querySelector('.pane.active .path-input'); input.focus();
  app.key('b', { ctrlKey: true }, input);
  app.action('select-search-matches');
  app.action('filter-search-matches');
  assert.deepEqual(app.state().panes[0].selected, ['3']);
  assert.ok(!app.state().panes[0].searchFilter);
  app.document.querySelector('.pane.active .list').focus();
  app.key('b', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(app.state().panes[0].selected, ['3']);
  app.action('select-search-matches');
  assert.deepEqual([...app.state().panes[0].selected].sort(), ['1', '2', '3', 'folder']);
  app.key('z'); app.key('b', { ctrlKey: true });
  assert.equal(app.state().panes[0].selected.length, 4);
});

test('search match selection stays out of dialogs and the file viewer', t => {
  const app = fixture(t);
  for (const key of 'Terror') app.key(key);
  app.action('mkdir');
  assert.equal(app.document.querySelector('#modal').open, true);
  app.action('select-search-matches');
  app.action('filter-search-matches');
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.ok(!app.state().panes[0].searchFilter);
  app.click(app.document.querySelector('#modal-cancel'));
  app.key('F3');
  assert.ok(app.document.querySelector('[data-lister]'));
  app.action('select-search-matches');
  app.action('filter-search-matches');
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.ok(!app.state().panes[0].searchFilter);
});

test('search match shortcut can be reassigned without leaving Ctrl B active', t => {
  const { catalog } = require('../shortcut-settings');
  const entry = catalog.find(item => item.command === 'bitfroest.select-search-matches');
  const app = fixture(t);
  for (const key of 'Terror') app.key(key);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'shortcut-settings', catalog, bindings: { [entry.id]: 'ctrl+shift+k' } } }));
  app.key('b', { ctrlKey: true });
  assert.deepEqual(app.state().panes[0].selected, []);
  app.key('k', { ctrlKey: true, shiftKey: true });
  assert.equal(app.messages.findLast(message => message.type === 'shortcut-execute').id, entry.id);
});

test('typing a complete query highlights all matches and scrolls to its cursor without changing selection', t => {
  const app = fixture(t);
  const scrolled = [];
  app.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.dataset.id); };
  let now = Date.now();
  app.window.Date.now = () => (now += 2000);
  for (const key of 'Terror') app.key(key);
  assert.equal(app.state().panes[0].filter, 'Terror');
  assert.deepEqual(app.state().panes[0].selected, []);
  for (const name of ['Terror.txt', 'Another Terror.txt']) {
    assert.equal(app.row(name).getAttribute('aria-selected'), 'false');
    assert.equal(app.row(name).querySelector('[data-filename] mark').textContent, 'Terror');
  }
  assert.equal(app.row('River.txt').querySelector('mark'), null);
  assert.equal(scrolled.at(-1), app.state().panes[0].cursor);
  const first = app.state().panes[0].cursor;
  app.key('ArrowDown');
  assert.notEqual(app.state().panes[0].cursor, first);
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.equal(scrolled.at(-1), app.state().panes[0].cursor);
  app.key('ArrowUp');
  assert.equal(app.state().panes[0].cursor, first);
  app.key('Backspace');
  assert.equal(app.state().panes[0].filter, 'Terro');
  app.key('Escape');
  assert.equal(app.state().panes[0].filter, '');
  assert.equal(app.document.querySelector('mark'), null);
});

test('search updates retain icons, cell nodes and lists without rendering or measuring directory contents', t => {
  const app = fixture(t, 1000);
  const lists = [...app.document.querySelectorAll('.list')];
  const cells = [...app.document.querySelectorAll('[data-cell]')];
  const icons = [...app.document.querySelectorAll('.fileicon')];
  let templates = 0, measurements = 0;
  const createElement = app.document.createElement.bind(app.document);
  app.document.createElement = (name, ...args) => { if (name === 'template') templates++; return createElement(name, ...args); };
  app.window.HTMLCanvasElement.prototype.getContext = () => ({ measureText() { measurements++; return { width: 10 }; } });
  app.messages.length = 0;
  const start = performance.now();
  for (const key of 'Terror') app.key(key);
  t.diagnostic(`Six-character search across 1003 entries: ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(measurements, 0, 'search must not measure directory columns');
  assert.equal(templates, 0, 'search must not render directory templates or regenerate file icons');
  assert.deepEqual([...app.document.querySelectorAll('.list')], lists);
  assert.deepEqual([...app.document.querySelectorAll('[data-cell]')], cells);
  assert.deepEqual([...app.document.querySelectorAll('.fileicon')], icons);
  assert.equal(app.messages.some(message => /icon|git-status|filesystem-navigate/.test(message.type)), false);
});

test('no matches retain cursor and existing marks while panel queries remain independent', t => {
  const app = fixture(t);
  app.click(app.row('River.txt'));
  const marked = app.state().panes[0].selected;
  for (const key of 'Terror') app.key(key);
  const cursor = app.state().panes[0].cursor;
  app.key('z');
  assert.deepEqual(app.state().panes[0].selected, marked);
  assert.equal(app.state().panes[0].cursor, cursor);
  assert.equal(app.document.querySelector('mark'), null);
  app.key('Backspace');
  assert.deepEqual(app.state().panes[0].selected, marked);
  app.key('Tab'); app.key('O');
  assert.equal(app.state().panes[1].filter, 'O');
  assert.equal(app.state().panes[0].filter, 'Terror');
  app.key('Tab'); app.key('Backspace');
  assert.equal(app.state().panes[0].filter, 'Terro');
  assert.equal(app.state().panes[1].filter, 'O');
  app.key('Escape');
  assert.equal(app.document.querySelector('.pane.active mark'), null);
  assert.deepEqual(app.state().panes[0].selected, marked);
});
