const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const p = path => ({ tabs: [path], tab: 0, cursor: 'a', selected: [], filter: '', sort: 'name' });
  return { version: 1, active: 0, panes: [p('/left'), p('/right')], folders: { '/left': [
    { id: 'dir', name: 'docs.txt', type: 'folder' },
    { id: 'a', name: 'a.TXT', type: 'text', size: 12, date: '31.10.2026', attributes: '-a--' },
    { id: 'b', name: 'b.txt', type: 'text', size: 20 }, { id: 'c', name: 'c.bak', type: 'text' },
    { id: 'd', name: 'README', type: 'text' }
  ], '/right': [], '/left/docs.txt': [] } };
}
function submit(app, value) {
  app.document.querySelector('#value').value = value;
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
}
test('selection menu contains the fourteen reference commands and omits directory comparisons', t => {
  const app = createApp(t, fixture());
  const commands = [...app.document.querySelectorAll('[data-group="Markierung"][data-menu-action]')].map(row => row.dataset.menuAction);
  assert.deepEqual(commands, ['select-group', 'unselect-group', 'select-all', 'clear', 'invert', 'select-extension', 'save-selection', 'restore-selection', 'save-selection-file', 'load-selection-file', 'copy-names', 'copy-full-names', 'copy-details', 'copy-full-details']);
});
test('selection commands and keypad bindings use native focus contexts and localized settings', () => {
  const manifest = require('../package.json');
  for (const action of ['select-group', 'unselect-group', 'select-extension', 'save-selection', 'restore-selection', 'save-selection-file', 'load-selection-file', 'copy-names', 'copy-full-names', 'copy-details', 'copy-full-details']) {
    assert.ok(manifest.contributes.commands.some(command => command.command === `bitfroest.${action}`), action);
  }
  const bindings = manifest.contributes.keybindings.filter(binding => binding.key.includes('numpad_') && binding.command !== 'bitfroest.search-duplicates');
  assert.equal(bindings.length, 12);
  for (const binding of bindings) {
    assert.match(binding.when, /bitfroest.listFocus/); assert.match(binding.when, /!bitfroest.textInput/);
    assert.match(binding.when, /webviewFocus/); assert.match(binding.when, /activeWebviewPanelId == bitfroestPrototype/);
  }
  const setting = Object.assign({}, ...manifest.contributes.configuration.map(group => group.properties))['bitfroest.files.selectDirectories'];
  assert.equal(setting.default, true);
  for (const language of ['', '.de']) assert.equal(typeof require(`../package.nls${language}.json`)['files.selectDirectories.description'], 'string');
});
test('group masks add and remove matches while retaining cursor and the other pane', t => {
  const state = fixture(); state.panes[0].selected = ['c', 'dir'];
  const app = createApp(t, state), other = JSON.stringify(app.state().panes[1]);
  app.action('select-group'); submit(app, '*.*|*.bak');
  assert.deepEqual(app.state().panes[0].selected, ['c', 'dir', 'a', 'b', 'd']);
  assert.equal(app.state().panes[0].cursor, 'a');
  app.action('unselect-group'); submit(app, '*.txt');
  assert.deepEqual(app.state().panes[0].selected, ['c', 'd']);
  assert.equal(JSON.stringify(app.state().panes[1]), other);
});
test('regular expressions reject invalid input without closing the dialog or changing selection', t => {
  const app = createApp(t, fixture());
  app.action('select-group'); submit(app, '<[');
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.equal(app.document.querySelector('#modal').open, true);
  submit(app, '<^a\\.txt$');
  assert.deepEqual(app.state().panes[0].selected, ['a']);
});
test('extension selection uses the cursor and adds matching files without directories', t => {
  const state = fixture(); state.panes[0].selected = ['c'];
  const app = createApp(t, state); app.action('select-extension');
  assert.deepEqual(app.state().panes[0].selected, ['c', 'a', 'b']);
});
test('remember and restore retain a reusable name selection', t => {
  const app = createApp(t, fixture());
  app.action('select-extension'); app.action('save-selection'); app.action('clear'); app.action('restore-selection');
  assert.deepEqual(app.state().panes[0].selected, ['a', 'b']);
  app.action('clear'); app.action('restore-selection');
  assert.deepEqual(app.state().panes[0].selected, ['a', 'b']);
});
test('file operations remember the selection and restoration survives host entry replacement', t => {
  const app = createApp(t, fixture()); app.action('select-extension'); app.action('copy');
  app.click(app.document.querySelector('#modal-cancel')); app.action('clear'); app.action('restore-selection');
  assert.deepEqual(app.state().panes[0].selected, ['a', 'b']);
  const fresh = structuredClone(app.state()); fresh.realFilesystem = true;
  fresh.folders['/left'].forEach(row => { row.id = 'new-' + row.id; }); fresh.panes[0].selected = [];
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fresh } }));
  app.action('restore-selection'); assert.deepEqual(app.state().panes[0].selected, ['new-a', 'new-b']);
});
test('native selection commands do not change marks in dialogs or text fields', t => {
  const app = createApp(t, fixture()); app.action('select-group');
  for (const command of ['select-all', 'clear', 'invert', 'select-extension', 'restore-selection']) app.action(command);
  assert.deepEqual(app.state().panes[0].selected, []);
  app.click(app.document.querySelector('#modal-cancel')); app.action('path');
  app.action('select-all'); assert.deepEqual(app.state().panes[0].selected, []);
});
test('numeric keypad shortcuts are scoped to list focus and honor directory overrides', t => {
  const app = createApp(t, fixture(), { fileSettings: { selectDirectories: false } });
  app.key('a', { ctrlKey: true });
  assert.deepEqual(app.state().panes[0].selected, ['a', 'b', 'c', 'd']);
  app.key('-', { code: 'NumpadSubtract', ctrlKey: true });
  app.key('+', { code: 'NumpadAdd', shiftKey: true }); submit(app, '*.*');
  assert.ok(app.state().panes[0].selected.includes('dir'));
  app.action('select-group'); const input = app.document.querySelector('#value');
  const before = JSON.stringify(app.state()); app.key('*', { code: 'NumpadMultiply' }, input);
  assert.equal(JSON.stringify(app.state()), before);
});
test('text copy variants send displayed columns and paths in displayed order', t => {
  const app = createApp(t, fixture()); app.action('select-extension');
  for (const action of ['copy-names', 'copy-full-names', 'copy-details', 'copy-full-details']) {
    app.action(action); const request = app.messages.filter(m => m.type === 'selection-io').at(-1);
    assert.ok(request, action); assert.equal(request.action, 'copy');
    assert.match(request.text, action.includes('full') ? /^\/left\/a\.TXT/ : /^a\.TXT/);
    assert.equal(request.text.includes('\t'), action.includes('details'));
    assert.match(request.text, /\r\n/);
  }
});

test('full path copies identify only path cells for host resolution', t => {
  const app = createApp(t, fixture()); app.action('select-extension');
  for (const action of ['copy-full-names', 'copy-full-details']) {
    app.action(action);
    const request = app.messages.filter(m => m.type === 'selection-io').at(-1);
    assert.ok(Array.isArray(request.pathRanges));
    assert.deepEqual(Array.from(request.pathRanges, range => request.text.slice(range.start, range.start + range.length)), ['/left/a.TXT', '/left/b.txt']);
  }
});

test('Ctrl+Y invokes path text copy only from the file list', t => {
  const app = createApp(t, fixture()); app.key('y', { ctrlKey: true });
  const copied = app.messages.filter(m => m.type === 'selection-io');
  assert.equal(copied.length, 1); assert.equal(copied[0].text, '/left/a.TXT');
  assert.ok(copied[0].pathRanges.length);
  app.action('select-group'); app.key('y', { ctrlKey: true }, app.document.querySelector('#value'));
  assert.equal(app.messages.filter(m => m.type === 'selection-io').length, 1);
  const binding = require('../package.json').contributes.keybindings.find(item => item.key === 'ctrl+y' && item.command === 'bitfroest.copy-full-names');
  assert.ok(binding); assert.match(binding.when, /bitfroest.listFocus/); assert.match(binding.when, /!bitfroest.textInput/);
});
test('macOS uses Command+Y for the same list-scoped path copy', t => {
  const app = createApp(t, fixture(), { platform: 'darwin' }); app.key('y', { metaKey: true });
  assert.equal(app.messages.filter(m => m.type === 'selection-io').at(-1)?.text, '/left/a.TXT');
  const binding = require('../package.json').contributes.keybindings.find(item => item.command === 'bitfroest.copy-full-names' && item.key === 'ctrl+y');
  assert.equal(binding.mac, 'cmd+y');
});
test('detail export recognizes custom name fields and preserves arbitrary column identifiers', t => {
  const state = fixture();
  state.panes[0].columns = [
    { key: 'filename', label: 'Name', field: '[=file.fullname]', visible: true },
    { key: 'type', label: 'Bytes', field: '[=file.size]', visible: true },
    { key: 'hidden', label: 'Hidden', field: '[=file.ext]', visible: false }
  ];
  const app = createApp(t, state); app.action('copy-full-details');
  assert.equal(app.messages.filter(m => m.type === 'selection-io').at(-1)?.text, '/left/a.TXT\t12');
});
test('detail export copies the calculated folder size currently shown in the list', t => {
  const state = fixture(); state.panes[0].cursor = 'dir';
  const app = createApp(t, state); app.key(' '); app.action('copy-details');
  const text = app.messages.filter(m => m.type === 'selection-io').at(-1)?.text;
  assert.match(text, /^docs\.txt\t0 B\t/);
});
test('saved group filters retain configured content rules in the host request', async t => {
  const state = fixture(); state.folders['/left'].forEach(row => { row.fsSource = '/left/' + row.name; });
  const app = createApp(t, state); app.action('select-group'); submit(app, '>documents');
  const preset = { name: '*.txt', pluginsEnabled: true, rules: [{ field: 'size', operator: '>', value: 10 }], sameFieldsEnabled: true, sameFields: ['size'] };
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'search-presets', values: { documents: preset } } }));
  await new Promise(resolve => setImmediate(resolve));
  const request = app.messages.filter(m => m.type === 'search-start').at(-1); assert.ok(request);
  assert.equal(request.settings.pluginsEnabled, true); assert.deepEqual(JSON.parse(JSON.stringify(request.settings.rules)), preset.rules);
  assert.equal(request.settings.sameFieldsEnabled, true); assert.deepEqual(Array.from(request.settings.sameFields), ['size']);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'search-complete', searchId: request.searchId, results: [{ fsSource: '/left/b.txt' }] } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.state().panes[0].selected, ['b']);
});
test('numeric keypad uses the primary modifier on macOS and leaves unsupported combinations alone', t => {
  const app = createApp(t, fixture(), { platform: 'darwin' });
  app.key('+', { code: 'NumpadAdd', metaKey: true });
  assert.deepEqual(app.state().panes[0].selected, ['a', 'b']);
  app.key('-', { code: 'NumpadSubtract', metaKey: true });
  assert.deepEqual(app.state().panes[0].selected, []);
});
test('Ctrl+A selects all while Ctrl+Num+ and Alt+Num+ both select the cursor extension', t => {
  for (const modifier of ['ctrlKey', 'altKey']) {
    const app = createApp(t, fixture()); app.key('+', { code: 'NumpadAdd', [modifier]: true });
    assert.deepEqual(app.state().panes[0].selected, ['a', 'b']);
    app.action('clear'); app.key('a', { ctrlKey: true }); assert.equal(app.state().panes[0].selected.length, 5);
    app.action('clear'); app.key('+', { code: 'NumpadAdd', ctrlKey: true, shiftKey: true });
    assert.deepEqual(app.state().panes[0].selected, [], 'removed secondary Select All default must not remain active');
  }
  const bindings = require('../package.json').contributes.keybindings;
  assert.deepEqual(bindings.filter(item => item.command === 'bitfroest.select-all').map(item => item.key), ['ctrl+a']);
  assert.deepEqual(bindings.filter(item => item.command === 'bitfroest.select-extension').map(item => item.key), ['ctrl+numpad_add', 'alt+numpad_add']);
});
test('load selection ignores stale replies after list navigation and accepts valid current names', t => {
  const app = createApp(t, fixture()); app.action('load-selection-file');
  const request = app.messages.filter(m => m.type === 'selection-io').at(-1); assert.ok(request);
  const reply = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'selection-io-result', requestId: request.requestId, ok: true, text: 'b.txt\r\nmissing.txt', ...data } }));
  reply({}); assert.deepEqual(app.state().panes[0].selected, ['b']);
  app.action('load-selection-file'); const late = app.messages.filter(m => m.type === 'selection-io').at(-1);
  app.click(app.row('docs.txt')); app.key('Enter');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'selection-io-result', requestId: late.requestId, ok: true, text: 'a.TXT' } }));
  assert.deepEqual(app.state().panes[0].selected, []);
});
