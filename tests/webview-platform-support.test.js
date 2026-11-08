const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, cursor: 'a', selected: ['a'], filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'platform', panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'example.txt', type: 'text', size: 1, fsSource: '/left/example.txt' }], '/right': []
  } };
}

for (const language of ['de', 'en']) test(`${language} unsupported actions are logged only when invoked`, async t => {
  for (const [platform, action] of [['linux', 'shell-context-menu'], ['darwin', 'open-trash'], ['darwin', 'inspect-folder-locks']]) {
    const app = createApp(t, fixture(), { platform, language });
    const unsupported = language === 'de' ? /nicht unterstützt|nicht verfügbar/ : /not supported|unavailable/;
    assert.doesNotMatch((await app.copyActivityLog()).currentMessage, unsupported);
    app.action(action);
    assert.match((await app.copyActivityLog()).currentMessage, unsupported, `${platform}: ${action}`);
    assert.equal((await app.copyActivityLog()).currentOutcome, 'info');
    assert.equal(app.document.querySelector('dialog[open]'), null);
    assert.equal(app.document.querySelector('#status-message').hidden, true);
  }
});
