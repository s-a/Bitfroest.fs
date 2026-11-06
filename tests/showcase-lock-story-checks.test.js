const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateLockDeleteSnapshot, validateLockDeleteFailure, validateLockScan } = require('../scripts/showcases/lock-story-checks.cjs');

const folder = path.resolve('example-lock-story', 'Build-Output');
const file = path.join(folder, 'Locked.txt');
const fixture = { folder, file, pid: 42, async assertTarget(value) { assert.equal(value, file); }, async assertIntact() {} };
const snapshot = { activeDirectory: folder, selected: [file], dialog: 'Delete permanently?', dialogFiles: ['Locked.txt'], controlReady: true };
const failure = { type: 'filesystem-result', operationId: 'delete-123', ok: false, error: 'Delete failed: file is in use',
  blockedDeletion: { path: file, inUse: true, deletedCount: 0, canInspect: true },
  diagnostic: { request: { type: 'filesystem-delete', operationId: 'delete-123', paths: [file] }, failure: { cause: { code: 'EBUSY' } } } };
const view = { title: 'File is in use', file: 'Locked.txt', controlReady: true, genericError: false };

test('allows only the exact locked fixture target and permanent-delete dialog', async () => {
  await validateLockDeleteSnapshot(fixture, snapshot);
  for (const changed of [
    { selected: [path.join(folder, 'Other.txt')] }, { selected: [file, file] }, { activeDirectory: path.dirname(folder) },
    { dialog: 'Move to Trash?' }, { dialogFiles: ['Other.txt'] }, { controlReady: false }
  ]) await assert.rejects(validateLockDeleteSnapshot(fixture, { ...snapshot, ...changed }));
});

test('requires a correlated failed delete, visible product error and intact fixture', async () => {
  await validateLockDeleteFailure(fixture, failure, view);
  for (const changed of [
    { ...failure, ok: true }, { ...failure, cancelled: true }, { ...failure, operationId: 'delete-other' },
    { ...failure, diagnostic: { ...failure.diagnostic, request: { ...failure.diagnostic.request, paths: [path.join(folder, 'Other.txt')] } } },
    { ...failure, diagnostic: { ...failure.diagnostic, failure: { cause: { code: 'EINVAL' } } } }
  ]) await assert.rejects(validateLockDeleteFailure(fixture, changed, view));
  for (const changed of [{ genericError: true }, { controlReady: false }, { file: 'Other.txt' }, { title: 'Unrelated failure' }]) {
    await assert.rejects(validateLockDeleteFailure(fixture, failure, { ...view, ...changed }), /blocked deletion dialog/);
  }
  await assert.rejects(validateLockDeleteFailure({ ...fixture, async assertIntact() { throw new Error('changed'); } }, failure, view), /changed/);
});

test('accepts a neutral dialog when the host only reports access denied', async () => {
  const denied = { ...failure, blockedDeletion: { ...failure.blockedDeletion, inUse: false },
    diagnostic: { ...failure.diagnostic, failure: { cause: { code: 'NoPermissions' } } } };
  await validateLockDeleteFailure(fixture, denied, { ...view, title: 'Could not delete the entry' });
  await assert.rejects(validateLockDeleteFailure(fixture, denied, view), /blocked deletion dialog/);
});

test('recognizes a wrapped Windows EBUSY failure without accepting unrelated errors', async () => {
  const wrapped = { ...failure, diagnostic: { ...failure.diagnostic, failure: { cause: { code: 'Unavailable', message: "Error: EBUSY: resource busy or locked, unlink 'C:\\demo\\Locked.txt'" } } } };
  await validateLockDeleteFailure(fixture, wrapped, view);
  for (const message of ['EBUSY: network error', 'resource busy or locked', 'Error: EINVAL: resource busy or locked']) {
    await assert.rejects(validateLockDeleteFailure(fixture, { ...wrapped, diagnostic: { ...wrapped.diagnostic, failure: { cause: { code: 'Unavailable', message } } } }, view));
  }
});

test('inspector evidence must identify the actual child and its exact file', async () => {
  const state = { type: 'locks-state', path: folder, rows: [{ pid: 42, started: '12345', file, kind: 'handle' }] };
  const visible = { ready: true, detailsVisible: true, text: 'PID 42 · Locked.txt' };
  await validateLockScan(fixture, state, visible);
  for (const rows of [[], [{ ...state.rows[0], pid: 43 }], [{ ...state.rows[0], file: path.join(folder, 'Other.txt') }],
    [state.rows[0], { ...state.rows[0], pid: 43 }], [{ ...state.rows[0], started: '' }]]) {
    await assert.rejects(validateLockScan(fixture, { ...state, rows }, visible));
  }
  await assert.rejects(validateLockScan(fixture, { ...state, path: path.dirname(folder) }, visible));
  await assert.rejects(validateLockScan(fixture, state, { ...visible, ready: false }));
  await assert.rejects(validateLockScan(fixture, state, { ...visible, detailsVisible: false }));
  await assert.rejects(validateLockScan(fixture, state, { ...visible, text: 'PID 43 · Locked.txt' }));
});
