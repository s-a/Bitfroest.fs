const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLockStoryController } = require('../scripts/showcases/lock-story-controller.cjs');

function setup() {
  const folder = path.resolve('example-lock-story', 'Build-Output'), file = path.join(folder, 'Locked.txt');
  const calls = [], fixture = { folder, file, pid: 42, async assertTarget(target) { assert.equal(target, file); calls.push('target'); }, async assertIntact() { calls.push('intact'); } };
  const deleteSnapshot = { activeDirectory: folder, selected: [file], dialog: 'Delete permanently?', dialogFiles: ['Locked.txt'], controlReady: true };
  const inspectorSnapshot = { title: 'File is in use', file: 'Locked.txt', controlReady: true, genericError: false };
  const failure = { type: 'filesystem-result', operationId: 'delete-123-1', ok: false, error: 'File is in use',
    blockedDeletion: { path: file, inUse: true, deletedCount: 0, canInspect: true },
    diagnostic: { request: { type: 'filesystem-delete', operationId: 'delete-123-1', paths: [file] }, failure: { cause: { code: 'EBUSY' } } } };
  const scan = { type: 'locks-state', path: folder, rows: [{ pid: 42, started: '12345', file, kind: 'handle' }] };
  const failureView = { ...inspectorSnapshot };
  const scanView = { ready: true, detailsVisible: true, text: 'PID 42 Locked.txt' };
  const progress = { type: 'filesystem-task-progress', operationId: 'delete-123-1', progress: { phase: 'deleting', path: file } };
  const options = { fixture, readSnapshot: async action => action === 'lock-delete' ? deleteSnapshot : inspectorSnapshot,
    observeDelete: async () => ({ waitStarted: async () => { calls.push('started'); return progress; }, wait: async id => { calls.push(`wait:${id}`); return { event: failure, view: failureView }; }, dispose: async () => calls.push('dispose-delete') }),
    clickConfirm: async () => { calls.push('click'); },
    observeInspector: async () => ({ wait: async () => { calls.push('scan'); return { event: scan, view: scanView }; }, dispose: async () => calls.push('dispose-scan') }),
    openInspector: async () => calls.push('open'), refreshInspector: async () => calls.push('refresh') };
  return { calls, options, deleteSnapshot, inspectorSnapshot, failure, scan, scanView, progress };
}

test('correlates actual delete failure and verifies the owned process after opening and refreshing', async () => {
  const h = setup(), controller = createLockStoryController(h.options);
  await controller.confirm('lock-delete', 'Attempt deletion');
  await controller.confirm('lock-inspect', 'Inspect file locks');
  await controller.confirm('lock-refresh', 'Refresh lock scan');
  assert.ok(h.calls.indexOf('click') < h.calls.indexOf('wait:delete-123-1'));
  assert.ok(h.calls.indexOf('click') < h.calls.indexOf('started'));
  assert.ok(h.calls.indexOf('open') < h.calls.indexOf('scan'));
  assert.ok(h.calls.includes('refresh'));
  assert.equal(h.calls.filter(x => x === 'dispose-scan').length, 2);
});

test('rejects changed confirmation state and disposes the observer without clicking', async () => {
  const h = setup(); let reads = 0;
  h.options.readSnapshot = async () => ({ ...h.deleteSnapshot, selected: ++reads === 1 ? [h.options.fixture.file] : ['foreign'] });
  await assert.rejects(createLockStoryController(h.options).confirm('lock-delete'), /changed/);
  assert.equal(h.calls.includes('click'), false);
  assert.ok(h.calls.includes('dispose-delete'));
});

test('rejects unrelated replies, a changed failure dialog and a foreign process', async () => {
  const h = setup(), controller = createLockStoryController(h.options);
  await assert.rejects(controller.confirm('lock-inspect'), /sequence/);
  h.failure.operationId = 'delete-elsewhere';
  await assert.rejects(controller.confirm('lock-delete'), /identity/);
  assert.ok(h.calls.includes('dispose-delete'));
  const other = setup(), valid = createLockStoryController(other.options);
  await valid.confirm('lock-delete');
  other.inspectorSnapshot.file = 'Other.txt';
  await assert.rejects(valid.confirm('lock-inspect'), /changed/);
  other.inspectorSnapshot.file = 'Locked.txt';
  other.scan.rows[0].pid = 99;
  await assert.rejects(valid.confirm('lock-inspect'), /fixture process/);
  assert.ok(other.calls.includes('dispose-scan'));
});

test('rejects missing or unrelated real deletion progress before associating a reply', async () => {
  for (const changed of [
    { type: 'filesystem-progress' }, { operationId: 'delete-invalid' },
    { progress: { phase: 'copying', path: 'irrelevant' } },
    { progress: { phase: 'deleting', path: path.resolve('foreign.txt') } }
  ]) {
    const h = setup(); Object.assign(h.progress, changed);
    await assert.rejects(createLockStoryController(h.options).confirm('lock-delete'), /progress/);
    assert.ok(h.calls.includes('dispose-delete'));
    assert.equal(h.calls.some(value => value.startsWith('wait:')), false);
  }
});
