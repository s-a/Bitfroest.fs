const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');
const token = '9c379752-2049-4716-bb59-2d8116374693';

test('scoped window inspection binds its response to the requested title token', async () => {
  const calls = []; let closed = 0;
  const nativeApi = { openSession: () => ({ invoke: async (operation, request) => {
    calls.push({ operation, request }); return { version: 1, readOnly: true, titleToken: token, windows: [], truncated: false };
  }, close() { closed++; } }) };
  await require('../native-window').inspectWindows({ nativeApi, titleToken: token });
  assert.deepEqual(calls, [{ operation: 'windows.inspect', request: { titleToken: token } }]);
  assert.equal(closed, 1);
  nativeApi.openSession = () => ({ invoke: async () => ({ version: 1, readOnly: true, windows: [] }), close() { closed++; } });
  await assert.rejects(require('../native-window').inspectWindows({ nativeApi, titleToken: token }), { code: 'InvalidNativeResponse' });
  assert.equal(closed, 2);
});

test('disposing a pending window inspection closes its session and rejects a late response', async () => {
  const controller = new AbortController(); let resolve, closed = 0;
  const nativeApi = { openSession: () => ({ invoke: () => new Promise(done => { resolve = done; }), close() { closed++; } }) };
  const pending = require('../native-window').inspectWindows({ nativeApi, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(closed, 1);
  resolve({ version: 1, readOnly: true, windows: [] });
  assert.equal(closed, 1);
});

test('read-only window inspection never invokes maximization and closes its own session', async () => {
  const calls = []; let closed = false;
  const nativeApi = { openSession: () => ({ invoke: async (operation, request) => {
    calls.push({ operation, request }); return { version: 1, readOnly: true, windows: [], truncated: false };
  }, close() { closed = true; } }) };
  const result = await require('../native-window').inspectWindows({ nativeApi });
  assert.equal(result.readOnly, true);
  assert.deepEqual(calls, [{ operation: 'windows.inspect', request: {} }]); assert.equal(closed, true);
});

test('older bindings report unavailable inspection without substituting a window action', async () => {
  const nativeApi = { capabilities: { 'windows.inspect': { status: 'unsupported' } }, openSession: () => assert.fail('An unavailable inspection cannot open a native session.') };
  const result = await require('../native-window').inspectWindows({ nativeApi });
  assert.equal(result.available, false);
});

test('window maximization default uses one scoped native request and releases its session', async t => {
  const app = stubPackagedNativeBinding(t, { 'windows.maximize': () => ({ maximized: true }) });
  const { maximizeWindow } = require('../native-window');
  assert.deepEqual(await maximizeWindow(token), { maximized: true });
  assert.deepEqual(app.calls, [{ operation: 'windows.maximize', request: { titleToken: token } }]);
  assert.equal(app.sessions[0].closed, true);
});

test('window maximization rejects an unconfirmed result and always releases its session', async () => {
  const { maximizeWindow } = require('../native-window');
  for (const result of [undefined, null, {}, { maximized: false }]) {
    let closed = 0;
    const nativeApi = { openSession: () => ({ invoke: async () => result, close() { closed++; } }) };
    await assert.rejects(maximizeWindow(token, { nativeApi }), { code: 'InvalidNativeResponse' });
    assert.equal(closed, 1);
  }
});

test('window maximization deadline closes the native request and ignores a late success', async () => {
  const { maximizeWindow } = require('../native-window');
  let complete, closed = 0;
  const nativeApi = { openSession: () => ({ invoke: () => new Promise(resolve => { complete = resolve; }), close() { closed++; } }) };
  const request = maximizeWindow(token, { nativeApi, timeout: 2 });
  await assert.rejects(request, { code: 'WindowTimeout' });
  assert.equal(closed, 1);
  complete({ maximized: true });
  await assert.rejects(request, { code: 'WindowTimeout' });
});
