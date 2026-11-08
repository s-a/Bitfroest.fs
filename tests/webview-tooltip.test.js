const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

test('folder tab tooltip opens on the first hover event and uses the full path', t => {
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'tooltip', active: 0,
    panes: [{ tabs: ['/workspace/long-folder'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' }, { tabs: ['/other'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' }],
    folders: { '/workspace/long-folder': [], '/other': [] } });
  const tab = app.document.querySelector('[data-tab]');
  tab.dispatchEvent(new app.window.MouseEvent('pointerover', { bubbles: true }));
  const tooltip = app.document.querySelector('[role="tooltip"]');
  assert.ok(tooltip, 'tooltip is inserted during the initial hover event');
  assert.equal(tooltip.textContent, '/workspace/long-folder');
  assert.equal(tab.title, '', 'native delayed title tooltip is not used');
  assert.equal(tab.getAttribute('aria-describedby'), tooltip.id);
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /--vscode-editorHoverWidget-background/);
});

test('folder tab tooltip closes when the pointer leaves the tab', t => {
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'tooltip-close', active: 0,
    panes: [{ tabs: ['/alpha'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' }, { tabs: ['/other'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' }],
    folders: { '/alpha': [], '/other': [] } });
  const tab = app.document.querySelector('[data-tab]');
  tab.dispatchEvent(new app.window.MouseEvent('pointerover', { bubbles: true }));
  tab.dispatchEvent(new app.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: app.document.body }));
  assert.equal(app.document.querySelector('[role="tooltip"]'), null);
  assert.equal(tab.hasAttribute('aria-describedby'), false);
});
