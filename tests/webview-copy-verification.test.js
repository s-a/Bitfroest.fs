const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, active: 0, snapshotId: 'verification', panes: [pane('C:/left'), pane('C:/right')], folders: {
    'C:/left': [{ id: 'file', name: 'file.bin', type: 'binary', size: 3, fsSource: 'C:/left/file.bin' }], 'C:/right': []
  } };
}
for (const mode of ['copy', 'move']) for (const enabled of [false, true]) test(`${mode} captures content verification ${enabled} from the persisted preference`, async t => {
  const app = createApp(t, fixture(), { fileSettings: { verifyAfterCopy: enabled } });
  app.click(app.row('file.bin').querySelector('[data-filename]')); app.action(mode);
  const checkbox = app.document.querySelector('#transfer-verify'); assert.ok(checkbox); assert.equal(checkbox.checked, enabled);
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(app.messages.find(message => message.type === 'filesystem-apply')?.transfer.verifyAfterCopy, enabled);
});
for (const language of ['de', 'en']) test(`content verification defaults off and a dialog change is retained for the next operation (${language})`, t => {
  const app = createApp(t, fixture(), { language });
  app.click(app.row('file.bin').querySelector('[data-filename]')); app.action('copy');
  const checkbox = app.document.querySelector('#transfer-verify'); assert.ok(checkbox); assert.equal(checkbox.checked, false);
  assert.match(checkbox.labels[0].textContent, language === 'de' ? /Dateiinhalt.*vergleichen/ : /Compare.*contents/);
  checkbox.checked = true; checkbox.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.messages.find(message => message.type === 'copy-verification-setting')?.enabled, true);
  app.click(app.document.querySelector('#modal-cancel')); app.action('copy');
  assert.equal(app.document.querySelector('#transfer-verify').checked, true);
  const next = app.document.querySelector('#transfer-verify'); next.checked = false; next.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.messages.filter(message => message.type === 'copy-verification-setting').at(-1).enabled, false);
});
