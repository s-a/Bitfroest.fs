const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function copying(t) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const state = { version: 1, active: 0, realFilesystem: true, snapshotId: 'copy-viewer', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', size: 12, fsSource: 'C:/tmp/a.txt' }, { id: 'b', name: 'b.txt', type: 'text', size: 24, fsSource: 'C:/tmp/b.txt' }], 'C:/tmp/loaded': [], 'C:/tmp/unloaded': [], 'C:/temp': [] }, unloadedFolders: ['C:/tmp/unloaded'] };
  state.panes[0].tabs.push('C:/tmp/loaded', 'C:/tmp/unloaded'); state.panes[0].selected = ['a']; state.panes[0].cursor = 'a';
  const app = createApp(t, state); app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
  return app;
}

test('copying keeps selection commands and loaded folder tabs usable without starting another filesystem operation', async t => {
  const app = await copying(t);
  app.action('select-all'); assert.deepEqual(Array.from(app.state().panes[0].selected), ['a', 'b']);
  app.action('next-tab'); assert.equal(app.state().panes[0].tab, 1);
  app.action('next-tab'); assert.equal(app.state().panes[0].tab, 1, 'an unloaded tab cannot start a concurrent navigation request');
  app.click(app.document.querySelector('[data-pane="0"] [data-tab="0"]'));
  assert.equal(app.state().panes[0].tab, 0);
  app.click(app.document.querySelector('[data-pane="0"] [data-tab="2"]'));
  assert.equal(app.state().panes[0].tab, 0);
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
  assert.equal(app.messages.some(message => ['filesystem-navigate', 'filesystem-prepare'].includes(message.type)), false);
});

test('reading during copying cannot enter inline rename or start a second drop transfer', async t => {
  const app = await copying(t), list = app.document.querySelector('.pane.active .list');
  app.key('F6', { shiftKey: true }, list); assert.equal(app.document.querySelector('.inline-rename'), null);
  function drag(type, target) { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { setData() {} } }); target.dispatchEvent(event); }
  drag('dragstart', app.row('a.txt')); drag('drop', app.document.querySelector('[data-pane="1"] .list'));
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
});
