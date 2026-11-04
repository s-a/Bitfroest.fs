const test = require('node:test');
const assert = require('node:assert/strict');
const { createCopySession } = require('../native-copy');

const request = {
  roots: ['/tmp/transfer-root'],
  source: '/tmp/transfer-root/source.bin',
  target: '/tmp/transfer-root/.stage/content',
  expected: { dev: '1', ino: '2', size: '8', mtimeNs: '3', ctimeNs: '4' }
};

function apiFor(invoke) {
  return {
    capabilities: { 'files.copy': { status: 'supported' } },
    openSession: () => ({ invoke, close() {} })
  };
}

test('Linux native copy treats backslashes as filename bytes while rejecting slash traversal', async () => {
  const session = createCopySession({ platform: 'linux', nativeApi: apiFor(async (_operation, input) => {
    assert.equal(input.source, '/tmp/transfer-root/a\\..\\b');
    return { status: 'committed', copied: true, cancelled: false };
  }) });
  try {
    await session.copy({ ...request, source: '/tmp/transfer-root/a\\..\\b' });
    await assert.rejects(session.copy({ ...request, source: '/tmp/transfer-root/a/../b' }), /Traversal/);
  } finally { await session.dispose(); }
});

test('Linux native copy reports byte progress, preserves an exclusive target and returns a witnessed commit', async () => {
  let captured;
  const events = [];
  const nativeApi = apiFor(async (operation, input, options) => {
    captured = { operation, input };
    options.onProgress({ transferred: 3, total: 8 });
    options.onProgress({ transferred: 8, total: 8 });
    return { status: 'committed', copied: true, cancelled: false };
  });
  const session = createCopySession({ platform: 'linux', nativeApi, copyFile: () => assert.fail('Portable copyFile path used.') });
  try {
    assert.deepEqual(await session.copy(request, { onProgress: event => events.push(event) }), { copied: true, granular: true });
    assert.equal(captured.operation, 'files.copy');
    assert.deepEqual(captured.input, request);
    assert.deepEqual(events.map(event => event.transferred), [3, 8]);
    assert.deepEqual(events.at(-1).overall, { kind: 'determinate', unit: 'bytes', completed: 8, total: 8 });
  } finally { await session.dispose(); }
});

test('Linux cancellation waits for the native outcome and does not retry an unknown result', async () => {
  let invocationCount = 0;
  let observedCancel = false;
  const nativeApi = apiFor((_operation, _input, options) => {
    invocationCount++;
    return new Promise(resolve => options.signal.addEventListener('abort', () => {
      observedCancel = true;
      queueMicrotask(() => resolve({ status: 'partial', copied: false, cancelled: true, ownedDestination: { dev: '1', ino: '9', size: '3', mtimeNs: '4', ctimeNs: '5' } }));
    }, { once: true }));
  });
  const controller = new AbortController();
  const session = createCopySession({ platform: 'linux', nativeApi });
  const pending = session.copy(request, { signal: controller.signal });
  pending.catch(() => {});
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'NativeCopyPartial' && error.ownedDestination.ino === '9');
  assert.equal(observedCancel, true);
  assert.equal(invocationCount, 1);
  await session.dispose();
});

test('Linux native unchanged outcome retains exclusive destination collision', async () => {
  const nativeApi = apiFor(async () => ({ status: 'unchanged', copied: false, cancelled: false }));
  const session = createCopySession({ platform: 'linux', nativeApi });
  try {
    await assert.rejects(session.copy(request), error => error.code === 'NativeOutcomeUnchanged' && error.outcome.status === 'unchanged');
  } finally { await session.dispose(); }
});
