const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const Progress = require('../media/commander-progress');
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: 'docs', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'progress', active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'docs', name: 'docs', type: 'folder', fsSource: '/left/docs' }, { id: 'a', name: 'a.txt', type: 'text', size: 12, fsSource: '/left/a.txt' }], '/left/docs': [], '/right': []
  } };
}
function app(t) {
  const view = createApp(t, fixture());
  const request = view.messages.find(message => message.type === 'git-status');
  send(view, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: Object.fromEntries(request.directories.map(path => [path, { ok: true, repository: false }])) });
  return view;
}
const percent = view => view.document.querySelector('#status-percent').textContent;

test('folder sizing displays measured directory progress and rejects a foreign operation', t => {
  const view = app(t); view.key(' ');
  const request = view.messages.find(message => message.type === 'folder-size'); assert.ok(request);
  const progress = Progress.event({ phase: 'folder-size', path: '/left/docs', overall: Progress.unknown('items', 3, 'enumerating'), current: Progress.known('items', 3, 5) });
  send(view, { ...request, type: 'folder-size-progress', progress });
  assert.equal(percent(view), '—/60%');
  send(view, { ...request, type: 'folder-size-progress', operationId: 'foreign', progress: Progress.event({ phase: 'folder-size', overall: Progress.known('items', 1, 1), current: Progress.known('items', 1, 1) }) });
  assert.equal(percent(view), '—/60%');
  send(view, { ...request, type: 'folder-size-result', path: '/wrong', ok: true, size: 0 });
  assert.equal(percent(view), '—/60%');
  assert.equal(view.document.querySelector('#status-metrics').hidden, false);
  send(view, { ...request, type: 'folder-size-result', ok: true, size: 12 });
  assert.equal(view.document.querySelector('#status-metrics').hidden, true);
});

test('delete progress is tied to the current request rather than an older delete callback', t => {
  const view = app(t); view.click(view.row('a.txt')); view.key('F8');
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = view.messages.find(message => message.type === 'filesystem-delete'); assert.ok(request);
  assert.equal(typeof request.operationId, 'string');
  const progress = Progress.event({ phase: 'deleting', path: '/left/a.txt', overall: Progress.known('items', 1, 1), current: Progress.known('items', 1, 1) });
  send(view, { type: 'filesystem-task-progress', operationId: 'old', progress });
  assert.equal(percent(view), '—/—');
  send(view, { type: 'filesystem-task-progress', operationId: request.operationId, progress });
  assert.equal(percent(view), '—/100%');
});

test('search forwards current file byte progress and clears it on completion', t => {
  const view = app(t); view.action('search'); view.click(view.document.querySelector('[data-search-start]'));
  const request = view.messages.find(message => message.type === 'search-start'); assert.ok(request);
  send(view, { type: 'search-progress', searchId: request.searchId, ...Progress.event({ phase: 'searching', path: '/left/a.txt', count: 0, overall: Progress.unknown('items', 2, 'enumerating'), current: Progress.known('bytes', 3, 12) }) });
  assert.equal(percent(view), '—/25%');
  send(view, { type: 'search-complete', searchId: request.searchId, results: [] });
  assert.equal(view.document.querySelector('#status-metrics').hidden, true);
});

test('host acknowledgments stay indeterminate until their matching response instead of inventing work progress', t => {
  const view = app(t); view.action('select-all'); view.action('copy-full-names');
  const request = view.messages.find(message => message.type === 'selection-io'); assert.ok(request);
  assert.equal(percent(view), '—/—');
  assert.match(view.document.querySelector('#status-activity').textContent, /Hostbestätigung/);
  send(view, { type: 'selection-io-result', requestId: request.requestId, ok: true });
  assert.equal(view.document.querySelector('#status-metrics').hidden, true);
  assert.equal(view.document.querySelector('#status-message').dataset.outcome, 'success');
});
