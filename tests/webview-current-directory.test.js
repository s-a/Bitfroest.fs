const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture(path = 'C:/base/current', empty = false) {
  const pane = directory => ({ tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, panes: [pane(path), pane('C:/other')], folders: {
    [path]: empty ? [] : [{ id: 'note', name: 'note.txt', type: 'text', size: 4 }],
    'C:/other': [], 'C:/base': []
  } };
}
const parentRow = app => app.document.querySelector('.pane.active [data-parent]');
const copies = app => app.messages.filter(message => message.type === 'selection-io');

test('the two-dot row can be selected and both path shortcuts copy the current directory', t => {
  const app = createApp(t, fixture(), { platform: 'win32' });
  app.click(app.row('note.txt'));
  app.click(parentRow(app).querySelector('.filename'));
  assert.equal(parentRow(app).querySelector('.filename').textContent, '..');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  assert.ok(parentRow(app).classList.contains('focused'));
  assert.equal(app.row('note.txt').getAttribute('aria-selected'), 'false');
  app.key('y', { ctrlKey: true });
  app.key('Y', { ctrlKey: true, shiftKey: true });
  assert.equal(copies(app).length, 2);
  for (const request of copies(app)) {
    assert.equal(request.text.replaceAll('\\', '/'), 'C:/base/current');
    assert.deepEqual(Array.from(request.pathRanges, range => ({ ...range })), [{ start: 0, length: request.text.length }]);
  }
  assert.equal(copies(app)[1].pathStyle, 'slash');
});

test('keyboard navigation reaches the symbolic row and Enter still navigates up', t => {
  const app = createApp(t, fixture());
  app.click(app.row('note.txt'));
  app.key('ArrowUp');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('ArrowDown');
  assert.ok(app.row('note.txt').classList.contains('focused'));
  app.key('Home');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('Enter');
  assert.equal(app.state().panes[0].tabs[0], 'C:/base');
});

test('an empty directory has a keyboard-selectable current-directory symbol', t => {
  const app = createApp(t, fixture('/empty', true), { platform: 'linux' });
  app.document.querySelector('.pane.active .list').focus();
  app.key('Home'); app.key('Y', { ctrlKey: true, shiftKey: true });
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  assert.equal(copies(app).at(-1)?.text, '/empty');
});

test('name and detail copies resolve the symbol to the current directory', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app));
  app.action('copy-names'); app.action('copy-full-details');
  assert.equal(copies(app)[0]?.text, 'current');
  assert.match(copies(app)[1]?.text || '', /C:.*base.*current/);
  assert.doesNotMatch(copies(app)[1]?.text || '', /\.\./);
});

test('select all excludes the symbolic directory and double-click retains parent navigation', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app)); app.action('select-all');
  assert.deepEqual(app.state().panes[0].selected, ['note']);
  parentRow(app).dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  assert.equal(app.state().panes[0].tabs[0], 'C:/base');
});

test('streamed directory updates preserve the selected symbol', t => {
  const initial = fixture(); initial.realFilesystem = true;
  const app = createApp(t, initial);
  app.action('new-tab'); app.click(parentRow(app));
  const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
  assert.ok(request);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: {
    type: 'filesystem-directory', navigationRequestId: request.navigationRequestId,
    path: 'C:/base/current', rows: [{ id: 'new', name: 'new.txt', type: 'text' }]
  } }));
  assert.ok(app.row('new.txt'));
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('y', { ctrlKey: true });
  assert.equal(copies(app).at(-1)?.text.replaceAll('\\', '/'), 'C:/base/current');
});

test('symbol selection remains local to its pane and survives tab restoration', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app)); app.action('new-tab');
  app.click(app.row('note.txt')); app.action('previous-tab');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'true');
  app.key('Tab');
  assert.equal(parentRow(app).getAttribute('aria-selected'), 'false');
  app.click(parentRow(app)); app.action('copy-full-names-slash');
  assert.equal(copies(app).at(-1)?.text.replaceAll('\\', '/'), 'C:/other');
});

test('root paths and text-input focus retain their exact path and shortcut boundary', t => {
  for (const directory of ['C:/', '/']) {
    const app = createApp(t, fixture(directory, true));
    app.click(parentRow(app)); app.action('copy-full-names-slash');
    assert.equal(copies(app).at(-1)?.text.replaceAll('\\', '/'), directory);
    const count = copies(app).length;
    app.document.querySelector('.pane.active .path-input').focus();
    app.key('y', { ctrlKey: true }); app.key('Y', { ctrlKey: true, shiftKey: true });
    assert.equal(copies(app).length, count);
  }
});

test('file drags exclude the symbolic entry from a mixed selection', t => {
  const app = createApp(t, fixture());
  app.click(parentRow(app)); app.click(app.row('note.txt'), { ctrlKey: true });
  const data = new Map();
  const event = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData: (key, value) => data.set(key, value), setDragImage() {} } });
  app.row('note.txt').dispatchEvent(event);
  const source = JSON.parse(data.get('application/x-bitfroest-files'));
  assert.deepEqual(source.ids, ['note']);
  assert.deepEqual(source.items.map(item => item.id), source.ids);
});
