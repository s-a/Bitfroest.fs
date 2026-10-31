const test = require('node:test');
const assert = require('node:assert/strict');
const { createCopySession } = require('../native-copy');
const input = { roots: ['C:/tmp', 'C:/temp'], source: 'C:/tmp/a.bin', target: 'C:/temp/.stage/content', expected: { dev: '1', ino: '2', size: '100', mtimeNs: '10', ctimeNs: '11' } };
function fixture(invoke) {
  const state = { opened: 0, closed: 0 };
  const nativeApi = { capabilities: { 'files.copy': { status: 'supported' } }, openSession() {
    state.opened++;
    return { invoke, async closeAsync() { state.closed++; } };
  } };
  return { state, session: createCopySession({ platform: 'win32', nativeApi }) };
}

test('one transfer session reuses one native resource and isolates old progress callbacks', async () => {
  const callbacks = [], progress = [];
  const { session, state } = fixture(async (_operation, _request, options) => {
    if (callbacks.length) callbacks[0]({ transferred: 99, total: 100 });
    callbacks.push(options.onProgress);
    options.onProgress({ transferred: 100, total: 100 });
    return { status: 'committed', copied: true };
  });
  await session.copy(input, { onProgress: event => progress.push(event.transferred) });
  await session.copy({ ...input, target: 'C:/temp/.stage/second' }, { onProgress: event => progress.push(event.transferred) });
  assert.deepEqual(progress, [100, 100]);
  assert.equal(state.opened, 1);
  await session.dispose();
  assert.equal(state.closed, 1);
  await assert.rejects(session.copy(input), /beendet/);
});

test('disposing an active transfer cancels and waits for its terminal result', async () => {
  let stopped = false, cancelled = false;
  const { session, state } = fixture((_operation, _request, options) => new Promise(resolve => {
    options.signal.addEventListener('abort', () => {
      cancelled = true;
      setImmediate(() => { stopped = true; resolve({ status: 'unchanged', copied: false, cancelled: true }); });
    }, { once: true });
  }));
  const pending = session.copy(input); pending.catch(() => {});
  const closing = session.dispose();
  assert.equal(cancelled, true);
  assert.equal(state.closed, 0);
  assert.equal(closing, session.dispose());
  await assert.rejects(pending, { name: 'AbortError' });
  await closing;
  assert.equal(stopped, true);
  assert.equal(state.closed, 1);
});

test('one session rejects overlapping copies and signals only the active native request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const { session } = fixture((_operation, _request, options) => new Promise(resolve => {
    calls++;
    options.signal.addEventListener('abort', () => resolve({ status: 'unchanged', copied: false, cancelled: true }), { once: true });
  }));
  const pending = session.copy(input, { signal: controller.signal });
  await assert.rejects(session.copy(input), /aktiv/);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  await session.dispose();
});

test('disposing an unused transfer never opens a native resource', async () => {
  const { session, state } = fixture(() => assert.fail('An unused session must remain lazy.'));
  await session.dispose(); await session.dispose();
  assert.equal(state.opened, 0);
  await assert.rejects(session.copy(input), /beendet/);
});

test('ordinary errors allow session reuse while a cancelled transfer ends its session', async () => {
  let calls = 0;
  const { session } = fixture(async () => {
    if (++calls === 1) throw Object.assign(new Error('denied'), { code: 'Denied', outcome: { status: 'unchanged', copied: false, cancelled: false } });
    return { status: 'unchanged', copied: false, cancelled: true };
  });
  await assert.rejects(session.copy(input), { code: 'Denied' });
  await assert.rejects(session.copy(input), { name: 'AbortError' });
  await assert.rejects(session.copy(input), /beendet/);
  assert.equal(calls, 2);
  await session.dispose();
});

test('missing and inconsistent terminal outcomes fail closed without an automatic retry', async () => {
  for (const result of [undefined, null, {}, { status: 'committed', copied: false }, { status: 'unchanged', copied: true }]) {
    let calls = 0;
    const { session } = fixture(async () => { calls++; return result; });
    await assert.rejects(session.copy(input), { code: 'NativeOutcomeUnknown' });
    assert.equal(calls, 1);
    await session.dispose();
  }
});
