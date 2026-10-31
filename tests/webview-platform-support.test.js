const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, cursor: 'a', selected: ['a'], filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'platform', panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'example.txt', type: 'text', size: 1, fsSource: '/left/example.txt' }], '/right': []
  } };
}

for (const language of ['de', 'en']) test(`${language} unsupported actions report only in the status bar when invoked`, t => {
  for (const [platform, action] of [['linux', 'clipboard-copy'], ['linux', 'clipboard-paste'], ['linux', 'shell-context-menu'], ['darwin', 'open-trash'], ['darwin', 'inspect-folder-locks']]) {
    const app = createApp(t, fixture(), { platform, language });
    const unsupported = language === 'de' ? /nicht unterstützt|nicht verfügbar/ : /not supported|unavailable/;
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, unsupported);
    const before = app.messages.length;
    app.action(action);
    assert.match(app.document.querySelector('#status-message').textContent, unsupported, `${platform}: ${action}`);
    assert.equal(app.document.querySelector('#status-message').dataset.outcome, 'info');
    assert.equal(app.document.querySelector('dialog[open]'), null);
    assert.deepEqual(app.messages.slice(before), []);
  }
});
