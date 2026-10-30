const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const fixture = () => ({ version: 1, active: 0, panes: [{ tabs: ['/left'], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' }, { tabs: ['/right'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' }], folders: { '/left': [{ id: 'a', name: 'source.txt', type: 'text', content: 'keep' }], '/right': [] } });
test('documented copy and move keys select the target stem then the name including extension', t => {
  for (const [mode, key] of [['copy', 'F5'], ['move', 'F6']]) {
    const app = createApp(t, fixture()); app.action(mode);
    const input = app.document.querySelector('#value'); input.value = 'C:\\temp\\new.name.txt'; input.setSelectionRange(0, input.value.length);
    assert.equal(app.key(key, {}, input), false);
    assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'new.name');
    app.key(key, {}, input); assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'new.name.txt');
    assert.equal(app.state().folders['/left'][0].name, 'source.txt');
    assert.equal(app.document.querySelector('#modal').open, true);
  }
});
test('native name selection commands only affect the active transfer name field', t => {
  const app = createApp(t, fixture()); app.action('copy');
  const input = app.document.querySelector('#value'); input.value = '/right/target.txt'; input.setSelectionRange(0, input.value.length);
  const focus = app.messages.filter(item => item.type === 'inputFocus').at(-1); assert.equal(focus.transferName, true);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'action', action: 'transfer-name-parts', key: 'F5' } }));
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'target');
  const filter = app.document.querySelector('#transfer-filter'); filter.focus(); filter.setSelectionRange(0, 1);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'action', action: 'transfer-name-parts', key: 'F5' } }));
  assert.deepEqual([filter.selectionStart, filter.selectionEnd], [0, 1]);
  assert.equal(app.messages.filter(item => item.type === 'inputFocus').at(-1).transferName, false);
});
test('name selection leaves directory targets, unrelated fields and modified shortcuts unchanged', t => {
  const app = createApp(t, fixture()); app.action('copy');
  const input = app.document.querySelector('#value'); input.value = '/right'; input.setSelectionRange(1, 2);
  app.key('F5', {}, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2]);
  input.value = '/right/target.txt'; input.setSelectionRange(1, 2);
  app.key('F5', { ctrlKey: true }, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2]);
  app.click(app.document.querySelector('#modal-cancel')); app.action('mkdir');
  const folder = app.document.querySelector('#value'); folder.setSelectionRange(1, 2); app.key('F5', {}, folder);
  assert.deepEqual([folder.selectionStart, folder.selectionEnd], [1, 2]);
});
test('Ctrl Home positions the caret after the final path separator without modifying the target', t => {
  for (const [value, position] of [['C:\\temp\\target.txt', 8], ['C:/temp/target.txt', 8], ['C:\\temp/target.txt', 8], ['C:/temp/', 8], ['C:/', 3], ['/right', 1], ['target.txt', 0], ['', 0]]) {
    const app = createApp(t, fixture()); app.action('copy'); const input = app.document.querySelector('#value');
    input.value = value; input.setSelectionRange(value.length, value.length);
    assert.equal(app.key('Home', { ctrlKey: true }, input), false);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [position, position]); assert.equal(input.value, value);
  }
});
test('plain F5 and F6 in other file-dialog fields are consumed without a file action', t => {
  const app = createApp(t, fixture()); app.action('mkdir');
  const input = app.document.querySelector('#value'); input.value = 'Future'; const before = JSON.stringify(app.state().folders);
  for (const key of ['F5', 'F6']) assert.equal(app.key(key, {}, input), false);
  assert.equal(input.value, 'Future'); assert.equal(app.document.activeElement, input);
  assert.equal(app.key('c', { ctrlKey: true }, input), true);
  assert.equal(JSON.stringify(app.state().folders), before); assert.equal(app.document.querySelector('#modal').open, true);
});
test('inline rename text fields consume plain F5 and F6 while keeping normal text shortcuts', t => {
  const app = createApp(t, fixture()); app.action('rename-one'); const input = app.document.querySelector('.inline-rename');
  for (const key of ['F5', 'F6']) assert.equal(app.key(key, {}, input), false);
  assert.equal(app.messages.filter(item => item.type === 'inputFocus').at(-1).dialog, true);
  assert.equal(app.document.activeElement, input); assert.equal(app.key('v', { ctrlKey: true }, input), true);
});
