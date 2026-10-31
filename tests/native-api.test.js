const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createNativeApi } = require('../native-api');

test('missing packaged bindings fail explicitly without a build or interpreter fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-loader-'));
  try {
    const copy = path.join(root, 'native-api.js');
    await fs.copyFile(path.join(__dirname, '../native-api.js'), copy);
    assert.throws(() => require(copy).loadNativeApi(), error => error.code === 'BindingUnavailable' && error.cause?.code === 'MODULE_NOT_FOUND');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('incompatible bindings fail before opening a session', () => {
  let opened = false;
  assert.throws(() => createNativeApi({ apiVersion: { major: 2, minor: 0 }, openSession() { opened = true; } }), { code: 'IncompatibleBinding' });
  assert.equal(opened, false);
});

test('closed sessions reject work and close their native resource exactly once', () => {
  let closes = 0;
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: {}, openSession: () => ({ close() { closes++; } }) });
  const session = api.openSession();
  session.close(); session.close();
  assert.equal(closes, 1);
  assert.throws(() => session.invoke('metadata.query', {}), { code: 'SessionClosed' });
});

test('shutdown closes every session and prevents reopening', () => {
  let closes = 0;
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: {}, openSession: () => ({ close() { closes++; } }) });
  api.openSession(); api.openSession(); api.shutdown(); api.shutdown();
  assert.equal(closes, 2);
  assert.throws(() => api.openSession(), { code: 'SessionClosed' });
});

test('unknown and unavailable operations never reach the binding', () => {
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: {}, openSession: () => ({ close() {}, invoke() { assert.fail('unexpected invocation'); } }) });
  const session = api.openSession();
  assert.throws(() => session.invoke('runShell', {}), { code: 'UnknownOperation' });
  assert.throws(() => session.invoke('metadata.query', {}), { code: 'UnsupportedOperation' });
  api.shutdown();
});

test('requests reject delayed success after close', async () => {
  let complete;
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'metadata.query': { status: 'supported' } }, openSession: () => ({ generation: 9n, close() {}, invoke: () => new Promise(resolve => { complete = resolve; }) }) });
  const session = api.openSession();
  const pending = session.invoke('metadata.query', { path: __filename });
  session.close();
  complete({ attributes: {} });
  await assert.rejects(pending, { code: 'SessionClosed' });
  api.shutdown();
});

test('closing after a committed mutation retains the outcome and request identity', async () => {
  let complete;
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.rename': { status: 'conditional' } }, openSession: () => ({ generation: 9n, close() {}, invoke: () => new Promise(resolve => { complete = resolve; }) }) });
  const s = api.openSession();
  const pending = s.invoke('files.rename', {}); s.close();
  complete({ status: 'committed', renamed: true });
  await assert.rejects(pending, error => error.code === 'SessionClosed' && error.outcome?.status === 'committed' && error.requestId === 1n && error.generation === 9n);
});

test('native failures retain their outcome and carry the originating request identity', async () => {
  const outcome = { status: 'committed', renamed: true };
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.rename': { status: 'conditional' } }, openSession: () => ({ generation: 10n, close() {}, invoke: async () => { throw Object.assign(new Error('closed'), { code: 'SessionClosed', outcome, nativeCode: 0 }); } }) });
  const s = api.openSession();
  await assert.rejects(s.invoke('files.rename', {}), error => error.code === 'SessionClosed' && error.outcome === outcome && error.requestId === 1n && error.generation === 10n && error.operation === 'files.rename');
  api.shutdown();
});

test('closing after Linux lock completion preserves its committed or partial mutation outcome', async () => {
  for (const outcome of [{ status: 'committed', changed: 1, signalled: 1 }, { status: 'partial', changed: 1, signalled: 2 }]) {
    let complete;
    const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'processes.terminate': { status: 'conditional' } }, openSession: () => ({ generation: 12n, close() {}, invoke: () => new Promise(resolve => { complete = resolve; }) }) });
    const session = api.openSession();
    const pending = session.invoke('processes.terminate', {});
    complete({ changed: outcome.changed, errors: [], outcome });
    session.close();
    await assert.rejects(pending, error => error.code === 'SessionClosed' && error.outcome === outcome && error.operation === 'processes.terminate' && error.generation === 12n);
    api.shutdown();
  }
});

test('completed requests have unique identifiers bound to their native session', async () => {
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'metadata.query': { status: 'supported' } }, openSession: () => ({ generation: 9n, close() {}, invoke: async () => ({ provenance: 'test' }) }) });
  const session = api.openSession();
  const a = await session.invoke('metadata.query', {});
  const b = await session.invoke('metadata.query', {});
  assert.equal(a.generation, 9n);
  assert.equal(b.generation, 9n);
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(a.provenance, 'test');
  api.shutdown();
});

test('stream decoder requests preserve continuation state through the facade', async () => {
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'encoding.decodeChunk': { status: 'supported' } }, openSession: () => ({ generation: 3n, close() {}, invoke: async operation => { assert.equal(operation, 'encoding.decodeChunk'); return { text: '', pending: Buffer.from([0xe2]), mapStart: 0, encoding: '65001' }; } }) });
  const result = await api.openSession().invoke('encoding.decodeChunk', { codepage: 65001, bytes: Buffer.from([0xe2]), final: false, pending: Buffer.alloc(0), offset: 0, mapStart: 0 });
  assert.deepEqual(result.pending, Buffer.from([0xe2]));
  assert.equal(result.generation, 3n);
  api.shutdown();
});

test('copy progress and cancellation stay bound to the originating request', async () => {
  let progress, complete, cancels = 0;
  const events = [], controller = new AbortController();
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({ generation: 4n, close() {}, invoke(_operation, _request, callback) {
    progress = callback;
    const promise = new Promise(resolve => { complete = resolve; });
    promise.cancel = () => { cancels++; };
    return promise;
  } }) });
  const pending = api.openSession().invoke('files.copy', {}, { signal: controller.signal, onProgress: event => events.push(event) });
  assert.equal(typeof progress, 'function');
  progress({ transferred: 5, total: 10 });
  controller.abort();
  progress({ transferred: 10, total: 10 });
  complete({ status: 'committed', copied: true });
  assert.equal((await pending).status, 'committed');
  assert.equal(cancels, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, 1n);
  assert.equal(events[0].generation, 4n);
  api.shutdown();
});

test('copy cancellation requests native I/O cancellation only after the existing five second grace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete, soft = 0, io = 0;
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({
    generation: 1n, close() {}, invoke() {
      const promise = new Promise(resolve => { complete = resolve; });
      promise.cancel = () => { soft++; };
      promise.cancelIo = () => { io++; };
      return promise;
    }
  }) });
  const controller = new AbortController();
  const pending = api.openSession().invoke('files.copy', {}, { signal: controller.signal });
  controller.abort();
  assert.equal(soft, 1);
  t.mock.timers.tick(4999);
  assert.equal(io, 0);
  t.mock.timers.tick(1);
  assert.equal(io, 1);
  complete({ status: 'unchanged', copied: false, cancelled: true });
  assert.equal((await pending).status, 'unchanged');
  t.mock.timers.tick(5000);
  assert.equal(io, 1);
  api.shutdown();
});

test('copy I/O cancellation retries an early attempt while its original request is still pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete, attempts = 0;
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({
    generation: 1n, close() {}, invoke() {
      const promise = new Promise(resolve => { complete = resolve; });
      promise.cancel = () => {};
      promise.cancelIo = () => { attempts++; };
      return promise;
    }
  }) });
  const controller = new AbortController();
  const pending = api.openSession().invoke('files.copy', {}, { signal: controller.signal });
  controller.abort();
  t.mock.timers.tick(5000);
  assert.equal(attempts, 1);
  t.mock.timers.tick(100);
  assert.equal(attempts, 2);
  complete({ status: 'unchanged', copied: false, cancelled: true });
  await pending;
  t.mock.timers.tick(100);
  assert.equal(attempts, 2);
  api.shutdown();
});

test('a completed copy cancels its escalation timer before another request reuses the session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({
    generation: 1n, close() {}, invoke() {
      const request = { soft: 0, io: 0 };
      const promise = new Promise(resolve => { request.complete = resolve; });
      promise.cancel = () => { request.soft++; };
      promise.cancelIo = () => { request.io++; };
      requests.push(request); return promise;
    }
  }) });
  const session = api.openSession(), first = new AbortController();
  const pending = session.invoke('files.copy', {}, { signal: first.signal });
  first.abort();
  requests[0].complete({ status: 'committed', copied: true });
  assert.equal((await pending).status, 'committed');
  const next = new AbortController();
  const second = session.invoke('files.copy', {}, { signal: next.signal });
  t.mock.timers.tick(5000);
  assert.equal(requests[0].io, 0);
  assert.equal(requests[1].io, 0);
  next.abort();
  t.mock.timers.tick(5000);
  assert.equal(requests[1].io, 1);
  requests[1].complete({ status: 'unchanged', copied: false, cancelled: true });
  await second;
  api.shutdown();
});

test('Git status does not request native progress when there is no subscriber', async () => {
  const callbacks = [];
  const api = createNativeApi({
    apiVersion: { major: 1, minor: 0 },
    capabilities: { 'git.status': { status: 'supported' } },
    openSession: () => ({ generation: 1n, close() {}, invoke(_operation, _request, callback) { callbacks.push(callback); return Promise.resolve({ repository: true }); } })
  });
  await api.openSession().invoke('git.status', { directory: 'repo', scope: '.' });
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0], undefined);
  api.shutdown();
});

test('copy progress failures cancel work and preserve the terminal outcome', async () => {
  let progress, complete, cancels = 0;
  const cause = new Error('progress handler failed');
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({ generation: 5n, close() {}, invoke(_operation, _request, callback) {
    progress = callback;
    const promise = new Promise(resolve => { complete = resolve; });
    promise.cancel = () => { cancels++; };
    return promise;
  } }) });
  const pending = api.openSession().invoke('files.copy', {}, { onProgress() { throw cause; } });
  assert.equal(typeof progress, 'function');
  assert.doesNotThrow(() => progress({ transferred: 0, total: 10 }));
  complete({ status: 'partial', copied: false });
  await assert.rejects(pending, error => error.code === 'ProgressCallbackFailed' && error.cause === cause && error.outcome?.status === 'partial');
  assert.equal(cancels, 1);
  api.shutdown();
});

test('copy cancellation after a progress failure retains both the failure and owned destination', async () => {
  let progress, rejectNative;
  const cause = new Error('progress failed');
  const ownedDestination = { dev: '1', ino: '2' };
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: { 'files.copy': { status: 'supported' } }, openSession: () => ({ generation: 6n, close() {}, invoke(_operation, _request, callback) {
    progress = callback;
    const promise = new Promise((_resolve, reject) => { rejectNative = reject; }); promise.cancel = () => {};
    return promise;
  } }) });
  const pending = api.openSession().invoke('files.copy', {}, { onProgress() { throw cause; } });
  progress({ transferred: 0, total: 10 });
  rejectNative(Object.assign(new Error('copy cancelled'), { code: 'Cancelled', outcome: { status: 'partial' }, ownedDestination }));
  await assert.rejects(pending, error => error.code === 'ProgressCallbackFailed' && error.cause === cause && error.outcome?.status === 'partial' && error.ownedDestination === ownedDestination);
  api.shutdown();
});

test('asynchronous session close acknowledges native resource shutdown', async () => {
  let release, closes = 0, finished = false;
  const nativeClosed = new Promise(resolve => { release = resolve; });
  const api = createNativeApi({ apiVersion: { major: 1, minor: 0 }, capabilities: {}, openSession: () => ({ generation: 1n, close() { closes++; }, whenClosed: () => nativeClosed }) });
  const session = api.openSession();
  const closing = session.closeAsync().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(closes, 1);
  release(); await closing; await api.shutdownAsync();
  assert.equal(finished, true);
});
