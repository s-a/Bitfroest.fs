const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog } = require('../scripts/showcases/run.cjs');
const { validateSequence } = require('../scripts/showcases/sequence.cjs');
const { JSDOM } = require('jsdom');
const { installLockObservation, inspectLockProgress, inspectLockResult, inspectLockScan, inspectLockFailureView } = require('../scripts/showcases/gestures.cjs');

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
test('the lock recording reads the blocked target and verifies the inspection control', () => {
  const dom = new JSDOM('<dialog id="modal" open><h2 id="modal-title">File is in use</h2><p data-blocked-delete>Locked.txt</p><button id="modal-confirm">Inspect file locks</button></dialog>');
  const root = dom.window.document, action = root.querySelector('button');
  action.getBoundingClientRect = () => ({ width: 150, height: 20 });
  assert.deepEqual(inspectLockFailureView(root), { title: 'File is in use', file: 'Locked.txt', controlReady: true, genericError: false });
  action.hidden = true;
  assert.equal(inspectLockFailureView(root).controlReady, false);
  root.querySelector('dialog').open = false;
  assert.equal(inspectLockFailureView(root), false);
  dom.window.close();
});
