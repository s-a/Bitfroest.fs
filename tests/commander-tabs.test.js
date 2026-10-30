const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tabs = require('../media/commander-tabs');

function pane(paths = ['/alpha', '/beta', '/gamma']) {
  return { tabs: paths.slice(), tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name', descending: false, scrollTop: 42 };
}

test('legacy tab arrays acquire independent persisted view state', () => {
  const list = pane();
  tabs.ensure(list);
  tabs.activate(list, 1);
  assert.deepEqual(list.selected, []);
  assert.equal(list.cursor, null);
  list.selected = ['b']; list.cursor = 'b'; list.sort = 'size'; list.descending = true; list.scrollTop = 120;
  tabs.activate(list, 0);
  assert.deepEqual(list.selected, ['a']);
  assert.equal(list.scrollTop, 42);
  tabs.activate(list, 1);
  assert.deepEqual(list.selected, ['b']);
  assert.equal(list.sort, 'size');
  assert.equal(list.descending, true);
  assert.equal(list.scrollTop, 120);
});

test('foreground and background duplicates preserve source view without sharing arrays', () => {
  const list = pane();
  const backgroundIndex = tabs.duplicate(list, { background: true });
  assert.equal(backgroundIndex, 1);
  assert.equal(list.tab, 0);
  assert.deepEqual(list.tabs, ['/alpha', '/alpha', '/beta', '/gamma']);
  list.selected.push('another');
  tabs.activate(list, backgroundIndex);
  assert.deepEqual(list.selected, ['a']);
  const foregroundIndex = tabs.duplicate(list);
  assert.equal(list.tab, foregroundIndex);
  assert.notEqual(list.tabStates[foregroundIndex].id, list.tabStates[backgroundIndex].id);
});

test('navigation history restores directory selection and truncates forward history', () => {
  const list = pane(['/alpha']);
  tabs.navigate(list, '/alpha/child');
  assert.deepEqual(list.selected, []);
  list.selected = ['child-file']; list.cursor = 'child-file';
  assert.equal(tabs.back(list), true);
  assert.equal(list.tabs[0], '/alpha');
  assert.deepEqual(list.selected, ['a']);
  assert.equal(tabs.forward(list), true);
  assert.deepEqual(list.selected, ['child-file']);
  tabs.back(list);
  tabs.navigate(list, '/different');
  assert.equal(tabs.forward(list), false);
  assert.deepEqual(list.tabStates[0].history, ['/alpha', '/different']);
});

test('closing an inactive tab keeps the active path and view', () => {
  const list = pane();
  tabs.activate(list, 2);
  list.cursor = 'gamma-file';
  assert.equal(tabs.close(list, 0), true);
  assert.equal(list.tab, 1);
  assert.equal(list.tabs[list.tab], '/gamma');
  assert.equal(list.cursor, 'gamma-file');
  assert.equal(tabs.close(list), true);
  assert.equal(tabs.close(list), false);
  assert.deepEqual(list.tabs, ['/beta']);
});

test('reordering tracks the active tab by identity rather than by index', () => {
  const list = pane();
  tabs.activate(list, 1);
  tabs.move(list, 0, list, 3);
  assert.deepEqual(list.tabs, ['/beta', '/gamma', '/alpha']);
  assert.equal(list.tab, 0);
  tabs.move(list, 0, list, 3);
  assert.deepEqual(list.tabs, ['/gamma', '/alpha', '/beta']);
  assert.equal(list.tab, 2);
});

test('moving across panes preserves both active views and activates transferred tab', () => {
  const left = pane(['/alpha', '/beta']);
  const right = pane(['/target']);
  tabs.ensure(left); tabs.ensure(right);
  right.cursor = 'target-file';
  const result = tabs.move(left, 0, right, 1);
  assert.deepEqual(result, { index: 1, copied: false });
  assert.deepEqual(left.tabs, ['/beta']);
  assert.equal(left.tab, 0);
  assert.deepEqual(right.tabs, ['/target', '/alpha']);
  assert.equal(right.tab, 1);
  assert.equal(right.cursor, 'a');
  tabs.activate(right, 0);
  assert.equal(right.cursor, 'target-file');
});

test('moving the final tab across panes copies it so both panes remain usable', () => {
  const left = pane(['/alpha']);
  const right = pane(['/target']);
  const result = tabs.move(left, 0, right, 1);
  assert.equal(result.copied, true);
  assert.deepEqual(left.tabs, ['/alpha']);
  assert.deepEqual(right.tabs, ['/target', '/alpha']);
  assert.notEqual(left.tabStates[0].id, right.tabStates[1].id);
});

test('new paths inherit sort but start with empty selection and step wraps', () => {
  const list = pane(['/alpha']);
  list.sort = 'date'; list.descending = true;
  tabs.openPath(list, '/new');
  assert.equal(list.tab, 1);
  assert.deepEqual(list.selected, []);
  assert.equal(list.sort, 'date');
  assert.equal(list.descending, true);
  tabs.step(list, 1);
  assert.equal(list.tab, 0);
  tabs.step(list, -1);
  assert.equal(list.tab, 1);
});

test('copying a tab within one pane duplicates it and can keep the source active', () => {
  const list = pane(['/alpha', '/beta']);
  tabs.ensure(list);
  const sourceId = list.tabStates[0].id;
  const result = tabs.move(list, 0, list, 2, { copy: true, background: true });
  assert.deepEqual(result, { index: 2, copied: true });
  assert.deepEqual(list.tabs, ['/alpha', '/beta', '/alpha']);
  assert.equal(list.tabStates[list.tab].id, sourceId);
  assert.notEqual(list.tabStates[2].id, sourceId);
  tabs.activate(list, 2);
  list.selected.push('copy-only');
  tabs.activate(list, 0);
  assert.deepEqual(list.selected, ['a']);
});

test('the browser entry exposes the same frozen API without CommonJS', () => {
  const context = {};
  const filename = path.join(__dirname, '../media/commander-tabs.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  assert.deepEqual(Object.keys(context.CommanderTabs).sort(), Object.keys(tabs).sort());
  assert.equal(Object.isFrozen(context.CommanderTabs), true);
  const list = pane(['/browser']);
  context.CommanderTabs.duplicate(list);
  assert.equal(list.tabs.length, 2);
});

test('invalid pane data is rejected instead of creating empty date lists', () => {
  for (const invalid of [null, {}, { tabs: [] }, { tabs: [null] }, { tabs: [''] }]) {
    assert.throws(() => tabs.ensure(invalid), TypeError);
  }
});

test('serialized state retains views and normalizes incomplete metadata', () => {
  const original = pane();
  tabs.activate(original, 1);
  original.filter = 'selected'; original.selected = ['beta']; original.cursor = 'beta';
  tabs.remember(original);
  const list = JSON.parse(JSON.stringify(original));
  tabs.activate(list, 0);
  tabs.activate(list, 1);
  assert.equal(list.filter, 'selected');
  assert.deepEqual(list.selected, ['beta']);
  assert.equal(list.cursor, 'beta');

  const incomplete = { tabs: ['/one', '/two'], tab: 99, tabStates: [{ history: [], historyIndex: 100 }, { history: ['/two'], historyIndex: -10 }] };
  tabs.ensure(incomplete);
  assert.equal(incomplete.tab, 0);
  assert.deepEqual(incomplete.tabStates[0].history, ['/one']);
  assert.equal(incomplete.tabStates[0].historyIndex, 0);
  assert.equal(incomplete.tabStates[1].historyIndex, 0);
  assert.deepEqual(incomplete.tabStates[0].directoryStates, {});
  assert.deepEqual(incomplete.tabStates[0].view.selected, []);
  const missingIndex = { tabs: ['/one'], tabStates: [{ history: ['/old', '/one'] }] };
  tabs.ensure(missingIndex);
  assert.equal(missingIndex.tabStates[0].historyIndex, 1);
});

test('invalid operations preserve the current path, and identical navigation adds no history', () => {
  const list = pane();
  assert.equal(tabs.activate(list, -1), false);
  assert.equal(tabs.activate(list, 3), false);
  assert.equal(tabs.activate(list, 1.5), false);
  assert.equal(tabs.openPath(list, ''), false);
  assert.equal(tabs.openPath(list, null), false);
  assert.equal(tabs.navigate(list, ''), false);
  assert.equal(tabs.navigate(list, null), false);
  assert.equal(tabs.navigate(list, '/alpha'), true);
  assert.deepEqual(list.tabStates[0].history, ['/alpha']);
  assert.equal(tabs.back(list), false);
  assert.equal(tabs.forward(list), false);
  assert.equal(tabs.close(list, -1), false);
  assert.equal(tabs.step(list, 0.5), false);
  assert.equal(tabs.move(list, -1, pane(), 0), false);
  assert.equal(list.tabs[list.tab], '/alpha');
});

test('background path insertion before active tab retains current view and clamps explicit positions', () => {
  const list = pane();
  tabs.activate(list, 1);
  list.cursor = 'beta'; list.selected = ['beta'];
  tabs.openPath(list, '/first', { index: -5, background: true });
  assert.equal(list.tab, 2);
  assert.equal(list.tabs[list.tab], '/beta');
  assert.equal(list.cursor, 'beta');
  tabs.openPath(list, '/last', { index: 100, background: true });
  assert.equal(list.tab, 2);
  assert.equal(list.tabs.at(-1), '/last');
  tabs.openPath(list, '/foreground', { index: 0 });
  assert.equal(list.tab, 0);
  assert.equal(list.cursor, null);
  tabs.step(list, -6);
  assert.equal(list.tab, 0);
});

test('closing an inactive tab after the active one retains its selection and identity', () => {
  const list = pane();
  tabs.ensure(list);
  const id = list.tabStates[0].id;
  tabs.close(list, 2);
  assert.equal(list.tab, 0);
  assert.equal(list.tabStates[0].id, id);
  assert.deepEqual(list.selected, ['a']);
});

test('background cross-pane transfer preserves both existing active tabs', () => {
  const left = pane(['/alpha', '/beta', '/gamma']);
  const right = pane(['/target', '/other']);
  tabs.activate(left, 1);
  left.cursor = 'beta-active';
  tabs.activate(right, 1);
  right.cursor = 'other-active';
  const result = tabs.move(left, 0, right, 0, { background: true });
  assert.deepEqual(result, { index: 0, copied: false });
  assert.equal(left.tabs[left.tab], '/beta');
  assert.equal(left.cursor, 'beta-active');
  assert.equal(right.tabs[right.tab], '/other');
  assert.equal(right.cursor, 'other-active');
  assert.equal(right.tab, 2);
  tabs.activate(right, 0);
  assert.equal(right.tabs[0], '/alpha');
  assert.equal(right.cursor, 'a');
});

test('foreground copy activates the new tab and ordinary reorder keeps the original active tab', () => {
  const list = pane();
  tabs.move(list, 1, list, 0, { copy: true });
  assert.deepEqual(list.tabs, ['/beta', '/alpha', '/beta', '/gamma']);
  assert.equal(list.tab, 0);
  const copiedId = list.tabStates[0].id;
  tabs.move(list, 0, list, 0);
  assert.equal(list.tabStates[list.tab].id, copiedId);
  tabs.move(list, 3, list, -100);
  assert.equal(list.tabs[0], '/gamma');
  assert.equal(list.tabStates[list.tab].id, copiedId);
});

test('explicit cross-pane copy keeps all source tabs and appends by default', () => {
  const source = pane(['/alpha', '/beta']);
  const target = pane(['/destination']);
  const result = tabs.move(source, 1, target, undefined, { copy: true });
  assert.deepEqual(result, { index: 1, copied: true });
  assert.deepEqual(source.tabs, ['/alpha', '/beta']);
  assert.deepEqual(target.tabs, ['/destination', '/beta']);
  assert.equal(target.tab, 1);
});
