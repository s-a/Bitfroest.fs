const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('folder tabs have no close icon and double click closes only that tab', t => {
  const app = createApp(t);
  assert.equal(app.document.querySelectorAll('[data-close-tab]').length, 0);
  const initial = app.state().panes[0].tabs.length;
  const tab = app.document.querySelector('[data-pane="0"] [data-tab="1"]');
  app.click(tab);
  assert.equal(app.document.querySelector('[data-pane="0"] .path-input').value, '/workspace/bitfroest/docs');
  const activeTab = app.document.querySelector('[data-pane="0"] [data-tab="1"]');
  activeTab.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  assert.equal(app.state().panes[0].tabs.length, initial - 1);
});

test('tab middle click closes it and column dragging changes persisted order', t => {
  const app = createApp(t);
  const tab = app.document.querySelector('[data-pane="0"] [data-tab="1"]');
  tab.dispatchEvent(new app.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
  assert.equal(app.state().panes[0].tabs.length, 2);
  const transfer = { data: {}, setData(key, value) { this.data[key] = value; }, getData(key) { return this.data[key] || ''; } };
  const drag = (type, target) => { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event); };
  drag('dragstart', app.document.querySelector('[data-pane="0"] [data-column="attributes"]'));
  drag('drop', app.document.querySelector('[data-pane="0"] [data-column="name"]'));
  assert.equal(app.state().panes[0].columns[0].key, 'attributes');
});

test('typing a substring selects its file without filtering or opening a dialog', t => {
  const app = createApp(t);
  const count = app.document.querySelectorAll('[data-pane="0"] tbody tr[data-id]').length;
  for (const letter of 'kage') app.key(letter);
  assert.equal(app.row('package.json').getAttribute('aria-selected'), 'true');
  assert.equal(app.document.querySelectorAll('[data-pane="0"] tbody tr[data-id]').length, count);
  assert.equal(app.document.querySelector('dialog').open, false);
  assert.ok(app.row('package.json').querySelector('mark'));
  app.key('Escape');
  assert.equal(app.state().panes[0].filter, '');
});

test('tabs and keyboard actions belong to the focused pane', t => {
  const app = createApp(t);
  app.key('Tab');
  app.key('t', { ctrlKey: true });
  assert.equal(app.state().panes[1].tabs.length, 3);
  assert.equal(app.state().panes[0].tabs.length, 3);
  app.key('w', { ctrlKey: true });
  assert.equal(app.state().panes[1].tabs.length, 2);
  const input = app.document.querySelector('[data-pane="1"] .path-input');
  input.focus();
  app.key('t', { ctrlKey: true });
  assert.equal(app.state().panes[1].tabs.length, 2);
});

test('five sortable columns include attributes and support autosizing at the boundary', t => {
  const app = createApp(t);
  const headers = [...app.document.querySelectorAll('[data-pane="0"] th')];
  assert.deepEqual(headers.map(item => item.dataset.column), ['name', 'type', 'size', 'date', 'attributes']);
  const before = app.state().panes[0].columns[0].width;
  app.document.querySelector('[data-pane="0"] [data-resize="name"]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  assert.notEqual(app.state().panes[0].columns[0].width, before);
  app.click(app.document.querySelector('[data-pane="0"] [data-sort="name"]'));
  const firstRow = app.document.querySelector('[data-pane="0"] tr[data-id]');
  assert.ok(firstRow.querySelector('.folder'));
});

test('native rename action edits a filename inline and preserves extension', t => {
  const app = createApp(t);
  app.click(app.row('package.json').querySelector('[data-filename]'));
  app.action('rename-one');
  const input = app.document.querySelector('.inline-rename');
  assert.ok(input);
  assert.equal(input.selectionEnd, 'package.json'.length);
  input.value = 'package-new.json';
  app.key('Enter', {}, input);
  assert.ok(app.row('package-new.json'));
  assert.equal(app.document.querySelector('dialog').open, false);
});

test('Shift+F6 renames inline rather than moving to the other pane', t => {
  const app = createApp(t);
  app.click(app.row('README.md').querySelector('[data-filename]'));
  app.key('F6', { shiftKey: true });
  assert.ok(app.document.querySelector('.inline-rename'));
  assert.equal(app.document.querySelector('dialog').open, false);
});

test('arrow keys traverse substring hits while the full list remains visible', t => {
  const app = createApp(t);
  for (const letter of '.md') app.key(letter);
  assert.equal(app.row('CHANGELOG.md').getAttribute('aria-selected'), 'true');
  app.key('ArrowDown');
  assert.equal(app.row('README.md').getAttribute('aria-selected'), 'true');
  app.key('ArrowUp');
  assert.equal(app.row('CHANGELOG.md').getAttribute('aria-selected'), 'true');
});

test('native icons replace fallbacks on rows and tabs without being saved as layout data', t => {
  const app = createApp(t);
  assert.ok(app.messages.some(message => message.type === 'icons'));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: {
    '/workspace/bitfroest/README.md': 'data:image/png;base64,AA==',
    '/workspace/bitfroest/docs': 'data:image/png;base64,AQ=='
  } } }));
  assert.ok(app.row('README.md').querySelector('img.native-icon'));
  assert.ok(app.document.querySelector('[data-pane="0"] [data-tab="1"] img.native-icon'));
  assert.equal(JSON.stringify(app.state()).includes('data:image'), false);
});

test('Ctrl+U swaps current directories while preserving the tab sets', t => {
  const app = createApp(t);
  app.key('u', { ctrlKey: true });
  assert.equal(app.state().panes[0].tabs[0], '/home/demo/Downloads');
  assert.equal(app.state().panes[1].tabs[0], '/workspace/bitfroest');
  assert.equal(app.state().panes[0].tabs.length, 3);
  assert.equal(app.state().panes[1].tabs.length, 2);
});

test('an inline directory rename preserves similarly prefixed sibling directories', t => {
  const source = createApp(t).state();
  source.folders['/workspace/bitfroest'].push({ id: 'sibling', name: 'docs!backup', type: 'folder', size: 0 });
  source.folders['/workspace/bitfroest/docs!backup'] = [{ id: 'kept', name: 'keep.txt', type: 'text' }];
  const app = createApp(t, source);
  app.click(app.row('docs').querySelector('[data-filename]')); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); input.value = 'manuals'; app.key('Enter', {}, input);
  assert.ok(app.state().folders['/workspace/bitfroest/docs!backup']);
  assert.equal(app.state().folders['/workspace/bitfroest/manuals!backup'], undefined);
});
