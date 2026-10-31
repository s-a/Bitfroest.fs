const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture(directory = 'c:/git/zwork/gb-src-mirror/node-rpt') {
  const pane = () => ({ tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'paths', active: 0, panes: [pane(), pane()], folders: { [directory]: [] } };
}
test('Windows address and tab tooltip use native separators without changing stored path identity', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  assert.equal(app.document.querySelector('.path-input').value, 'C:\\git\\zwork\\gb-src-mirror\\node-rpt');
  assert.match(app.document.querySelector('[data-tab]').title, /^C:\\git\\zwork\\gb-src-mirror\\node-rpt/);
  assert.equal(app.state().panes[0].tabs[0], 'c:/git/zwork/gb-src-mirror/node-rpt');
});
test('typed Windows paths accept quotes, mixed separators and relative parent segments', t => {
  for (const value of ['"C:\\git/zwork\\other"', '..\\..\\other']) {
    const app = createApp(t, fixture(), { platform: 'win32' });
    const input = app.document.querySelector('.path-input'); input.focus(); input.value = value; app.key('Enter', {}, input);
    const request = app.messages.find(message => message.type === 'filesystem-navigate');
    assert.ok(request); assert.equal(request.path.toLowerCase(), 'c:/git/zwork/other');
  }
});
test('up navigation stops at Windows drive and UNC share roots', t => {
  for (const directory of ['C:/', '//server/share']) {
    const app = createApp(t, fixture(directory), { platform: 'win32' });
    app.key('Backspace', {}, app.document.querySelector('.pane.active .list'));
    assert.equal(app.state().panes[0].tabs[0], directory);
    assert.equal(app.messages.some(message => message.type === 'filesystem-navigate'), false);
  }
});

test('transfer dialog presents Windows source and target paths in native notation', t => {
  const state = fixture(), source = state.panes[0].tabs[0];
  state.folders[source] = [{ id: 'file', name: 'a.txt', type: 'text', size: 1, fsSource: source + '/a.txt' }];
  state.panes[0].selected = ['file']; state.panes[0].cursor = 'file';
  state.panes[1].tabs = ['d:/target']; state.folders['d:/target'] = [];
  const app = createApp(t, state, { platform: 'win32' }); app.action('copy');
  assert.equal(app.document.querySelector('#value').value, 'D:\\target');
  assert.equal(app.document.querySelector('[data-transfer-source]').textContent, 'C:\\git\\zwork\\gb-src-mirror\\node-rpt');
});

test('readable archive addresses retain archive identity across separator and drive-case changes', t => {
  const state = fixture(), key = 'zip:C%3A%2Ftmp%2Fsample.zip!';
  state.folders[key] = []; state.archiveLocations = { [key]: { archive: 'C:/tmp/sample.zip', parent: 'C:/tmp' } };
  const app = createApp(t, state, { platform: 'win32' });
  const input = app.document.querySelector('.path-input'); input.value = 'c:/tmp/sample.zip!'; app.key('Enter', {}, input);
  assert.equal(app.state().panes[0].tabs[0], key);
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate'), false);
});

test('packing into an archive retains its subdirectory when display uppercases the drive letter', t => {
  const state = fixture(), source = state.panes[0].tabs[0], archive = 'c:/temp/target.zip', target = 'zip:c%3A%2Ftemp%2Ftarget.zip!/nested';
  state.folders[source] = [{ id: 'file', name: 'a.txt', type: 'text', size: 1, fsSource: source + '/a.txt' }];
  state.panes[0].selected = ['file']; state.panes[0].cursor = 'file'; state.panes[1].tabs = [target]; state.folders[target] = [];
  state.archiveLocations = { [target]: { archive, entry: 'nested', parent: 'zip:c%3A%2Ftemp%2Ftarget.zip!' } };
  const app = createApp(t, state, { platform: 'win32' }); app.action('pack');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(app.messages.find(message => message.type === 'zip-write')?.path, target);
});

test('relative address input inside an archive resolves against its readable location', t => {
  const state = fixture(), root = 'zip:C%3A%2Ftmp%2Fsample.zip!', child = root + '/nested';
  state.panes[0].tabs = [child]; state.folders[root] = []; state.folders[child] = [];
  state.archiveLocations = { [root]: { archive: 'C:/tmp/sample.zip', parent: 'C:/tmp' }, [child]: { archive: 'C:/tmp/sample.zip', parent: root } };
  const app = createApp(t, state, { platform: 'win32' });
  const input = app.document.querySelector('.path-input'); input.value = '..'; app.key('Enter', {}, input);
  assert.equal(app.state().panes[0].tabs[0], root);
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate'), false);
});
