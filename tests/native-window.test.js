const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');
const token = '9c379752-2049-4716-bb59-2d8116374693';

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
