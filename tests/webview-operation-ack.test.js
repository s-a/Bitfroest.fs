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
    else { assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /copied|moved|Copying|Moving/i); assert.ok(app.document.querySelector('.operation-error-text').value.endsWith('Blocked')); }
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
    reply(app, { ok: false, state: original, error, diagnostic: { request: { type: 'filesystem-navigate', path: 'C:/tmp', side: 0, operationId: 'scan-42', snapshotId: 'before' }, panelPaths: ['C:/tmp', 'C:/temp'], platform: 'win32', extensionVersion: '0.0.28', vscodeVersion: '1.105.0', runtimeVersion: 'v22.0.0', timestamp: '2026-10-31T11:00:00.000Z', architecture: 'x64', osRelease: '10.0.26200', failure: { name: 'Error', code: 'FolderChangedDuringScan', path: 'C:/tmp', scanPhase: 'readdir', stack: 'Error: scan failed\n at scan (filesystem-provider.js:10)', cause: { name: 'Error', message: 'A folder changed during the scan.', code: 'ESTALE', path: 'C:/tmp', scanPhase: 'stat', stack: 'Error: stale\n at stat (filesystem-provider.js:4)', cause: { name: 'Error', code: 'EIO', message: 'Underlying read failed.' } } } } });
    const button = app.document.querySelector('[data-copy-error]');
    assert.ok(button);
    const area = app.document.querySelector('.operation-error');
    const image = area.querySelector('img');
    assert.ok(image, 'error illustration is present');
    assert.equal(image.getAttribute('alt'), '');
    assert.ok(area.querySelector('.operation-error-intro').textContent.includes(language === 'de' ? 'Es ist ein unvorhergesehener Fehler aufgetreten.' : 'An unexpected error has occurred.'));
    const disclosure = area.querySelector('details');
    assert.equal(disclosure.open, false);
    assert.equal(disclosure.querySelector('summary').textContent, language === 'de' ? 'Details' : 'Details');
    assert.equal(disclosure.querySelector('h3').textContent, language === 'de' ? 'Details für Computer-Nerds' : 'Details for computer nerds');
    assert.equal(button.closest('details'), null, 'copy remains available with collapsed details');
    assert.ok(disclosure.querySelector('.operation-error-text'));
    app.click(disclosure.querySelector('summary'));
    assert.equal(disclosure.open, true);
    app.click(disclosure.querySelector('summary'));
    assert.equal(disclosure.open, false);
    assert.equal(button.textContent, language === 'de' ? 'Fehlerdetails kopieren' : 'Copy error details');
    app.click(button);
    const request = app.messages.find(message => message.type === 'selection-io');
    assert.equal(request.action, 'copy');
    assert.match(request.text, /filesystem-navigate/);
    assert.match(request.text, /C:\/tmp/);
    assert.match(request.text, /FolderChangedDuringScan/);
    assert.match(request.text, /Scan[- ]phase: readdir/i);
    assert.match(request.text, /filesystem-provider\.js/);
    assert.match(request.text, /ESTALE/);
    assert.match(request.text, /EIO/);
    assert.match(request.text, /C:\/temp/);
    assert.match(request.text, /scan-42/);
    assert.match(request.text, /10\.0\.26200/);
    assert.ok(request.text.endsWith(error));
    assert.equal(request.pathRanges, undefined);
    const visibleReport = app.document.querySelector('.operation-error-text').value;
    assert.equal(visibleReport, request.text);
    assert.match(visibleReport, /FolderChangedDuringScan/);
    assert.equal(disclosure.open, false, 'copy does not expand details');
    app.click(disclosure.querySelector('summary'));
    app.click(disclosure.querySelector('[data-select-error]'));
    assert.equal(app.document.activeElement, disclosure.querySelector('textarea'));
    assert.equal(disclosure.querySelector('textarea').selectionEnd, visibleReport.length);
    assert.equal(app.key('F5', {}, disclosure.querySelector('textarea')), false);
    assert.equal(app.key('F6', {}, disclosure.querySelector('textarea')), false);
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'selection-io-result', requestId: request.requestId, ok: false, error: 'Clipboard blocked' } }));
    assert.equal(app.document.querySelector('.operation-error-text').value, visibleReport);
    app.click(button);
    const retry = app.messages.filter(message => message.type === 'selection-io').at(-1);
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'selection-io-result', requestId: retry.requestId, ok: true } }));
    assert.equal(app.document.querySelector('.operation-error-text').value, visibleReport);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
  }
});

test('illustrated error disclosure preserves dialog input and dismisses standalone errors', t => {
  const app = createApp(t, fixture());
  app.action('mkdir');
  app.document.querySelector('#value').value = 'Keep this input'; submit(app);
  reply(app, { ok: false, state: fixture(), error: '<script>unsafe</script>' });
  const input = app.document.querySelector('#value');
  const area = app.document.querySelector('.operation-error');
  assert.equal(app.document.activeElement, input);
  assert.equal(input.value, 'Keep this input');
  assert.equal(area.querySelector('script'), null);
  app.click(area.querySelector('summary'));
  assert.equal(input.value, 'Keep this input');
  app.click(area.querySelector('[data-dismiss-error]'));
  assert.equal(app.document.querySelector('.operation-error'), null);
  assert.equal(app.document.activeElement, input);
  app.click(app.document.querySelector('#modal-cancel'));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'open-trash-result', ok: false, error: 'Unavailable' } }));
  assert.equal(app.document.querySelector('.operation-error details').open, false);
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.querySelector('.operation-error'), null);
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
