const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

for (const side of [0, 1]) test(`navigation in panel ${side} does not update the opposite file grid`, t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const app = createApp(t, { version: 1, active: side, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'left-dir', name: 'child', type: 'folder' }, { id: 'left-file', name: 'left.txt', type: 'text' }],
    '/right': [{ id: 'right-dir', name: 'child', type: 'folder' }, { id: 'right-file', name: 'right.txt', type: 'text' }],
    '/left/child': [{ id: 'nested-left', name: 'nested-left.txt', type: 'text' }],
    '/right/child': [{ id: 'nested-right', name: 'nested-right.txt', type: 'text' }]
  } });
  const opposite = app.document.querySelector(`[data-pane="${1 - side}"] .list`);
  const observer = new app.window.MutationObserver(() => {});
  observer.observe(opposite, { subtree: true, childList: true });
  t.after(() => observer.disconnect());
  app.click(app.row('child').querySelector('[data-filename]'));
  observer.takeRecords();
  app.key('Enter');
  assert.ok(app.row(`nested-${side ? 'right' : 'left'}.txt`));
  assert.equal(observer.takeRecords().length, 0, 'the opposite file list must not be rendered again');
  assert.equal(app.document.querySelector(`[data-pane="${1 - side}"] .list`), opposite);
});

for (const side of [0, 1]) test(`streamed navigation in panel ${side} preserves both lists through host completion`, t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const root = side ? '/right' : '/left', target = `${root}/child`, other = side ? '/left' : '/right';
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'initial', active: side,
    panes: [pane('/left'), pane('/right')], folders: {
      [root]: [{ id: 'dir', name: 'child', type: 'folder', fsSource: target }],
      [target]: [{ id: 'cached', name: 'cached.txt', type: 'text' }],
      [other]: [{ id: 'keep', name: 'keep.txt', type: 'text' }]
    } });
  const opposite = app.document.querySelector(`[data-pane="${1 - side}"] .list`);
  const retained = opposite.querySelector('[data-id="keep"]');
  const observer = new app.window.MutationObserver(() => {});
  observer.observe(opposite, { subtree: true, childList: true });
  t.after(() => observer.disconnect());
  const unchanged = () => {
    assert.equal(observer.takeRecords().length, 0, 'unrelated list content must remain unchanged');
    assert.equal(opposite.querySelector('[data-id="keep"]'), retained);
    assert.ok(retained.querySelector('[data-filename]'));
    for (const section of app.document.querySelectorAll('.pane')) {
      assert.ok(section.querySelector('.list [data-sort="name"]'), 'the column heading must remain present');
      assert.ok(section.querySelector('.list [data-parent]'), 'the directory table must remain present');
    }
  };
  app.click(app.row('child').querySelector('[data-filename]')); observer.takeRecords(); app.key('Enter');
  unchanged(); assert.ok(app.row('cached.txt'));
  const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
  assert.equal(request.path, target); assert.equal(request.side, side);
  const send = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  send({ type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: target,
    names: ['cached.txt', 'fresh.txt'], rows: [] });
  unchanged(); assert.ok(app.row('cached.txt'));
  const fresh = { id: 'fresh', name: 'fresh.txt', type: 'text', size: 7 };
  send({ type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: target, rows: [fresh] });
  unchanged(); assert.ok(app.row('fresh.txt'));
  const state = app.state(); state.snapshotId = 'completed'; state.folders[target].push(fresh);
  send({ type: 'filesystem-result', ok: true, navigationRequestId: request.navigationRequestId, state });
  unchanged(); assert.ok(app.row('fresh.txt')); assert.ok(app.row('cached.txt'));
  assert.equal(app.document.querySelector(`[data-pane="${side}"]`).dataset.directory, target);
});
