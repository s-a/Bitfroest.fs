const path = require('node:path');
const { validateLockDeleteSnapshot, validateLockDeleteFailure, validateLockScan } = require('./lock-story-checks.cjs');

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function createLockStoryController({ fixture, readSnapshot, observeDelete, clickConfirm, observeInspector, openInspector, refreshInspector }) {
  if (!fixture || typeof readSnapshot !== 'function') throw new TypeError('A lock fixture and snapshot reader are required.');
  let stage = 'initial', busy = false, failedDeleteView;
  async function unchanged(action, before) {
    if (JSON.stringify(await readSnapshot(action)) !== JSON.stringify(before)) throw new Error('Lock story confirmation state changed.');
  }
  async function confirm(action, effect) {
    if (busy) throw new Error('Lock story operation is busy.');
    busy = true;
    try {
      if (action === 'lock-delete') {
        if (stage !== 'initial' || typeof observeDelete !== 'function' || typeof clickConfirm !== 'function') throw new Error('Invalid lock story sequence.');
        const snapshot = await readSnapshot(action);
        await validateLockDeleteSnapshot(fixture, snapshot);
        const observer = await observeDelete();
        if (!observer || typeof observer.waitStarted !== 'function' || typeof observer.wait !== 'function' || typeof observer.dispose !== 'function') throw new Error('Delete completion observer is unavailable.');
        try {
          await unchanged(action, snapshot);
          await validateLockDeleteSnapshot(fixture, snapshot);
          await clickConfirm(effect, snapshot);
          const progress = await observer.waitStarted();
          const id = progress?.operationId;
          if (progress?.type !== 'filesystem-task-progress' || progress.progress?.phase !== 'deleting' ||
              !same(progress.progress?.path, fixture.file) || typeof id !== 'string' || !/^delete-\d+-\d+$/.test(id)) {
            throw new Error('The expected deletion progress was not observed.');
          }
          const observed = await observer.wait(id);
          if (observed?.event?.operationId !== id) throw new Error('Delete operation identity does not match the reply.');
          await validateLockDeleteFailure(fixture, observed.event, observed.view);
          failedDeleteView = observed.view;
          stage = 'failed-delete';
        } finally { await observer.dispose(); }
        return;
      }
      if (action === 'lock-inspect' || action === 'lock-refresh') {
        if (action === 'lock-inspect' && stage !== 'failed-delete' || action === 'lock-refresh' && stage !== 'inspected' ||
            typeof observeInspector !== 'function' || typeof refreshInspector !== 'function' ||
            action === 'lock-inspect' && typeof openInspector !== 'function') throw new Error('Invalid lock story sequence.');
        if (action === 'lock-inspect') {
          await unchanged(action, failedDeleteView);
          await fixture.assertIntact();
          await openInspector(effect, failedDeleteView);
        } else await fixture.assertIntact();
        const observer = await observeInspector(action);
        if (!observer || typeof observer.wait !== 'function' || typeof observer.dispose !== 'function') throw new Error('Lock scan observer is unavailable.');
        try {
          await refreshInspector(action === 'lock-inspect' ? 'Refresh the lock scan' : effect);
          const observed = await observer.wait();
          await validateLockScan(fixture, observed?.event, observed?.view);
          stage = 'inspected';
        } finally { await observer.dispose(); }
        return;
      }
      throw new Error('Unsupported lock story action.');
    } finally { busy = false; }
  }
  return { confirm };
}

module.exports = { createLockStoryController };
