const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const manifest = require('../package.json');
const fixture = () => ({ version: 1, realFilesystem: true, active: 0, folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: ['C:/tmp', 'C:/temp'].map(path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' })) });
const respond = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const change = (app, selector, value) => { const el = app.document.querySelector(selector); assert.ok(el, selector); el.value = value; el.dispatchEvent(new app.window.Event('input', { bubbles: true })); };
function open(t) { const app = createApp(t, fixture()); app.document.querySelector('.pane.active .list').focus(); app.key('F7', { altKey: true }); return app; }

test('search mnemonics focus and select the complete name and search text', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  const name = dialog.querySelector('[name=name]'), text = dialog.querySelector('[name=text]');
  name.value = 'existing name'; text.value = 'existing content';
  app.key('e', { altKey: true });
  assert.equal(app.document.activeElement, name); assert.equal(name.selectionStart, 0); assert.equal(name.selectionEnd, name.value.length);
  app.key('t', { altKey: true });
  assert.equal(dialog.querySelector('[name=textEnabled]').checked, true);
  assert.equal(app.document.activeElement, text); assert.equal(text.selectionStart, 0); assert.equal(text.selectionEnd, text.value.length);
  app.key('t', { altKey: true }); assert.equal(text.disabled, false); assert.equal(app.document.activeElement, text);
});

test('native forwarded search shortcuts select field contents and stay inside the dialog', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  for (const [key, field] of [['e', 'name'], ['t', 'text'], ['i', 'searchIn']]) {
    const input = dialog.querySelector(`[name=${field}]`); input.value = `value for ${field}`;
    app.action(`search-key:alt+${key}`);
    assert.equal(app.document.activeElement, input); assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length);
  }
  assert.equal(app.messages.some(message => message.type === 'search-start'), false);
});

test('search checkbox captions stay inline and controls keep square dimensions under production styles', t => {
  const app = open(t), fs = require('node:fs'), path = require('node:path');
  for (const name of ['workbench-vendor.css', 'app.css', 'file-search.css']) { const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.join(__dirname, '../media', name), 'utf8'); app.document.head.append(style); }
  const label = app.document.querySelector('[name=wholeWords]').closest('label');
  assert.equal(label.children.length, 2); assert.equal(label.children[1].tagName, 'SPAN'); assert.equal(label.children[1].textContent, 'nur ganze Wörter');
  assert.equal(label.querySelector('u').parentElement, label.children[1]);
  const style = app.window.getComputedStyle(label.querySelector('input'));
  assert.equal(style.width, '16px'); assert.equal(style.height, '16px'); assert.equal(style.flexShrink, '0');
});

test('search depth uses descriptive choices with a custom depth and no plugin controls', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]'), depth = dialog.querySelector('[name=depth]');
  assert.equal(depth.tagName, 'SELECT'); assert.match(depth.selectedOptions[0].textContent, /unbegrenzt/i);
  depth.value = 'custom'; depth.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  const custom = dialog.querySelector('[name=depthCustom]'); assert.equal(custom.closest('[hidden]'), null); custom.value = '250';
  app.key('s', { altKey: true }); assert.equal(app.messages.find(m => m.type === 'search-start').settings.depth, 250);
  assert.equal(dialog.querySelectorAll('[role=tab]').length, 3);
  assert.equal(dialog.querySelector('[name=pluginsEnabled]'), null); assert.doesNotMatch(dialog.textContent, /Plugins|Pluginfelder|\btc\b/i);
});

test('custom depth validates all start paths and cannot block the form after switching back', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]'), depth = dialog.querySelector('[name=depth]'), custom = dialog.querySelector('[name=depthCustom]');
  depth.value = 'custom'; depth.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  for (const value of ['', '0', '1.5']) {
    custom.value = value; custom.focus(); app.key('Enter');
    assert.equal(app.messages.some(message => message.type === 'search-start'), false, value);
  }
  depth.value = '-1'; depth.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(custom.disabled, true); assert.equal(dialog.querySelector('form').checkValidity(), true);
  app.key('s', { altKey: true }); assert.equal(app.messages.find(message => message.type === 'search-start').settings.depth, -1);
});

test('Alt+F7 opens three tabs with search name focused and preserves the folder tabs', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  assert.ok(dialog?.open); assert.equal(dialog.querySelectorAll('[role=tab]').length, 3);
  assert.equal(app.document.activeElement.name, 'name');
  assert.equal(app.state().panes[0].tabs.length, 1);
});

test('search access keys use German mnemonics within the current page and do not submit a search', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  app.key('t', { altKey: true }); assert.equal(dialog.querySelector('[name=textEnabled]').checked, true);
  app.key('e', { altKey: true }); assert.equal(app.document.activeElement.name, 'name');
  app.key('Tab', { ctrlKey: true }); assert.equal(dialog.querySelector('[aria-selected=true]').dataset.page, '1');
  app.key('t', { altKey: true }); assert.equal(dialog.querySelector('[name=attributesEnabled]').checked, true);
  app.key('Tab', { ctrlKey: true, shiftKey: true }); assert.equal(dialog.querySelector('[aria-selected=true]').dataset.page, '0');
  assert.equal(app.messages.some(m => m.type === 'search-start'), false);
});

test('start sends independent search settings, escape cancels once, stale completions are ignored', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  change(app, '[data-file-search] [name=name]', '*.txt');
  app.key('s', { altKey: true });
  const request = app.messages.find(m => m.type === 'search-start'); assert.equal(request.settings.name, '*.txt');
  assert.equal(dialog.querySelector('[data-search-start]').disabled, true);
  app.key('Escape'); app.key('Escape'); assert.equal(app.messages.filter(m => m.type === 'search-cancel').length, 1);
  respond(app, { type: 'search-complete', searchId: 'stale', results: [{ name: 'bad' }] });
  assert.equal(dialog.querySelectorAll('[data-search-result]').length, 0);
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [], errors: [], cancelled: true });
  assert.equal(dialog.querySelector('[data-search-start]').disabled, false);
  assert.ok(dialog.open);
});

test('apply creates a distinct result tab per list and Ctrl R refreshes without removing it', t => {
  const app = open(t), initial = fixture();
  app.key('s', { altKey: true }); const request = app.messages.find(m => m.type === 'search-start');
  const row = { id: 'fs:C:/tmp/a.txt', name: 'a.txt', type: 'text', fsSource: 'C:/tmp/a.txt', size: 1 };
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [row], errors: [] });
  app.key('w', { altKey: true });
  const apply = app.messages.find(m => m.type === 'search-apply'); assert.equal(apply.searchId, request.searchId);
  initial.folders['C:/tmp'] = [row];
  respond(app, { type: 'search-applied', searchId: request.searchId, state: initial, results: [row], ok: true });
  assert.equal(app.state().panes[0].tabs.length, 2);
  assert.ok(app.state().panes[0].tabStates[1].searchResult);
  assert.deepEqual(Object.keys(app.state().folders), ['C:/tmp', 'C:/temp']);
  assert.ok(app.row('a.txt'));
  app.key('r', { ctrlKey: true });
  const refresh = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1); assert.ok(refresh);
  respond(app, { type: 'filesystem-result', ok: true, state: structuredClone(refresh.state) });
  assert.equal(app.state().panes[0].tabStates[1].searchResult.id, request.searchId);
  app.key('F7', { altKey: true }); app.key('s', { altKey: true });
  const second = app.messages.filter(m => m.type === 'search-start').at(-1);
  respond(app, { type: 'search-complete', searchId: second.searchId, results: [row], errors: [] }); app.key('w', { altKey: true });
  respond(app, { type: 'search-applied', searchId: second.searchId, state: app.state(), results: [row], ok: true });
  assert.equal(app.state().panes[0].tabs.length, 3);
  assert.equal(app.messages.some(m => m.type === 'filesystem-apply'), false);
});

test('opening an applied file and returning focus refreshes without dropping its result tab', t => {
  const app = open(t), fresh = fixture(), row = { id: 'a', name: 'hit.txt', fsSource: 'C:/tmp/hit.txt', type: 'text' };
  app.key('s', { altKey: true }); const request = app.messages.find(message => message.type === 'search-start');
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [row] }); app.key('w', { altKey: true });
  fresh.folders['C:/tmp'] = [row]; respond(app, { type: 'search-applied', searchId: request.searchId, state: fresh, results: [row], ok: true });
  const tab = app.state().panes[0].tabStates[1].id;
  app.click(app.row('hit.txt')); app.row('hit.txt').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(app.messages.filter(message => message.type === 'open').at(-1).path, row.fsSource);
  app.window.dispatchEvent(new app.window.Event('blur')); app.window.dispatchEvent(new app.window.Event('focus'));
  assert.equal(app.state().panes[0].tabStates[1].searchResult.id, request.searchId);
  const refresh = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1); assert.ok(refresh);
  respond(app, { type: 'filesystem-result', ok: true, state: structuredClone(refresh.state) });
  assert.equal(app.state().panes[0].tabStates[1].id, tab); assert.ok(app.row('hit.txt')); assert.equal(app.state().panes[0].cursor, row.id);
});

test('Backspace exits a result tab to the preceding view and Ctrl+W explicitly closes it', t => {
  for (const key of ['Backspace', 'w']) {
    const saved = fixture(), row = { id: 'a', name: 'hit.txt', fsSource: 'C:/tmp/hit.txt', type: 'text' };
    saved.folders['C:/tmp'] = [row]; saved.panes[0].tabs.push('C:/tmp'); saved.panes[0].tab = 1;
    saved.panes[0].tabStates = [{ path: 'C:/tmp', view: { selected: ['a'], cursor: 'a', sort: 'size', descending: true, scrollTop: 42 } }, { path: 'C:/tmp', searchResult: { id: 'result', source: 'C:/tmp', paths: [row.fsSource] } }];
    const app = createApp(t, saved); app.document.querySelector('.pane.active .list').focus(); app.key(key, key === 'w' ? { ctrlKey: true } : {});
    const pane = app.state().panes[0]; assert.equal(pane.tabs.length, 1); assert.equal(pane.tab, 0); assert.equal(pane.tabStates[0].searchResult, undefined);
    assert.deepEqual(Array.from(pane.selected), ['a']); assert.equal(pane.cursor, 'a'); assert.equal(pane.sort, 'size'); assert.equal(pane.descending, true);
  }
});

test('a pending refresh cannot resurrect a result tab explicitly closed before its reply', t => {
  for (const key of ['Backspace', 'w']) {
    const saved = fixture(), row = { id: 'a', name: 'hit.txt', fsSource: 'C:/tmp/hit.txt', type: 'text' };
    saved.folders['C:/tmp'] = [row]; saved.panes[0].tabs.push('C:/tmp'); saved.panes[0].tab = 1;
    saved.panes[0].tabStates = [{ path: 'C:/tmp' }, { path: 'C:/tmp', searchResult: { id: 'result', source: 'C:/tmp', paths: [row.fsSource] } }];
    const app = createApp(t, saved); app.action('refresh');
    const refresh = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1); assert.ok(refresh);
    const responseState = structuredClone(refresh.state);
    app.document.querySelector('.pane.active .list').focus(); app.key(key, key === 'w' ? { ctrlKey: true } : {});
    assert.equal(app.state().panes[0].tabs.length, 1);
    respond(app, { type: 'filesystem-result', ok: true, state: responseState });
    assert.equal(app.state().panes[0].tabs.length, 1); assert.equal(app.state().panes[0].tabStates.some(tab => tab.searchResult), false);
  }
});

test('opening a folder result keeps the result tab and opens its directory separately', t => {
  const saved = fixture(), folder = { id: 'sub', name: 'sub', fsSource: 'C:/tmp/sub', type: 'folder' };
  saved.folders['C:/tmp'] = [folder]; saved.folders['C:/tmp/sub'] = [];
  saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { id: 'result', source: 'C:/tmp', paths: [folder.fsSource] } }];
  const app = createApp(t, saved); app.row('sub').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
  const pane = app.state().panes[0]; assert.equal(pane.tabs.length, 2); assert.equal(pane.tabStates[0].searchResult.id, 'result'); assert.equal(pane.tabs[pane.tab], folder.fsSource);
});

test('opening a ZIP from results keeps the result tab after archive metadata arrives', t => {
  const saved = fixture(), archive = { id: 'zip', name: 'data.zip', fsSource: 'C:/tmp/data.zip', type: 'archive' };
  saved.folders['C:/tmp'] = [archive]; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { id: 'result', source: 'C:/tmp', paths: [archive.fsSource] } }];
  const app = createApp(t, saved); app.row('data.zip').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
  const request = app.messages.find(message => message.type === 'zip-open'), fresh = structuredClone(request.state), target = 'zip:opaque!';
  fresh.folders[target] = []; fresh.archiveLocations = { [target]: { archive: archive.fsSource, parent: 'C:/tmp' } };
  respond(app, { type: 'filesystem-result', state: fresh, ok: true, resumeNavigation: { side: 0, path: target } });
  const pane = app.state().panes[0]; assert.equal(pane.tabs.length, 2); assert.equal(pane.tabStates[0].searchResult.id, 'result'); assert.equal(pane.tabs[pane.tab], target);
});

test('F2 narrows the next search, result history survives new search and Ctrl+C copies actual result paths', t => {
  const app = open(t); app.key('s', { altKey: true }); const request = app.messages.find(m => m.type === 'search-start');
  const row = { name: 'hit.txt', fsSource: 'C:/tmp/deep/hit.txt', size: 1, mtimeMs: 0 };
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [row], errors: [] });
  app.document.querySelector('[data-search-results]').focus(); app.key('c', { ctrlKey: true });
  assert.equal(app.messages.at(-1).type, 'search-copy');
  app.key('F2'); app.key('s', { altKey: true }); const next = app.messages.filter(m => m.type === 'search-start').at(-1);
  assert.deepEqual(Array.from(next.settings.inResults), [row.fsSource]);
});

test('all declared native shortcuts are scoped to search focus', () => {
  const binding = manifest.contributes.keybindings.find(b => b.key === 'alt+f7');
  assert.equal(binding?.command, 'bitfroest.search'); assert.match(binding.when, /listFocus/);
  for (const key of ['alt+e', 'alt+t', 'alt+w', 'f2', 'f3', 'f4', 'escape', 'ctrl+tab', 'ctrl+shift+tab']) {
    assert.ok(manifest.contributes.keybindings.some(b => b.key === key && b.command === 'bitfroest.search-key' && b.when.includes('bitfroest.searchFocus')), key);
  }
});

test('F2 keeps provider archive references and revisions in the next request', t => {
  const app = open(t); app.key('s', { altKey: true }); const request = app.messages.find(m => m.type === 'search-start');
  const row = { id: 'opaque-id', name: 'hit.txt', archive: 'C:/tmp/data.zip', archiveEntry: 'nested/hit.txt', revision: 'revision-1', fsSource: 'zip:opaque!/nested/hit.txt', size: 1 };
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [row], errors: [] });
  app.key('F2'); app.key('s', { altKey: true });
  const source = app.messages.filter(m => m.type === 'search-start').at(-1).settings.inResults[0];
  assert.equal(source.archive, row.archive); assert.equal(source.archiveEntry, row.archiveEntry); assert.equal(source.revision, row.revision); assert.equal(source.fsSource, row.fsSource);
});

test('search focus reports native shortcut contexts for inputs, buttons and result lists', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  for (const target of [dialog.querySelector('[name=name]'), dialog.querySelector('[data-search-start]')]) {
    target.focus(); const focus = app.messages.filter(m => m.type === 'inputFocus').at(-1);
    assert.equal(focus.search, true); assert.equal(focus.dialog, true); assert.equal(focus.list, false);
  }
  app.key('s', { altKey: true }); const req = app.messages.find(m => m.type === 'search-start');
  respond(app, { type: 'search-complete', searchId: req.searchId, results: [], errors: [] });
  dialog.querySelector('[data-search-results]').focus();
  assert.equal(app.messages.filter(m => m.type === 'inputFocus').at(-1).searchResults, true);
});

test('result tabs retain actual source paths for deletion and clipboard selection across directories', t => {
  const saved = fixture(); const a = { id: 'a', name: 'same.txt', type: 'text', fsSource: 'C:/tmp/sub/same.txt', size: 1 }, b = { ...a, id: 'b', fsSource: 'C:/tmp/same.txt' };
  saved.folders['C:/tmp'] = [b]; saved.folders['C:/tmp/sub'] = [a];
  saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { source: 'C:/tmp', label: 'Suche: *.txt', paths: [a.fsSource, b.fsSource] } }];
  const app = createApp(t, saved); app.action('select-all'); app.action('clipboard-copy');
  assert.deepEqual(Array.from(app.messages.find(m => m.type === 'clipboard-write').paths).sort(), [b.fsSource, a.fsSource].sort());
  app.action('delete'); app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(Array.from(app.messages.find(m => m.type === 'filesystem-delete').paths).sort(), [b.fsSource, a.fsSource].sort());
  assert.match(app.document.querySelector('[role=tab]').textContent, /Suche/);
});

test('running searches reject access keys for inherited disabled controls and accept depths above one hundred', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  const depth = dialog.querySelector('[name=depth]'); depth.value = 'custom'; depth.dispatchEvent(new app.window.Event('change', { bubbles: true })); dialog.querySelector('[name=depthCustom]').value = '250';
  app.key('s', { altKey: true }); assert.equal(app.messages.find(m => m.type === 'search-start').settings.depth, 250);
  app.key('t', { altKey: true }); assert.equal(dialog.querySelector('[name=textEnabled]').checked, false);
});

test('copy from a result list uses a single target confirmation for files in different source directories', async t => {
  const saved = fixture(); saved.realFilesystem = false;
  const a = { id: 'a', name: 'a.txt', type: 'text', fsSource: 'C:/tmp/sub/a.txt', size: 1, content: 'A' }, b = { ...a, id: 'b', name: 'b.txt', fsSource: 'C:/tmp/b.txt', content: 'B' };
  saved.folders['C:/tmp'] = [b]; saved.folders['C:/tmp/sub'] = [a];
  saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { source: 'C:/tmp', paths: [a.fsSource, b.fsSource] } }];
  const app = createApp(t, saved); app.action('select-all'); app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.state().folders['C:/temp'].map(row => row.name).sort(), ['a.txt', 'b.txt']);
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.state().folders['C:/tmp/sub'][0].content, 'A');
});

test('shift mnemonic for go-to preserves the new-tab modifier and each history list keeps its own name', t => {
  const app = open(t); change(app, '[data-file-search] [name=name]', '*.txt'); app.key('s', { altKey: true });
  const req = app.messages.find(m => m.type === 'search-start'); const row = { name: 'a.txt', fsSource: 'C:/tmp/a.txt' };
  respond(app, { type: 'search-complete', searchId: req.searchId, results: [row], errors: [] });
  app.key('g', { altKey: true, shiftKey: true }); assert.equal(app.messages.find(m => m.type === 'search-navigate').newTab, true);
});

test('F3 suspends the modal search until the Lister is closed', async t => {
  const app = open(t); app.key('s', { altKey: true }); const req = app.messages.find(m => m.type === 'search-start');
  respond(app, { type: 'search-complete', searchId: req.searchId, results: [{ name: 'a.txt', type: 'text', fsSource: 'C:/tmp/a.txt', size: 1 }], errors: [] });
  app.key('F3'); assert.equal(app.document.querySelector('[data-file-search]').open, false);
  assert.ok(app.document.querySelector('[data-lister]'));
  app.click(app.document.querySelector('[data-lister-close]')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelector('[data-file-search]').open, true);
});

test('workspace restore disposes open searches and duplicate groups stay together in result tabs', t => {
  const saved = fixture();
  const rows = ['a', 'z', 'b', 'y'].map(name => ({ id: name, name: `${name}.txt`, fsSource: `C:/tmp/${name}.txt`, type: 'text' })); saved.folders['C:/tmp'] = rows;
  saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: rows.map(row => row.fsSource), groups: Object.fromEntries(rows.map((row, i) => [row.fsSource, Math.floor(i / 2)])) } }];
  const app = createApp(t, saved);
  assert.deepEqual([...app.document.querySelectorAll('.pane.active tr[data-id]')].map(row => row.dataset.id), ['a', 'z', 'b', 'y']);
  app.key('F7', { altKey: true }); app.key('s', { altKey: true });
  respond(app, { type: 'restore', resetViews: true, state: fixture() });
  assert.equal(app.document.querySelector('[data-file-search]'), null);
  assert.equal(app.messages.some(m => m.type === 'search-cancel'), true);
});

test('search layout uses native theme variables, visible focus, responsive grids and no fixed result height', () => {
  const fs = require('node:fs'), path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../media/file-search.css'), 'utf8');
  assert.match(css, /--vscode-editorWidget-background/); assert.match(css, /--vscode-focusBorder/);
  assert.match(css, /:focus-visible/); assert.match(css, /max-height/); assert.match(css, /@media/);
});

test('English search captions are translated as complete phrases while preserving the requested access keys', t => {
  const app = createApp(t, fixture(), { language: 'en' }); app.key('F7', { altKey: true });
  const dialog = app.document.querySelector('[data-file-search]');
  assert.match(dialog.textContent, /Find files/); assert.match(dialog.querySelector('[name=name]').closest('label').textContent, /Search for/);
  assert.match(dialog.querySelector('[name=textEnabled]').closest('label').textContent, /Find text/);
  app.key('e', { altKey: true }); assert.equal(app.document.activeElement.name, 'name');
});

test('Shift+Delete removes the active search history entry without deleting files', t => {
  const app = open(t), field = app.document.querySelector('[data-file-search] [name=name]');
  respond(app, { type: 'search-presets', values: {}, histories: { name: ['*.txt', '*.md'] } });
  assert.equal(app.document.querySelectorAll('[data-search-history=name] option').length, 2);
  field.value = '*.txt'; field.focus(); app.key('Delete', { shiftKey: true });
  const message = app.messages.find(m => m.type === 'search-history-delete'); assert.equal(message.field, 'name'); assert.equal(message.value, '*.txt');
  assert.equal(app.messages.some(m => m.type === 'filesystem-delete'), false);
});

test('renaming a result from a nested folder changes the actual row and preserves result membership', t => {
  const saved = fixture(); saved.realFilesystem = false;
  const a = { id: 'a', name: 'a.txt', fsSource: 'C:/tmp/sub/a.txt', type: 'text', content: 'A' };
  saved.folders['C:/tmp/sub'] = [a]; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [a.fsSource] } }]; saved.panes[0].cursor = 'a';
  const app = createApp(t, saved); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input); input.value = 'renamed.txt'; app.key('Enter', {}, input);
  assert.equal(app.state().folders['C:/tmp/sub'][0].name, 'renamed.txt');
  assert.ok(app.row('renamed.txt'));
});

test('result rename checks unlisted siblings and tracks the confirmed new path', t => {
  const saved = fixture(), a = { id: 'a', name: 'a.txt', fsSource: 'C:/tmp/sub/a.txt', type: 'text' };
  saved.folders['C:/tmp/sub'] = [a, { id: 'b', name: 'taken.txt', fsSource: 'C:/tmp/sub/taken.txt', type: 'text' }]; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [a.fsSource] } }]; saved.panes[0].cursor = 'a';
  const app = createApp(t, saved); app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); input.value = 'taken.txt'; app.key('Enter', {}, input);
  assert.ok(app.document.querySelector('.inline-rename')); assert.equal(app.state().folders['C:/tmp/sub'][0].name, 'a.txt');
  input.value = 'new.txt'; app.key('Enter', {}, input);
  assert.equal(app.state().panes[0].tabStates[0].searchResult.paths[0], 'C:/tmp/sub/new.txt');
});

test('bulk result rename checks conflicts per source directory and updates both result paths', t => {
  const saved = fixture(); saved.realFilesystem = false;
  const a = { id: 'a', name: 'a.txt', fsSource: 'C:/tmp/sub/a.txt', type: 'text' }, b = { id: 'b', name: 'b.txt', fsSource: 'C:/tmp/b.txt', type: 'text' };
  saved.folders['C:/tmp'] = [b]; saved.folders['C:/tmp/sub'] = [a]; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [a.fsSource, b.fsSource] } }];
  const app = createApp(t, saved); app.action('select-all'); app.action('rename'); app.document.querySelector('#mask').value = 'shared';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.deepEqual(Array.from(app.state().panes[0].tabStates[0].searchResult.paths).sort(), ['C:/tmp/shared.txt', 'C:/tmp/sub/shared.txt']);
  assert.equal(app.state().folders['C:/tmp/sub'][0].name, 'shared.txt');
});

test('Num+ opens duplicate marking and Apply changes selection without closing the dialog', async t => {
  const saved = fixture(); const rows = ['a', 'b'].map((id, i) => ({ id, name: `${id}.txt`, fsSource: `C:/tmp/${id}.txt`, type: 'text', mtimeMs: i + 1, size: 1 })); saved.folders['C:/tmp'] = rows;
  saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: rows.map(row => row.fsSource), groups: Object.fromEntries(rows.map(row => [row.fsSource, 0])) } }];
  const app = createApp(t, saved); app.key('+', { code: 'NumpadAdd' });
  assert.match(app.document.querySelector('#modal-title').textContent, /Doppelte/);
  app.document.querySelector('#duplicate-keep-one').checked = true;
  app.click(app.document.querySelector('[data-duplicate-apply]')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelector('#modal').open, true); assert.equal(app.state().panes[0].selected.length, 1);
});

test('bulk result rename maps original names simultaneously when target names form a chain', t => {
  const saved = fixture(); saved.realFilesystem = false;
  const rows = [1, 2].map(n => ({ id: String(n), name: `${n}.txt`, fsSource: `C:/tmp/${n}.txt`, type: 'text' })); saved.folders['C:/tmp'] = rows; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: rows.map(row => row.fsSource) } }];
  const app = createApp(t, saved); app.action('select-all'); app.action('rename'); app.document.querySelector('#mask').value = '[C]'; app.document.querySelector('#counter').value = '2';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(Array.from(app.state().panes[0].tabStates[0].searchResult.paths), ['C:/tmp/2.txt', 'C:/tmp/3.txt']);
});

test('result rows show their source directories and visually separate duplicate groups', t => {
  const saved = fixture(), rows = ['a', 'b'].map((id, i) => ({ id, name: `${id}.txt`, fsSource: `C:/tmp/${id}.txt`, type: 'text', mtimeMs: i + 1 }));
  saved.folders['C:/tmp'] = rows; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: rows.map(row => row.fsSource), groups: Object.fromEntries(rows.map((row, i) => [row.fsSource, i])) } }];
  const app = createApp(t, saved);
  assert.equal(app.row('a.txt').querySelector('[data-result-source]').textContent, 'C:\\tmp');
  assert.equal(app.row('b.txt').classList.contains('search-group-start'), true);
  assert.equal(app.row('a.txt').draggable, false);
});

test('loading an older preset drops removed plugin filters and restores custom depth', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  respond(app, { type: 'search-presets', values: { saved: { name: '*.txt', depth: 250, pluginsEnabled: true, rules: [{ field: 'size', operator: '>', value: 12 }], sameFieldsEnabled: true, sameFields: ['name'] } } });
  app.key('Tab', { ctrlKey: true }); app.key('Tab', { ctrlKey: true }); app.click(dialog.querySelector('[data-preset-load]'));
  assert.equal(dialog.querySelector('[name=depth]').value, 'custom'); assert.equal(dialog.querySelector('[name=depthCustom]').value, '250');
  app.key('s', { altKey: true }); const settings = app.messages.find(m => m.type === 'search-start').settings;
  assert.equal(settings.pluginsEnabled, false); assert.equal(settings.rules.length, 0); assert.equal(settings.sameFields.length, 0); assert.equal(settings.depth, 250);
});

test('duplicate marking through older saved searches drops removed filters too', async t => {
  const app = createApp(t, fixture()), messages = [], row = { id: 'a', fsSource: 'C:/tmp/a.txt' };
  const search = app.window.CommanderFileSearch.create({ host: { postMessage: message => messages.push(message) }, context: () => ({ path: 'C:/tmp' }), t: value => value });
  t.after(() => search.dispose());
  const result = search.evaluatePreset('Saved', [row]);
  respond(app, { type: 'search-presets', values: { Saved: { name: '*', pluginsEnabled: true, rules: [{ field: 'size', operator: '>', value: 1 }], sameFields: ['name'] } } });
  await new Promise(resolve => setImmediate(resolve));
  const request = messages.find(message => message.type === 'search-start');
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [row] }); await result;
  assert.equal(request.settings.pluginsEnabled, false); assert.equal(request.settings.rules.length, 0); assert.equal(request.settings.sameFields.length, 0);
});

test('recoverable search errors leave the active worker cancellable', t => {
  const app = open(t); app.key('s', { altKey: true }); const request = app.messages.find(m => m.type === 'search-start');
  respond(app, { type: 'search-error', searchId: request.searchId, error: 'Cannot skip missing directory' });
  assert.match(app.document.querySelector('[data-search-status]').textContent, /Cannot skip/);
  assert.equal(app.document.querySelector('[data-search-start]').disabled, true);
  app.key('Escape'); assert.ok(app.messages.find(m => m.type === 'search-cancel'));
});

test('one conflict decision for all files remains active across mixed source groups', async t => {
  const saved = fixture(); saved.realFilesystem = false;
  const a = { id: 'a', name: 'a.txt', fsSource: 'C:/tmp/sub/a.txt', type: 'text', size: 1, content: 'new A' }, b = { ...a, id: 'b', name: 'b.txt', fsSource: 'C:/tmp/b.txt', content: 'new B' };
  saved.folders['C:/tmp'] = [b]; saved.folders['C:/tmp/sub'] = [a]; saved.folders['C:/temp'] = [{ ...a, id: 'old-a', content: 'old A' }, { ...b, id: 'old-b', content: 'old B' }]; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [a.fsSource, b.fsSource] } }];
  const app = createApp(t, saved); app.action('select-all'); app.action('copy'); app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await new Promise(resolve => setImmediate(resolve));
  app.click(app.document.querySelector('[data-conflict-action=overwrite-all]')); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelector('#modal').open, false); assert.deepEqual(app.state().folders['C:/temp'].map(row => row.content).sort(), ['new A', 'new B']);
});

test('mixed source transfer rejects invalid later source targets before copying the first group', t => {
  const saved = fixture(); saved.realFilesystem = false;
  const a = { id: 'a', name: 'a.txt', fsSource: 'C:/tmp/a.txt', type: 'text', content: 'A' }, folder = { id: 'nested', name: 'nested', fsSource: 'C:/tmp/other/nested', type: 'folder' };
  saved.folders['C:/tmp'] = [a]; saved.folders['C:/tmp/other'] = [folder]; saved.folders['C:/tmp/other/nested'] = []; saved.folders['C:/tmp/other/nested/child'] = []; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [a.fsSource, folder.fsSource] } }];
  const app = createApp(t, saved); app.action('select-all'); app.action('copy'); app.document.querySelector('#value').value = 'C:/tmp/other/nested/child'; app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(app.document.querySelector('#modal').open, true); assert.equal(app.state().folders['C:/tmp/other/nested/child'].length, 0);
});

test('a disposed duplicate preset request cannot launch a job after the template reply arrives', async t => {
  const saved = fixture(); const a = { id: 'a', name: 'a.txt', fsSource: 'C:/tmp/a.txt', type: 'text' }; saved.folders['C:/tmp'] = [a]; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [a.fsSource], groups: { [a.fsSource]: 0 } } }];
  const app = createApp(t, saved); app.action('search-duplicates'); app.document.querySelector('#duplicate-name').value = '>Saved'; app.click(app.document.querySelector('[data-duplicate-apply]'));
  respond(app, { type: 'restore', resetViews: true, state: fixture() }); respond(app, { type: 'search-presets', values: { Saved: { name: '*.txt', searchIn: '>' } } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.messages.some(message => message.type === 'search-start'), false);
});

test('Shift+F5 proposes the actual nested result path rather than the search root', t => {
  const saved = fixture(), row = { id: 'a', name: 'a.txt', type: 'text', fsSource: 'C:/tmp/sub/a.txt' }; saved.folders['C:/tmp/sub'] = [row]; saved.panes[0].cursor = 'a'; saved.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [row.fsSource] } }];
  const app = createApp(t, saved); app.key('F5', { shiftKey: true });
  assert.equal(app.document.querySelector('#value').value, 'C:\\tmp\\sub\\a.txt');
});

test('content options follow their enable switch and hex and regex are mutually exclusive', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  assert.equal(dialog.querySelector('[name=text]').disabled, true);
  app.key('t', { altKey: true }); assert.equal(dialog.querySelector('[name=text]').disabled, false);
  app.key('h', { altKey: true }); app.key('2', { altKey: true });
  assert.equal(dialog.querySelector('[name=hex]').checked, false); assert.equal(dialog.querySelector('[name=textRegex]').checked, true);
  app.click(dialog.querySelector('[name=textEnabled]')); assert.equal(dialog.querySelector('[name=textRegex]').disabled, true);
});

test('search paths display Windows separators and normalize inputs without per-result identity changes', t => {
  const app = open(t), dialog = app.document.querySelector('[data-file-search]');
  assert.equal(dialog.querySelector('[name=searchIn]').value, 'C:\\tmp');
  respond(app, { type: 'search-presets', histories: { searchIn: ['c:/tmp'] } });
  assert.equal(dialog.querySelector('[data-search-history="searchIn"] option').value, 'C:\\tmp');
  dialog.querySelector('[name=searchIn]').value = 'c:\\tmp; C:\\temp';
  app.key('Enter', {}, dialog.querySelector('[name=searchIn]'));
  const request = app.messages.find(message => message.type === 'search-start'); assert.ok(request);
  assert.equal(request.settings.searchIn, 'c:/tmp; C:/temp');
  respond(app, { type: 'search-progress', searchId: request.searchId, path: 'c:/tmp/sub', count: 1 });
  assert.match(dialog.querySelector('[data-search-status]').textContent, /C:\\tmp\\sub/);
  respond(app, { type: 'search-complete', searchId: request.searchId, results: [{ name: 'one.txt', fsSource: 'c:/tmp/one.txt' }] });
  assert.equal(dialog.querySelector('[data-search-result]').textContent, 'C:\\tmp\\one.txt');
});
