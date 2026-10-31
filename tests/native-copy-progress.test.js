const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCopySession } = require('../native-copy');
const input = { roots: ['C:/tmp'], source: 'C:/tmp/source', target: 'C:/tmp/destination', expected: { dev: '1', ino: '2', size: '100', mtimeNs: '3', ctimeNs: '4' } };

test('native copy progress preserves monotonic bytes and ignores callbacks after the result', async () => {
  let progress;
  const events = [];
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({
    invoke: async (_operation, _request, options) => {
      progress = options.onProgress;
      for (const transferred of [60, 40, 100]) progress({ transferred, total: 100 });
      return { status: 'committed', copied: true };
    }, close() {}
  }) };
  const session = createCopySession({ platform: 'win32', nativeApi });
  try {
    await session.copy(input, { onProgress: event => events.push(event.transferred) });
    progress({ transferred: 99, total: 100 });
    assert.deepEqual(events, [60, 100]);
  } finally { await session.dispose(); }
});

test('disposal requested inside synchronous native progress waits for the terminal result', async () => {
  let complete, closing, closeFinished = false;
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({
    invoke(_operation, _request, options) {
      const pending = new Promise(resolve => { complete = resolve; });
      options.onProgress({ transferred: 1, total: 100 });
      return pending;
    }, async closeAsync() {}
  }) };
  const session = createCopySession({ platform: 'win32', nativeApi });
  const pending = session.copy(input, { onProgress() { closing = session.dispose().then(() => { closeFinished = true; }); } });
  pending.catch(() => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closeFinished, false);
  } finally {
    complete({ status: 'unchanged', copied: false, cancelled: true });
    await assert.rejects(pending, { name: 'AbortError' });
    await closing;
  }
  assert.equal(closeFinished, true);
});
