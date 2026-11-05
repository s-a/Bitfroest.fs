const test = require('node:test');
const assert = require('node:assert/strict');
const { createArchiveController } = require('../scripts/showcases/archive-controller.cjs');

test('pack waits for the response for the exact initiated operation and disposes the observer', async () => {
  const calls = [], state = { input: 'fixture path' };
  const controller = createArchiveController({
    fixture: { confirm: async (action, snapshot, trigger) => { calls.push(['validate', action, snapshot]); await trigger(); calls.push(['verify-file']); } },
    readSnapshot: async () => ({ ...state }),
    observe: async () => ({ wait: async id => { calls.push(['wait', id]); return { operationId: id, complete: true }; }, dispose: async () => calls.push(['dispose']) }),
    clickConfirm: async () => { calls.push(['click']); return 'zip-write-101-1'; }
  });
  await controller.confirm('archive-pack', 'Pack the file');
  assert.deepEqual(calls.map(x => x[0]), ['validate', 'click', 'wait', 'verify-file', 'dispose']);
  assert.equal(calls[2][1], 'zip-write-101-1');
});

test('refuses a missing operation identity, mismatched reply, or changed state', async () => {
  for (const mode of ['missing', 'wrong', 'changed']) {
    let reads = 0, clicks = 0, disposed = false;
    const controller = createArchiveController({
      fixture: { confirm: async (action, snapshot, trigger) => trigger() },
      readSnapshot: async () => ({ input: mode === 'changed' && ++reads > 1 ? 'changed' : 'expected' }),
      observe: async () => ({ wait: async id => ({ operationId: mode === 'wrong' ? 'zip-write-999-1' : id, complete: true }), dispose: async () => { disposed = true; } }),
      clickConfirm: async () => { clicks++; return mode === 'missing' ? undefined : 'zip-write-101-1'; }
    });
    await assert.rejects(controller.confirm('archive-pack', 'Pack'), /identity|changed/);
    assert.equal(disposed, true);
    if (mode === 'changed') assert.equal(clicks, 0);
  }
});

test('opening requires the verified selected archive and observed navigation', async () => {
  const calls = [];
  const controller = createArchiveController({ fixture: { validateOpen: async () => calls.push('validate') },
    readSnapshot: async () => ({ selected: ['archive'] }), pressEnter: async () => calls.push('enter'),
    waitOpened: async () => { calls.push('opened'); return { complete: true }; } });
  await controller.confirm('open-archive', 'Open archive');
  assert.deepEqual(calls, ['validate', 'enter', 'opened']);
});

test('leaving and showing the extracted folder require fixture validation and observed navigation', async () => {
  const calls = [];
  const controller = createArchiveController({ fixture: { validateLeave: async () => calls.push('validate-leave'), validateShow: async () => calls.push('validate-show') },
    readSnapshot: async () => ({ path: 'fixture' }), pressEnter: async () => calls.push('enter'),
    waitLeft: async () => ({ complete: true }), waitExtracted: async () => ({ complete: true }) });
  await controller.confirm('leave-archive', 'Leave');
  await controller.confirm('show-unpacked-folder', 'Show');
  assert.deepEqual(calls, ['validate-leave', 'enter', 'validate-show', 'enter']);
});
