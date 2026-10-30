const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'original', active: 0, panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'source.txt', type: 'text', fsSource: 'C:/tmp/source.txt', content: 'keep' }], 'C:/temp': [] } };
}
test('theme and font changes preserve inline input, caret, focus and recovery without filesystem writes', async t => {
  for (const recovery of [false, true]) {
    const original = fixture(), icons = { base: { fileExtensions: { txt: 'dark-text' } }, light: { fileExtensions: { txt: 'light-text' } } };
    const app = createApp(t, structuredClone(original), { icons }); app.action('rename-one');
    let input = app.document.querySelector('.inline-rename'); input.value = 'My proposal.txt';
    if (recovery) {
      app.key('Enter', {}, input);
      app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: original, error: 'Access denied' } }));
      input = app.document.querySelector('.inline-rename');
    }
    input.setSelectionRange(2, 7); const writes = app.messages.filter(item => item.type === 'filesystem-apply').length;
    app.document.body.className = 'vscode-light';
    app.document.body.style.setProperty('--vscode-list-filterMatchBackground', '#ffffff');
    app.document.documentElement.style.setProperty('--vscode-font-size', '17px');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.document.querySelector('.inline-rename'), input);
    assert.equal(input.value, 'My proposal.txt'); assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7]);
    assert.equal(app.document.activeElement, input);
    assert.equal(app.messages.filter(item => item.type === 'filesystem-apply').length, writes);
    assert.ok(app.row('source.txt').querySelector('.light-text'));
    assert.equal(app.document.querySelector('#panes').style.getPropertyValue('--match-foreground'), '#000000');
    if (recovery) assert.equal(app.document.querySelector('.operation-error-text').value, 'Access denied');
  }
});
