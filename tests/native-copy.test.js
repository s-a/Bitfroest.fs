const test = require('node:test');
const assert = require('node:assert/strict');
const nativeFs = require('node:fs');
const { copyFileCancellable, createCopySession } = require('../native-copy');

test('portable copying without a known source size cannot report an empty determinate transfer', async () => {
  const session = createCopySession({ platform: 'linux', copyFile: async () => {} }), events = [];
  await session.copy({ source: '/source', target: '/target', roots: ['/'] }, { onProgress: event => events.push(event) });
  assert.equal(events[0].overall.kind, 'indeterminate');
  assert.equal(events[0].current.kind, 'indeterminate');
  await session.dispose();
});
const input = { roots: ['C:/tmp', 'C:/temp'], source: 'C:/tmp/a.bin', target: 'C:/temp/.stage/content', expected: { dev: '1', ino: '2', size: '100', mtimeNs: '10', ctimeNs: '11' } };

test('already aborted jobs do not open a native session or copy any byte', async () => {
  const controller = new AbortController(); controller.abort();
  const nativeApi = { openSession: () => assert.fail('An aborted request must not start.') };
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', nativeApi, signal: controller.signal }), { name: 'AbortError' });
});

test('non-Windows copy retains exclusive creation and between-file cancellation capability', async () => {
  const events = [], calls = [];
  await copyFileCancellable(input, { platform: 'linux', copyFile: async (...args) => { calls.push(args); }, onProgress: event => events.push(event) });
  assert.deepEqual(calls, [[input.source, input.target, nativeFs.constants.COPYFILE_EXCL]]);
  assert.equal(events[0].granular, false);
});

test('invalid copy requests never reach the native module', async () => {
  let calls = 0;
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession() { calls++; throw new Error('Unexpected native request.'); } };
  for (const invalid of [null, { ...input, roots: [] }, { ...input, source: 'relative' }, { ...input, target: 'C:/temp/../temp/t' }, { ...input, source: 'C:/tmp/a\0.bin' }, { ...input, target: 'C:/temp/x:stream' }, { ...input, roots: ['C:/outside'] }, { ...input, target: input.source }, { ...input, expected: {} }]) {
    await assert.rejects(copyFileCancellable(invalid, { platform: 'win32', nativeApi }));
  }
  assert.equal(calls, 0);
});

test('native API session copies through one native session without starting the legacy worker', async () => {
  const calls = [], opened = [], closed = [];
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession() {
    const index = opened.length + 1; opened.push(index);
    return { invoke: async (operation, request, options) => {
      calls.push({ operation, request, options });
      options.onProgress({ transferred: 100, total: 100 });
      return { status: 'committed', copied: true, cancelled: false };
    }, close: () => closed.push(index) };
  } };
  const session = createCopySession({ platform: 'win32', nativeApi, spawn: () => assert.fail('The legacy worker must not start.') });
  const events = [];
  await session.copy(input, { onProgress: event => events.push(event) });
  await session.copy({ ...input, target: 'C:/temp/.stage/second' });
  assert.equal(opened.length, 1);
  assert.deepEqual(calls.map(call => call.operation), ['files.copy', 'files.copy']);
  assert.deepEqual(calls.map(call => call.request.target), ['C:\\temp\\.stage\\content', 'C:\\temp\\.stage\\second']);
  assert.deepEqual(events.map(({ transferred, total, granular }) => ({ transferred, total, granular })), [{ transferred: 100, total: 100, granular: true }]);
  assert.equal(events[0].version, 1);
  assert.deepEqual(events[0].overall, { kind: 'determinate', unit: 'bytes', completed: 100, total: 100 });
  await session.dispose();
  assert.deepEqual(closed, [1]);
});

test('native API copy does not retry unknown outcomes and preserves their original cause', async () => {
  let calls = 0;
  const nativeError = Object.assign(new Error('The broker exited before its terminal record.'), { code: 'OutcomeUnknown', outcome: { status: 'unknown', copied: false, cancelled: false } });
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({ invoke: async () => { calls++; throw nativeError; }, close() {} }) };
  const session = createCopySession({ platform: 'win32', nativeApi, spawn: () => assert.fail('The legacy worker must not start.') });
  await assert.rejects(session.copy(input), error => error.code === 'NativeOutcomeUnknown' && error.cause === nativeError && error.outcome.status === 'unknown');
  assert.equal(calls, 1);
  await session.dispose();
});

test('native copy accepts only a witnessed commit and exposes final partial identity separately', async () => {
  const committedError = Object.assign(new Error('The session closed after commit.'), { code: 'SessionClosed', outcome: { status: 'committed', copied: true, cancelled: false } });
  const committedApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({ invoke: async () => { throw committedError; }, close() {} }) };
  const committedSession = createCopySession({ platform: 'win32', nativeApi: committedApi });
  assert.deepEqual(await committedSession.copy(input), { copied: true, granular: true });
  await committedSession.dispose();

  const identity = { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' };
  const partialCause = Object.assign(new Error('Copy stopped with a partial stage.'), { code: 'CopyCancelled', outcome: { status: 'partial', copied: false, cancelled: true, ownedDestination: identity } });
  const partialApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({ invoke: async () => { throw partialCause; }, close() {} }) };
  const partialSession = createCopySession({ platform: 'win32', nativeApi: partialApi });
  await assert.rejects(partialSession.copy(input), error => error.name === 'AbortError' && error.code === 'NativeCopyPartial' && error.cause === partialCause && error.ownedDestination.path === 'C:\\temp\\.stage\\content' && error.ownedDestination.ino === '2');
  await partialSession.dispose();
});

test('disposing a native copy aborts and waits for the native result before closing the session', async () => {
  let closed = false, cancelled = false;
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({
    invoke: (_operation, _request, options) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => { cancelled = true; queueMicrotask(() => resolve({ status: 'unchanged', copied: false, cancelled: true })); }, { once: true });
    }),
    closeAsync: async () => { closed = true; }
  }) };
  const session = createCopySession({ platform: 'win32', nativeApi, spawn: () => assert.fail('The legacy worker must not start.') });
  const pending = session.copy(input);
  pending.catch(() => {});
  await session.dispose();
  await assert.rejects(pending, error => error.name === 'AbortError' && error.outcome.status === 'unchanged');
  assert.equal(cancelled, true);
  assert.equal(closed, true);
});
