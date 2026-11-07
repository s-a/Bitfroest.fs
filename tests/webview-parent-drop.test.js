const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, resolveThemeCss, confirmFixtureTransfer } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'parent-drop', active: 0, panes: [pane('C:/base/temp'), pane('C:/other')], folders: {
    'C:/base/temp': [{ id: 'a', name: 'film.mp4', type: 'text', size: 1234, fsSource: 'C:/base/temp/film.mp4' }], 'C:/other': []
  } };
}
function drag(app, type, target, modifiers = {}) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  const data = { setData() {}, dropEffect: 'none' };
  Object.defineProperty(event, 'dataTransfer', { value: data });
  for (const [key, value] of Object.entries(modifiers)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return { event, data };
}
function start(app, modifiers = {}) {
  drag(app, 'dragstart', app.row('film.mp4'));
  const row = app.document.querySelector('[data-pane="0"] [data-parent]');
  const over = drag(app, 'dragover', row, modifiers);
  return { row, ...over };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));

test('parent drop uses two dots and highlights the row even before the parent listing is loaded', t => {
  for (const shiftKey of [false, true]) {
    const app = createApp(t, fixture()), { row, event, data } = start(app, { shiftKey });
    assert.equal(row.querySelector('.filename').textContent, '..');
    assert.equal(event.defaultPrevented, true);
    assert.equal(data.dropEffect, shiftKey ? 'move' : 'copy');
    assert.equal(row.classList.contains('drop-target'), true);
    assert.equal(row.closest('.list').classList.contains('drop-target'), false);
    drag(app, 'drop', row, { shiftKey });
    assert.equal(row.classList.contains('drop-target'), false);
    assert.equal(app.document.querySelector('#modal').open, true);
    assert.equal(app.document.querySelector('#value').value, 'C:\\base');
    assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  }
});

test('parent drop feedback uses theme colors with an explicit outline', t => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
    const app = createApp(t, fixture()), style = app.document.createElement('style');
    style.textContent = resolveThemeCss(css, { 'list-dropBackground': 'rgb(20, 40, 60)', 'list-activeSelectionForeground': 'rgb(255, 255, 255)', focusBorder: 'rgb(240, 200, 0)' });
    app.document.head.append(style); app.document.body.className = theme;
    const { row } = start(app), computed = app.window.getComputedStyle(row);
    assert.equal(computed.backgroundColor, 'rgb(20, 40, 60)');
    assert.equal(computed.color, 'rgb(255, 255, 255)');
    assert.match(computed.outline, /^2px solid /);
  }
});

test('parent drop reads the immediate target and resolves existing files before a host commit', async t => {
  for (const shiftKey of [false, true]) {
    const app = createApp(t, fixture()), { row } = start(app, { shiftKey });
    drag(app, 'drop', row, { shiftKey }); submit(app); await tick();
    const prepare = app.messages.find(message => message.type === 'filesystem-prepare'); assert.ok(prepare);
    assert.deepEqual([...prepare.paths], ['C:/base']); assert.equal(prepare.recursive, false);
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
    assert.ok(app.row('film.mp4'));
    const fresh = app.state(); fresh.snapshotId = 'parent-read';
    fresh.folders['C:/base'] = [{ id: 'temp', name: 'temp', type: 'folder', fsSource: 'C:/base/temp' }, { id: 'existing', name: 'film.mp4', type: 'text', size: 999, fsSource: 'C:/base/film.mp4' }];
    send(app, { type: 'filesystem-result', ok: true, state: fresh }); await tick();
    assert.equal(app.document.querySelector('#modal-title').textContent, 'Datei bereits vorhanden');
    assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
    app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
    const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
    assert.equal(apply.transfer.mode, shiftKey ? 'move' : 'copy');
    assert.ok(app.row('film.mp4'), 'source remains visible until host confirmation');
    assert.equal(app.state().folders['C:/base'].find(file => file.name === 'film.mp4').size, 999);
    send(app, { type: 'filesystem-result', operationId: apply.operationId, ok: false, error: 'Target denied', state: fresh }); await tick();
    assert.ok(app.row('film.mp4'));
    assert.equal(app.document.querySelector('#status-message').dataset.outcome, 'error');
  }
});

test('a cached parent opens its conflict dialog and copying never removes the source row', async t => {
  const initial = fixture();
  initial.folders['C:/base'] = [{ id: 'temp', name: 'temp', type: 'folder', fsSource: 'C:/base/temp' }, { id: 'existing', name: 'film.mp4', type: 'text', size: 999, fsSource: 'C:/base/film.mp4' }];
  const app = createApp(t, initial), { row } = start(app);
  drag(app, 'drop', row); submit(app); await tick();
  assert.ok(app.messages.some(message => message.type === 'filesystem-prepare'));
  send(app, { type: 'filesystem-result', ok: true, state: initial }); await tick();
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Datei bereits vorhanden');
  assert.ok(app.row('film.mp4'));
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  assert.ok(app.row('film.mp4'));
  assert.equal(apply.transfer.mode, 'copy');
  send(app, { type: 'filesystem-result', operationId: apply.operationId, ok: true, state: confirmFixtureTransfer(initial, apply) }); await tick();
  assert.ok(app.row('film.mp4'));
  assert.equal(app.state().folders['C:/base'].find(file => file.name === 'film.mp4').size, 1234);
});

test('a cached parent missing an existing target is reread before a left-drop can claim success', async t => {
  const initial = fixture();
  initial.folders['C:/base'] = [{ id: 'temp', name: 'temp', type: 'folder', fsSource: 'C:/base/temp' }];
  const app = createApp(t, initial), { row } = start(app);
  drag(app, 'drop', row); submit(app); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-prepare'); assert.ok(request, 'cached target metadata must not stand in for the current directory');
  assert.deepEqual([...request.paths], ['C:/base']); assert.equal(request.recursive, false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  assert.ok(app.row('film.mp4'));
  assert.notEqual(app.document.querySelector('#status-message').dataset.outcome, 'success');
  const fresh = app.state(); fresh.snapshotId = 'fresh-parent';
  fresh.folders['C:/base'].push({ id: 'existing', name: 'film.mp4', type: 'text', size: 999, fsSource: 'C:/base/film.mp4' });
  send(app, { type: 'filesystem-result', ok: true, state: fresh }); await tick();
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Datei bereits vorhanden');
  assert.ok(app.row('film.mp4'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.click(app.document.querySelector('[data-conflict-action="skip"]')); await tick();
  assert.ok(app.row('film.mp4')); assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('left-drop planning cannot expose an unconfirmed move when an unrelated redraw arrives', { timeout: 5000 }, async t => {
  const app = createApp(t, fixture());
  const execute = app.window.BitfroestTransfer.execute;
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  app.window.BitfroestTransfer = { ...app.window.BitfroestTransfer, execute: async options => { const result = await execute(options); entered(); await held; return result; } };
  const { row } = start(app, { shiftKey: true }); drag(app, 'drop', row, { shiftKey: true }); submit(app); await tick();
  const fresh = app.state(); fresh.snapshotId = 'plan-parent';
  fresh.folders['C:/base'] = [{ id: 'temp', name: 'temp', type: 'folder', fsSource: 'C:/base/temp' }];
  send(app, { type: 'filesystem-result', ok: true, state: fresh }); await reached;
  assert.equal(app.state().folders['C:/base/temp'].length, 1, 'the displayed model must retain the source before host confirmation');
  send(app, { type: 'file-settings', settings: { iconSize: 24 } });
  app.click(app.document.querySelector('[data-pane="0"] [data-sort="name"]'));
  assert.ok(app.row('film.mp4'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  release(); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  assert.equal(apply.transfer.mode, 'move');
  assert.equal(apply.transfer.changes[0].source, 'C:/base/temp/film.mp4');
  assert.ok(app.row('film.mp4'));
  send(app, { type: 'filesystem-result', operationId: apply.operationId, ok: false, error: 'Host failure' }); await tick();
  assert.ok(app.row('film.mp4'));
});

test('parent drop cancellation, failed target reading and root self-drops preserve the source', async t => {
  const app = createApp(t, fixture()), { row } = start(app);
  drag(app, 'drop', row); app.click(app.document.querySelector('#modal-cancel')); await tick();
  assert.ok(app.row('film.mp4')); assert.equal(app.messages.some(message => message.type === 'filesystem-prepare'), false);
  const next = start(app); drag(app, 'drop', next.row); submit(app); await tick();
  send(app, { type: 'filesystem-result', ok: false, error: 'Parent denied', state: fixture() }); await tick();
  assert.ok(app.row('film.mp4')); assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  const root = fixture(); root.panes[0].tabs = ['C:/']; root.folders['C:/'] = root.folders['C:/base/temp']; delete root.folders['C:/base/temp'];
  const rootApp = createApp(t, root), list = rootApp.document.querySelector('.pane.active .list');
  assert.equal(Boolean(list.querySelector('[data-parent]')), false);
  drag(rootApp, 'dragstart', rootApp.row('film.mp4'));
  const result = drag(rootApp, 'dragover', list);
  assert.equal(result.event.defaultPrevented, false); assert.equal(list.classList.contains('drop-target'), false);
});

test('right dragging onto an unloaded parent opens move confirmation for that directory', async t => {
  const app = createApp(t, fixture());
  const row = app.document.querySelector('[data-pane="0"] [data-parent]');
  const pointer = (type, target, x) => {
    const event = new app.window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ button: 2, buttons: type === 'pointerup' ? 0 : 2, pointerId: 7, clientX: x, clientY: 5 })) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  };
  pointer('pointerdown', app.row('film.mp4'), 5);
  await new Promise(resolve => app.window.setTimeout(resolve, 450));
  pointer('pointermove', row, 500);
  assert.equal(row.classList.contains('drop-target'), true);
  pointer('pointerup', row, 500);
  assert.equal(app.messages.some(message => message.type === 'choose-drop-action'), false);
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Verschieben');
  assert.equal(app.document.querySelector('#value').value, 'C:\\base');
});
