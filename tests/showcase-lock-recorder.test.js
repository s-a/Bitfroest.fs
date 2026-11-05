const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog } = require('../scripts/showcases/run.cjs');
const { validateSequence } = require('../scripts/showcases/sequence.cjs');
const { JSDOM } = require('jsdom');
const { fixtureSnapshot, installLockObservation, inspectLockProgress, inspectLockResult, inspectLockScan, inspectLockFailureView } = require('../scripts/showcases/gestures.cjs');

test('lock confirmations are restricted to their dedicated fixture', () => {
  const steps = [{ type: 'confirm', action: 'lock-delete', effect: 'Try deletion' }, { type: 'confirm', action: 'lock-inspect', effect: 'Inspect locks' }];
  assert.doesNotThrow(() => validateSequence(steps));
  const scene = { id: 'lock-test', title: 'Locks', description: 'Inspect a locked file.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{ id: 'lock', format: 'gif', expect: '.pane', text: 'Locked', steps }] };
  assert.throws(() => validateCatalog([scene]), /fixture/i);
  assert.throws(() => validateCatalog([{ ...scene, fixture: 'deletion' }]), /fixture/i);
  assert.doesNotThrow(() => validateCatalog([{ ...scene, fixture: 'file-lock' }]));
});

test('observes real deletion progress and only the correlated host reply', () => {
  const dom = new JSDOM(''), root = dom.window.document, file = 'C:/demo/Locked.txt';
  installLockObservation('delete', root);
  const send = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send({ type: 'filesystem-task-progress', operationId: 'delete-1-1', progress: { phase: 'deleting', path: file } });
  send({ type: 'filesystem-result', operationId: 'delete-2-1', ok: false });
  assert.equal(inspectLockProgress(file, root).operationId, 'delete-1-1');
  assert.equal(inspectLockResult('delete-1-1', root), false);
  send({ type: 'filesystem-result', operationId: 'delete-1-1', ok: false });
  assert.equal(inspectLockResult('delete-1-1', root).operationId, 'delete-1-1');
  send({ type: 'filesystem-task-progress', operationId: 'delete-2-1', progress: { phase: 'deleting', path: file } });
  assert.throws(() => inspectLockProgress(file, root), /multiple/i);
  dom.window.__showcaseLockObservation.dispose(); dom.window.close();
});

test('scan observation requires a fresh busy transition before its result', () => {
  const dom = new JSDOM(''), root = dom.window.document;
  installLockObservation('scan', root);
  const send = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send({ type: 'locks-state', rows: [] });
  assert.equal(inspectLockScan(root), false);
  send({ type: 'locks-busy', busy: true });
  assert.equal(inspectLockScan(root), false);
  send({ type: 'locks-state', rows: [{ pid: 42 }] });
  assert.equal(inspectLockScan(root).rows[0].pid, 42);
  dom.window.__showcaseLockObservation.dispose(); dom.window.close();
});

test('inspector opening is bound to the selected real folder and a visible menu action', () => {
  const dom = new JSDOM('<div data-context-menu><button data-context-action="inspect-folder-locks">Inspect</button></div>');
  const root = dom.window.document, menu = root.querySelector('button');
  dom.window.CommanderHost = { getState: () => ({ realFilesystem: true, active: 1,
    panes: [{ tabs: ['C:/demo/left'], tab: 0, selected: [] }, { tabs: ['C:/demo/right'], tab: 0, selected: ['folder'] }],
    folders: { 'C:/demo/right': [{ id: 'folder', fsSource: 'C:/demo/right/Build-Output' }] } }) };
  menu.getBoundingClientRect = () => ({ width: 50, height: 20 });
  const snapshot = fixtureSnapshot('lock-inspect', root);
  assert.deepEqual(snapshot.selected, ['C:/demo/right/Build-Output']);
  assert.equal(snapshot.realFilesystem, true);
  assert.equal(snapshot.controlReady, true);
  menu.hidden = true;
  assert.equal(fixtureSnapshot('lock-inspect', root).controlReady, false);
  dom.window.close();
});

test('failure view reads the visible error status and detects an open dialog', () => {
  const dom = new JSDOM('<span id="status-message" data-outcome="error"><span data-status-text>Deletion failed: EBUSY</span></span><dialog></dialog>');
  const root = dom.window.document, status = root.querySelector('#status-message'), message = root.querySelector('[data-status-text]');
  message.getBoundingClientRect = () => ({ width: 150, height: 20 });
  assert.deepEqual(inspectLockFailureView(root), { statusText: 'Deletion failed: EBUSY', dialogOpen: false });
  root.querySelector('dialog').open = true;
  assert.equal(inspectLockFailureView(root).dialogOpen, true);
  status.dataset.outcome = 'info';
  assert.equal(inspectLockFailureView(root), false);
  status.dataset.outcome = 'error';
  message.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(inspectLockFailureView(root), false);
  dom.window.close();
});
