const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

test('F7 creates multiple nested folders after validating the whole list', t => {
  const app = createApp(t);
  app.action('mkdir'); app.document.querySelector('#value').value = 'one\\two|three'; submit(app);
  const state = app.state();
  assert.ok(state.folders['/workspace/bitfroest/one/two']);
  assert.ok(state.folders['/workspace/bitfroest/three']);
  assert.equal(state.folders['/workspace/bitfroest/one'].filter(row => row.name === 'two').length, 1);
});

test('invalid multi-folder input does not create the valid first target', t => {
  const app = createApp(t);
  app.action('mkdir'); app.document.querySelector('#value').value = 'new|../escape'; submit(app);
  assert.equal(app.state().folders['/workspace/bitfroest/new'], undefined);
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('Shift F4 creates a file before opening it and batches do not open editors', t => {
  const app = createApp(t);
  app.key('F4', { shiftKey: true });
  assert.equal(app.document.querySelector('#modal').open, true);
  app.document.querySelector('#value').value = 'fresh.txt'; submit(app);
  assert.ok(app.state().folders['/workspace/bitfroest'].some(row => row.name === 'fresh.txt'));
  assert.equal(app.messages.at(-1).type, 'edit');
  const before = app.messages.filter(message => message.type === 'edit').length;
  app.action('new-file'); app.document.querySelector('#value').value = 'a.txt|b.txt'; submit(app);
  assert.equal(app.messages.filter(message => message.type === 'edit').length, before);
  assert.ok(app.state().folders['/workspace/bitfroest'].some(row => row.name === 'a.txt'));
});

test('a real single new file opens only after successful host creation', t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, active: 0, realFilesystem: true, snapshotId: 'before', panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, state);
  app.action('new-file'); app.document.querySelector('#value').value = 'fresh.txt'; submit(app);
  assert.equal(app.messages.some(message => message.type === 'edit'), false);
  const request = app.messages.find(message => message.type === 'filesystem-apply');
  assert.ok(request);
  const after = structuredClone(request.state); after.snapshotId = 'after'; after.folders['C:/tmp'][0].fsSource = 'C:/tmp/fresh.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: after } }));
  assert.equal(app.messages.at(-1).type, 'edit'); assert.equal(app.messages.at(-1).path, 'C:/tmp/fresh.txt');
});

test('F7 selects a newly created or already existing direct child folder', t => {
  for (const name of ['created-now', 'docs']) {
    const app = createApp(t);
    app.click(app.row('README.md').querySelector('[data-filename]'));
    app.action('mkdir'); app.document.querySelector('#value').value = name; submit(app);
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.equal(app.state().panes[0].cursor, app.row(name).dataset.id);
    assert.deepEqual(app.state().panes[0].selected, [app.row(name).dataset.id]);
  }
});

test('a failed real file creation restores the entered name and input focus', t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, active: 0, realFilesystem: true, snapshotId: 'before', panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, state, { language: 'en' });
  app.action('new-file'); app.document.querySelector('#value').value = 'my notes.txt'; submit(app);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state } }));
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#value').value, 'my notes.txt');
  assert.equal(app.document.activeElement, app.document.querySelector('#value'));
  assert.equal(app.messages.some(message => message.type === 'edit'), false);
});

test('opening a creation dialog cancels a delayed rename of the previously clicked filename', async t => {
  const app = createApp(t); let time = 1000; app.window.Date.now = () => time;
  const clickName = () => app.click(app.row('README.md').querySelector('[data-filename]'));
  clickName(); time += 700; clickName();
  app.action('mkdir');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(app.document.querySelector('.inline-rename'), null);
  assert.equal(app.document.activeElement, app.document.querySelector('#value'));
});

test('invalid creation names report localized errors without losing their entered value', t => {
  for (const language of ['en', 'de']) {
    const app = createApp(t, undefined, { language });
    app.action('new-file'); app.document.querySelector('#value').value = '../outside.txt'; submit(app);
    assert.match(app.document.querySelector('#toast').textContent, language === 'en' ? /Invalid name/ : /Ungültiger Name/);
    assert.equal(app.document.querySelector('#value').value, '../outside.txt');
    assert.equal(app.document.activeElement, app.document.querySelector('#value'));
  }
});
