function createArchiveController({ fixture, readSnapshot, observe, clickConfirm, pressEnter, waitOpened, waitLeft, waitExtracted }) {
  if (!fixture || typeof readSnapshot !== 'function') throw new TypeError('An archive fixture and snapshot reader are required.');
  async function unchanged(action, before) {
    if (JSON.stringify(await readSnapshot(action)) !== JSON.stringify(before)) throw new Error('Archive confirmation state changed.');
  }
  async function confirm(action, effect) {
    if (['open-archive', 'leave-archive', 'show-unpacked-folder'].includes(action)) {
      const snapshot = await readSnapshot(action);
      const validate = action === 'open-archive' ? fixture.validateOpen : action === 'leave-archive' ? fixture.validateLeave : fixture.validateShow;
      const wait = action === 'open-archive' ? waitOpened : action === 'leave-archive' ? waitLeft : waitExtracted;
      if (typeof validate !== 'function' || typeof wait !== 'function' || typeof pressEnter !== 'function') throw new Error('Archive navigation is unavailable.');
      await validate(snapshot);
      await unchanged(action, snapshot);
      await pressEnter(effect);
      const opened = await wait();
      if (!opened?.complete) throw new Error(opened?.error || 'Archive navigation did not complete.');
      return;
    }
    const operation = { 'archive-pack': 'pack', 'archive-unpack': 'unpack' }[action];
    if (!operation || typeof observe !== 'function' || typeof clickConfirm !== 'function') throw new Error('Unsupported archive confirmation.');
    const snapshot = await readSnapshot(operation), observer = await observe(operation);
    if (!observer || typeof observer.wait !== 'function' || typeof observer.dispose !== 'function') throw new Error('Archive completion observer is unavailable.');
    try {
      await fixture.confirm(operation, snapshot, async () => {
        await unchanged(operation, snapshot);
        const operationId = await clickConfirm(effect, snapshot, operation);
        if (typeof operationId !== 'string' || !/^zip-write-\d+-\d+$/.test(operationId)) throw new Error('Archive operation identity is unavailable.');
        const completion = await observer.wait(operationId);
        if (completion?.operationId !== operationId) throw new Error('Archive operation identity does not match the reply.');
        if (!completion.complete || completion.error) throw new Error(completion.error || 'Archive operation did not complete.');
      });
    } finally { await observer.dispose(); }
  }
  return { confirm };
}

module.exports = { createArchiveController };
