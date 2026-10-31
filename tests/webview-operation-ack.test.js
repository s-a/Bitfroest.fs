const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'before', active: 0, panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'source.txt', type: 'text', fsSource: 'C:/tmp/source.txt', content: 'keep' }], 'C:/temp': [] } };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
const reply = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ...data } }));
test('real folder and file creation report success only after successful host acknowledgement', t => {
  for (const [kind, name, expected] of [['mkdir', 'Future', 'Folder created'], ['mkdir', 'one|two', 'Folders created'], ['new-file', 'one.txt|two.txt', 'Files created'], ['new-file', 'single.txt', 'File system updated']]) {
    const app = createApp(t, fixture(), { language: 'en' }); app.action(kind); app.document.querySelector('#value').value = name; submit(app);
    const request = app.messages.find(item => item.type === 'filesystem-apply'); assert.ok(request);
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /created/i);
    assert.match(app.document.querySelector('#status-message').textContent, /progress|Creating|running/i);
    assert.equal(app.messages.some(item => item.type === 'edit'), false);
    reply(app, { ok: true, state: structuredClone(request.state) });
    if (expected === 'File system updated') {
      assert.match(app.document.querySelector('#status-message').textContent, /Action in progress/);
      assert.equal(app.messages.filter(item => item.type === 'edit').length, 1);
      const edit = app.messages.find(item => item.type === 'edit');
      assert.match(edit.requestId, /^ui-action-/);
      app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'ui-action-result', requestId: edit.requestId, ok: true } }));
      assert.match(app.document.querySelector('#status-message').textContent, /opened for editing/i);
    } else assert.equal(app.document.querySelector('#status-message').textContent, expected);
  }
});
test('copy and move feedback stays pending until the host confirms either success or failure', async t => {
  for (const mode of ['copy', 'move']) for (const ok of [false, true]) {
    const original = fixture(), app = createApp(t, structuredClone(original), { language: 'en' }); app.action(mode); submit(app);
    await new Promise(resolve => setImmediate(resolve));
    const request = app.messages.find(item => item.type === 'filesystem-apply'); assert.ok(request);
    assert.match(app.document.querySelector('#status-message').textContent, /Copying|Moving/);
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /copied|moved/i);
    reply(app, { ok, state: ok ? structuredClone(request.state) : original, error: ok ? undefined : 'Blocked' });
    if (ok) assert.match(app.document.querySelector('#status-message').textContent, mode === 'copy' ? /copied/ : /moved/);
    else { assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /copied|moved|Copying|Moving/i); assert.equal(app.document.querySelector('.operation-error-text').value, 'Blocked'); }
  }
});
test('failed real creation keeps the original input and cannot leave a premature success message', t => {
  for (const kind of ['mkdir', 'new-file']) {
    const original = fixture(), app = createApp(t, structuredClone(original), { language: 'en' }); app.action(kind);
    const name = kind === 'mkdir' ? 'Future' : 'one.txt|two.txt'; app.document.querySelector('#value').value = name; submit(app);
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /created/i);
    reply(app, { ok: false, state: original, error: 'Write blocked' });
    assert.equal(app.document.querySelector('#value').value, name); assert.equal(app.document.activeElement, app.document.querySelector('#value'));
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /created|progress|running/i);
    assert.match(app.document.querySelector('.operation-error-text').value, /Write blocked/);
    assert.equal(app.messages.some(item => item.type === 'edit'), false);
  }
});
test('real inline rename and deletion replace old success feedback with an in-progress status', t => {
  for (const kind of ['rename-one', 'delete']) {
    const original = fixture(), app = createApp(t, structuredClone(original), { language: 'en' });
    app.document.querySelector('#status-message').textContent = 'Folder created'; app.action(kind);
    if (kind === 'rename-one') { const input = app.document.querySelector('.inline-rename'); input.value = 'renamed.txt'; app.key('Enter', {}, input); }
    else submit(app);
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /created|updated/i);
    assert.match(app.document.querySelector('#status-message').textContent, /progress|running|Deleting/i);
    reply(app, { ok: false, state: original, error: 'Operation blocked' });
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /created|updated|progress|running|Deleting/i);
  }
});
test('error copy preserves full details and recovery paths in every error presentation', async t => {
  for (const language of ['de', 'en']) for (const kind of ['copy', 'mkdir', 'rename-one']) {
    const original = fixture(), app = createApp(t, structuredClone(original), { language });
    const error = "EPERM: operation not permitted, lstat 'C:\\DumpStack.log.tmp'\nC:\\Recovery\\Ä <backup>.stage\n" + 'details '.repeat(200);
    app.action(kind);
    if (kind === 'rename-one') {
      app.document.querySelector('.inline-rename').value = 'renamed.txt';
      app.key('Enter', {}, app.document.querySelector('.inline-rename'));
    } else { if (kind === 'mkdir') app.document.querySelector('#value').value = 'new'; submit(app); }
    await new Promise(resolve => setImmediate(resolve));
    reply(app, { ok: false, state: original, error });
    const button = app.document.querySelector('[data-copy-error]');
    assert.ok(button);
    assert.equal(button.textContent, language === 'de' ? 'Fehlerdetails kopieren' : 'Copy error details');
    app.click(button);
    const request = app.messages.find(message => message.type === 'selection-io');
    assert.equal(request.action, 'copy');
    assert.equal(request.text, (language === 'de' ? 'Dateioperation fehlgeschlagen' : 'File operation failed') + '\n\n' + error);
    assert.equal(request.pathRanges, undefined);
    assert.equal(app.document.querySelector('.operation-error-text').value, error);
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'selection-io-result', requestId: request.requestId, ok: false, error: 'Clipboard blocked' } }));
    assert.equal(app.document.querySelector('.operation-error-text').value, error);
    app.click(button);
    const retry = app.messages.filter(message => message.type === 'selection-io').at(-1);
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'selection-io-result', requestId: retry.requestId, ok: true } }));
    assert.equal(app.document.querySelector('.operation-error-text').value, error);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
  }
});

test('real batch rename success feedback is host-gated and never labelled as sample data', t => {
  const app = createApp(t, fixture(), { language: 'en' }); app.action('rename');
  app.document.querySelector('#mask').value = '[N]-new'; submit(app);
  const request = app.messages.find(item => item.type === 'filesystem-apply'); assert.ok(request);
  assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /renamed|sample/i);
  assert.match(app.document.querySelector('#status-message').textContent, /progress/i);
  reply(app, { ok: true, state: structuredClone(request.state) });
  assert.match(app.document.querySelector('#status-message').textContent, /renamed/i);
  assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /sample/i);
});
