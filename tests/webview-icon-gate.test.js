const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('initial file manager icons and asynchronous icon changes pass the central output gate', t => {
  const pane = () => ({ tabs: ['/repo'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, realFilesystem: true, snapshotId: 'icon-gate', active: 0, panes: [pane(), pane()], folders: {
    '/repo': [{ id: 'd', name: 'folder', type: 'folder' }, { id: 'f', name: 'file.txt', type: 'text', hidden: true }]
  } };
  const app = createApp(t, state);
  assert.ok(app.document.querySelector('#modal-close [data-icon-reviewed="font:close"]'));
  function checked() {
    const icons = [...app.document.querySelectorAll('.codicon,.icon-font,.fileicon,svg')];
    assert.ok(icons.length > 10);
    for (const icon of icons) assert.ok(icon.dataset.iconReviewed, icon.outerHTML);
  }
  checked();
  const request = app.messages.find(message => message.type === 'git-status');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { ...request, type: 'git-status-result', directories: {
    '/repo': { ok: true, repository: true, branch: 'main', statuses: { 'file.txt': 'modified' } }
  } } }));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { '/repo/file.txt': 'data:image/png;base64,AAAA' } } }));
  checked();
  assert.ok(app.row('file.txt').querySelector('img.native-icon[data-icon-reviewed="native"]'));
});

test('search and preview close buttons use the same icon output as the main view', t => {
  const app = createApp(t);
  app.click(app.row('README.md')); app.key('F3');
  assert.ok(app.document.querySelector('[data-lister-close] [data-icon-reviewed="font:close"]'));
  app.key('Escape'); app.document.querySelector('.pane.active .list').focus(); app.key('F7', { altKey: true });
  assert.ok(app.document.querySelector('[data-search-close] [data-icon-reviewed="font:close"]'));
});
