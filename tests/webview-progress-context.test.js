const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture() {
  const p = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'progress-context', active: 0, panes: [p('/left'), p('/right')], folders: { '/left': [{ id: 'a', name: 'Quelle & Source.txt', type: 'text', size: 12, fsSource: '/left/Quelle & Source.txt' }], '/right': [] } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
async function start(app, mode, target) {
  app.action(mode);
  if (target) app.document.querySelector('#value').value = target;
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  return app.messages.find(message => message.type === 'filesystem-apply');
}

test('active progress keeps localized operation and literal source/final target independently of transient hints', async t => {
  for (const language of ['en', 'de']) for (const mode of ['copy', 'move']) {
    const app = createApp(t, fixture(), { language });
    const request = await start(app, mode, '/right/Final & Ziel.txt');
    assert.ok(request);
    app.document.querySelector('#toast').textContent = '';
    const title = app.document.querySelector('[data-progress-title]');
    assert.ok(title, 'operation label remains inside the active progress region');
    assert.equal(title.textContent, language === 'en' ? mode === 'move' ? 'Moving…' : 'Copying…' : mode === 'move' ? 'Verschieben läuft…' : 'Kopieren läuft…');
    assert.equal(app.document.querySelector('[data-progress-source]').textContent, '/left/Quelle & Source.txt');
    assert.equal(app.document.querySelector('[data-progress-target]').textContent, '/right/Final & Ziel.txt');
    assert.equal(app.document.querySelector('[data-progress-source] Source'), null, 'names remain text');
    send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { completedBytes: 3, totalBytes: 12 } });
    assert.equal(title.textContent.includes(language === 'en' ? 'ing' : 'läuft'), true);
    assert.equal(app.document.querySelector('[data-progress-count]').textContent, '3 B / 12 B');
    send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { phase: 'copying', path: '/left/Quelle & Source.txt', transferred: 3, total: 6, completedBytes: 3, totalBytes: 12 } });
    assert.equal(app.document.querySelectorAll('.transfer-progress [role="progressbar"]').length, 0, 'the details entry does not duplicate the footer track');
    assert.equal(app.document.querySelectorAll('#status-progress-area [role="progressbar"]').length, 2);
    assert.equal(app.document.querySelector('[data-current-file-count]').textContent, '3 B / 6 B');
    assert.equal(app.document.querySelector('[data-overall-count]').textContent, '3 B / 12 B');
    send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { phase: 'copying', path: '/left/next.txt', transferred: 1, total: 4, completedBytes: 7, totalBytes: 12 } });
    assert.equal(app.document.querySelector('[data-current-file-count]').textContent, '1 B / 4 B');
    assert.equal(app.document.querySelector('[data-overall-count]').textContent, '7 B / 12 B');
    app.click(app.document.querySelector('[data-cancel-transfer]'));
    assert.equal(app.document.querySelector('#status-progress-overall').getAttribute('aria-valuenow'), '7');
    assert.equal(app.document.querySelector('#status-progress-overall').getAttribute('aria-valuemax'), '12');
    assert.equal(app.document.querySelector('#status-progress-file').getAttribute('aria-valuenow'), '1');
    const before = app.document.querySelector('.transfer-progress').textContent;
    send(app, { type: 'filesystem-progress', operationId: 'foreign', progress: { completedBytes: 999, totalBytes: 999 } });
    assert.equal(app.document.querySelector('.transfer-progress').textContent, before);
    const cancel = app.document.querySelector('[data-cancel-transfer]'); app.click(cancel); app.click(cancel);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
    send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state: fixture(), operationOutcome: { cancelled: true, completedIds: [] } });
    send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { completedBytes: 12, totalBytes: 12 } });
    assert.equal(app.document.querySelector('.transfer-progress'), null);
  }
});

test('each active source group keeps all literal names and replaces its progress context after acknowledgement', async t => {
  const state = fixture();
  state.folders['/left'].push({ id: 'b', name: 'Very long name '.repeat(10) + '.txt', type: 'text', size: 4, fsSource: '/left/second' });
  state.panes[0].selected.push('b');
  const app = createApp(t, state);
  const request = await start(app, 'copy');
  assert.equal(app.document.querySelector('[data-progress-source]')?.textContent, state.folders['/left'].map(file => '/left/' + file.name).join('\n'));
  assert.equal(app.document.querySelector('[data-progress-source]').tabIndex, 0, 'long source lists can be scrolled with the keyboard');
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state: fixture() });
  await start(app, 'move', '/right/Other.txt');
  assert.equal(app.document.querySelector('[data-progress-target]').textContent, '/right/Other.txt');
  assert.equal(app.document.querySelector('[data-progress-source]').textContent, '/left/Quelle & Source.txt');
});

test('folder confirmation opens before source preparation begins', t => {
  const state = fixture(); state.folders['/left'] = [{ id: 'folder', name: 'docs', type: 'folder', size: 0, fsSource: '/left/docs' }];
  state.folders['/left/docs'] = []; state.unloadedFolders = ['/left/docs']; state.panes[0].selected = ['folder']; state.panes[0].cursor = 'folder';
  const app = createApp(t, state, { language: 'en' }); app.action('copy');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Copy');
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  app.document.querySelector('#value').value = '/right';
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('validation progress is identifiable and copying leaves the lists readable', async t => {
  const app = createApp(t, fixture(), { language: 'en' }), request = await start(app, 'copy');
  assert.equal(app.document.querySelector('#panes').inert, false);
  send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { phase: 'validating', filesScanned: 2 } });
  assert.equal(app.document.querySelector('[data-progress-title]').textContent, 'Checking files…');
  assert.match(app.document.querySelector('[data-progress-count]').textContent, /2/);
});

test('a transfer acknowledgement preserves folder tabs and active side changed while reading', async t => {
  const state = fixture(); state.panes[0].tabs.push('/other'); state.folders['/other'] = [{ id: 'other', name: 'Other.txt', type: 'text', size: 2 }];
  const app = createApp(t, state, { language: 'en' }), request = await start(app, 'copy');
  app.click(app.document.querySelector('[data-pane="0"] [data-tab="1"]'));
  app.click(app.document.querySelector('[data-pane="1"] .list'));
  const view = app.state(); assert.equal(view.panes[0].tab, 1); assert.equal(view.active, 1);
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state: request.state });
  assert.equal(app.state().panes[0].tab, 1); assert.equal(app.state().active, 1);
  assert.equal(app.document.querySelector('[data-pane="0"] .path-input').value, '/other');
});

test('individual folder preparation keeps cancellation inside its modal and settles the rename after acknowledgement', async t => {
  const state = fixture();
  state.folders['/left'] = [{ id: 'docs', name: 'docs', type: 'folder', size: 0, fsSource: '/left/docs' }];
  state.folders['/left/docs'] = [{ id: 'child', name: 'child.txt', type: 'text', size: 1, fsSource: '/left/docs/child.txt' }];
  state.folders['/right'] = [{ id: 'target', name: 'target', type: 'folder', size: 0, fsSource: '/right/target' }];
  state.folders['/right/target'] = []; state.unloadedFolders = ['/right/target']; state.panes[0].selected = ['docs']; state.panes[0].cursor = 'docs';
  const app = createApp(t, state, { language: 'en' }); app.action('copy');
  app.document.querySelector('#transfer-individual').checked = true;
  const submit = () => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await tick(); app.document.querySelector('#value').value = 'target'; submit(); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-prepare'); assert.ok(request);
  assert.ok(app.document.querySelector('.transfer-progress').closest('#modal-body'));
  assert.equal(app.document.querySelector('#value').disabled, true); assert.equal(app.document.querySelector('#modal-confirm').disabled, true);
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.at(-1).type, 'filesystem-cancel');
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, cancelled: true, state }); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.querySelector('.transfer-progress'), null);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.action('copy'); assert.equal(app.document.querySelector('#modal-title').textContent, 'Copy');
});

