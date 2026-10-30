const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: 'folder', filter: '', sort: 'name' });
  return { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': [{ id: 'b', name: 'b.txt', type: 'text' }, { id: 'a', name: 'a.txt', type: 'text' }, { id: 'folder', name: 'docs', type: 'folder' }], '/left/docs': [], '/right': [] } };
}
test('Insert toggles the current entry and advances in displayed order without changing other marks', t => {
  const app = createApp(t, fixture());
  app.key('Insert'); assert.deepEqual(app.state().panes[0].selected, ['folder']); assert.equal(app.state().panes[0].cursor, 'a');
  app.key('Insert'); assert.deepEqual(app.state().panes[0].selected, ['folder', 'a']); assert.equal(app.state().panes[0].cursor, 'b');
  app.click(app.row('a.txt'), { ctrlKey: true });
  app.key('Insert'); assert.ok(app.state().panes[0].selected.includes('a')); assert.equal(app.state().panes[0].cursor, 'b');
});
test('Insert handles the final entry, missing cursor and empty list without wrapping or invalid cursor', t => {
  const state = fixture(); state.panes[0].cursor = 'b'; state.panes[0].selected = ['b'];
  const app = createApp(t, state); app.key('Insert'); assert.deepEqual(app.state().panes[0].selected, []); assert.equal(app.state().panes[0].cursor, 'b');
  const missing = fixture(); missing.panes[0].cursor = null; const noCursor = createApp(t, missing); noCursor.key('Insert');
  assert.equal(noCursor.state().panes[0].cursor, null); assert.deepEqual(noCursor.state().panes[0].selected, []);
  const empty = fixture(); empty.folders['/left'] = []; empty.panes[0].cursor = null; const noFiles = createApp(t, empty); noFiles.key('Insert');
  assert.equal(noFiles.state().panes[0].cursor, null); assert.deepEqual(noFiles.state().panes[0].selected, []);
});
test('modified Insert and text or dialog focus retain their native behavior', t => {
  const app = createApp(t, fixture());
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) app.key('Insert', { [modifier]: true });
  assert.equal(app.state().panes[0].cursor, 'folder'); assert.deepEqual(app.state().panes[0].selected, []);
  app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); app.key('Insert', {}, input); app.action('toggle-selection-next');
  assert.equal(app.document.querySelector('.inline-rename'), input); assert.deepEqual(app.state().panes[0].selected, []);
  app.key('Escape', {}, input); app.action('mkdir'); app.key('Insert', {}, app.document.querySelector('#value')); app.action('toggle-selection-next');
  assert.equal(app.document.querySelector('#modal').open, true); assert.deepEqual(app.state().panes[0].selected, []);
  assert.equal(app.messages.some(item => ['filesystem-apply', 'filesystem-delete'].includes(item.type)), false);
});
