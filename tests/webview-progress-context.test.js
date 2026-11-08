const test = require('node:test');
const assert = require('node:assert/strict');
const Progress = require('../media/bitfroest-progress');
const { createApp, confirmFixtureTransfer } = require('./support/webview.cjs');

function fixture() {
  const p = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'progress-context', active: 0, panes: [p('/left'), p('/right')], folders: { '/left': [{ id: 'a', name: 'Quelle & Source.txt', type: 'text', size: 12, fsSource: '/left/Quelle & Source.txt' }], '/right': [] } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));

test('move preparation keeps scanned target entries out of the current-file status', async t => {
  const saved = fixture();
  saved.unloadedFolders = ['/right'];
  const app = createApp(t, saved, { language: 'en' });
  await start(app, 'move');
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  assert.ok(prepare);
  send(app, { type: 'filesystem-progress', operationId: prepare.operationId, progress: Progress.event({
    phase: 'preparing', path: '/right/unrelated.txt', filesScanned: 1,
    overall: Progress.unknown('items', 1, 'enumerating'), current: Progress.known('items', 1, 2)
  }) });
  assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /unrelated\.txt/);
  assert.equal(app.document.querySelector('[data-current-file-path]').hasAttribute('value'), false);
  const ready = structuredClone(saved); ready.unloadedFolders = [];
  send(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: ready });
  await tick();
  const move = app.messages.find(message => message.type === 'filesystem-apply');
  send(app, { type: 'filesystem-transfer-progress', operationId: move.operationId, progress: Progress.transferBatch({
    phase: 'copying', path: '/right/Renamed.txt', sourcePath: '/left/Quelle & Source.txt', batch: Progress.batchBytes(6, 12), file: Progress.fileBytes(6, 12)
  }) });
  assert.match(app.document.querySelector('#status-message').textContent, /Quelle & Source\.txt/);
  assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /Renamed\.txt/);
});

test('move acknowledgements leave unchanged tables mounted and keep the changed table widths', { timeout: 5000 }, async t => {
  const saved = fixture();
  saved.folders['/favorite'] = [];
  saved.unloadedFolders = ['/favorite'];
  saved.panes[1].selected = [];
  saved.panes[1].cursor = null;
  const app = createApp(t, saved);
  await Promise.all([0, 1].map(side => new Promise(resolve => app.grid(side).addEventListener('firstDataRendered', resolve))));
  const calls = [];
  for (const side of [0, 1]) {
    const grid = app.grid(side), set = grid.setGridOption.bind(grid);
    grid.setGridOption = (key, value) => { calls.push([side, key]); return set(key, value); };
    const autoSize = grid.autoSizeColumns.bind(grid);
    grid.autoSizeColumns = (...args) => { calls.push([side, 'autoSizeColumns']); return autoSize(...args); };
  }
  await start(app, 'move', '/favorite/');
  const prepare = app.messages.find(message => message.type === 'filesystem-prepare');
  assert.ok(prepare);
  assert.equal(app.document.querySelector('[data-progress-source]').textContent, '/left/Quelle & Source.txt');
  assert.equal(app.document.querySelector('[data-progress-target]').textContent, '/favorite');
  calls.length = 0;
  const ready = structuredClone(saved); ready.unloadedFolders = [];
  send(app, { type: 'filesystem-result', operationId: prepare.operationId, ok: true, state: ready });
  await tick();
  const move = app.messages.find(message => message.type === 'filesystem-apply');
  assert.ok(move);
  assert.deepEqual(calls.filter(([, key]) => ['rowData', 'autoSizeColumns'].includes(key)), []);
  Object.defineProperty(app.document.querySelector('[data-pane="0"] [data-file-grid]'), 'offsetWidth', { value: 800 });
  send(app, { type: 'filesystem-result', operationId: move.operationId, ok: true, state: confirmFixtureTransfer(ready, move), refreshGitDirectories: ['/left', '/favorite'] });
  assert.deepEqual(calls.filter(([, key]) => ['rowData', 'autoSizeColumns'].includes(key)), [[0, 'rowData']]);
  assert.equal(app.row('Quelle & Source.txt'), undefined);
});
async function start(app, mode, target) {
  app.action(mode);
  if (target) app.document.querySelector('#value').value = target;
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  return app.messages.find(message => message.type === 'filesystem-apply');
}

test('a single-file transfer may display identical progress for the operation and the file', async t => {
  const app = createApp(t, fixture(), { language: 'en' });
  const request = await start(app, 'copy');
  send(app, { type: 'filesystem-transfer-progress', operationId: request.operationId,
    progress: Progress.transferBatch({ phase: 'copying', batch: Progress.batchBytes(6, 12), file: Progress.fileBytes(6, 12) }) });
  assert.equal(app.document.querySelector('#status-percent').textContent, '50%/50%');
});

test('copy progress keeps the whole transfer separate from each conflict checkpoint and current file', async t => {
  const saved = fixture();
  saved.folders['/left'].push({ id: 'b', name: 'same.txt', type: 'text', size: 4 });
  saved.folders['/left'].push({ id: 'c', name: 'last.txt', type: 'text', size: 8 });
  saved.folders['/right'].push({ id: 'existing', name: 'same.txt', type: 'text', size: 2 }, { id: 'last', name: 'last.txt', type: 'text', size: 3 });
  saved.panes[0].selected = ['a', 'b', 'c'];
  const app = createApp(t, saved, { language: 'en' });
  const first = await start(app, 'copy');
  assert.equal(first.transfer.checkpoint, true);
  const report = (request, completed, total, phase = 'copying') => send(app, { type: 'filesystem-transfer-progress', operationId: request.operationId,
    progress: Progress.transferBatch({ phase, batch: Progress.batchBytes(completed, total), file: Progress.fileBytes(completed, total) }) });
  const overall = app.document.querySelector('#status-progress-overall'), current = app.document.querySelector('#status-progress-file');
  report(first, 6, 12);
  assert.equal(overall.getAttribute('aria-valuenow'), '6');
  assert.equal(overall.getAttribute('aria-valuemax'), '24');
  assert.equal(current.getAttribute('aria-valuenow'), '6');
  assert.equal(current.getAttribute('aria-valuemax'), '12');
  report(first, 12, 12, 'published');
  send(app, { type: 'filesystem-result', operationId: first.operationId, ok: true, state: first.state });
  await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]'));
  await tick();
  const second = app.messages.filter(message => message.type === 'filesystem-apply').at(-1);
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(second.transfer.checkpoint, true);
  report(second, 2, 4);
  assert.equal(overall.getAttribute('aria-valuenow'), '14');
  assert.equal(overall.getAttribute('aria-valuemax'), '24');
  assert.equal(current.getAttribute('aria-valuenow'), '2');
  assert.equal(current.getAttribute('aria-valuemax'), '4');
  report(second, 4, 4, 'published');
  send(app, { type: 'filesystem-result', operationId: second.operationId, ok: true, state: second.state });
  await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]'));
  await tick();
  const last = app.messages.filter(message => message.type === 'filesystem-apply').at(-1);
  assert.notEqual(last.operationId, second.operationId);
  report(last, 4, 8);
  assert.equal(overall.getAttribute('aria-valuenow'), '20');
  assert.equal(overall.getAttribute('aria-valuemax'), '24');
  assert.equal(current.getAttribute('aria-valuenow'), '4');
  assert.equal(current.getAttribute('aria-valuemax'), '8');
  send(app, { type: 'filesystem-result', operationId: last.operationId, ok: true, state: last.state });
  app.click(app.document.querySelector('#activity-log-copy'));
  const reportRequest = app.messages.findLast(message => message.type === 'status-log-copy');
  const trace = JSON.parse(reportRequest.text).context.transferEvents;
  assert.deepEqual(trace.map(event => event.stage), ['dialog-opened', 'confirmed', 'queued', 'write-requested', 'write-acknowledged', 'conflict-decision', 'write-requested', 'write-acknowledged', 'conflict-decision', 'write-requested', 'write-acknowledged', 'finished']);
  assert.equal(new Set(trace.map(event => event.traceId)).size, 1);
  assert.equal(trace.find(event => event.stage === 'conflict-decision').decision, 'overwrite');
  assert.equal(trace.at(-1).completed, 3);
});

test('active progress keeps localized operation and literal source/final target independently of transient hints', async t => {
  for (const language of ['en', 'de']) for (const mode of ['copy', 'move']) {
    const app = createApp(t, fixture(), { language });
    const request = await start(app, mode, '/right/Final & Ziel.txt');
    assert.ok(request);
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
  app.click(app.document.querySelector('[data-cancel-transfer]'));
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.at(-1).type, 'filesystem-cancel');
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, cancelled: true, state }); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.querySelector('.transfer-progress'), null);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.action('copy'); assert.equal(app.document.querySelector('#modal-title').textContent, 'Copy');
});

