const test = require('node:test');
const assert = require('node:assert/strict');
test('unsupported macOS trash view reports the limitation without invoking an interpreter', async () => {
  const { openTrash } = require('../open-trash');
  let calls = 0;
  await assert.rejects(openTrash({ platform: 'darwin', executeFile() { calls++; } }), { code: 'ENOTSUPPORTED' });
  assert.equal(calls, 0);
});

for (const platform of ['win32', 'linux']) test(`${platform} trash view default uses the packaged native binding and closes its session`, async t => {
  const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');
  const app = stubPackagedNativeBinding(t, { 'shell.openTrash': () => ({ available: true, requested: true }) });
  const { openTrash } = require('../open-trash');
  assert.deepEqual(await openTrash({ platform, executeFile: () => assert.fail('The trash view must use the native module.') }), { requested: true });
  assert.deepEqual(app.calls, [{ operation: 'shell.openTrash', request: { inspectOnly: false } }]);
  assert.equal(app.sessions[0].closed, true);
});

test('Windows trash opening rejects unconfirmed requests and closes on native errors', async () => {
  const { openTrash } = require('../open-trash');
  for (const value of [null, {}, { available: true, requested: false }, new Error('access denied')]) {
    let closed = 0;
    const nativeApi = { openSession: () => ({ invoke: async () => { if (value instanceof Error) throw value; return value; }, close() { closed++; } }) };
    await assert.rejects(openTrash({ platform: 'win32', nativeApi }), /nicht geöffnet/);
    assert.equal(closed, 1);
  }
});

test('Windows trash opening deadline closes its session without retrying a late result', async () => {
  const { openTrash } = require('../open-trash');
  let finish, closed = 0;
  const nativeApi = { openSession: () => ({ invoke: () => new Promise(resolve => { finish = resolve; }), close() { closed++; } }) };
  const invocation = openTrash({ platform: 'win32', nativeApi, timeout: 2 });
  await assert.rejects(invocation, /Zeitlimit/);
  assert.equal(closed, 1);
  finish({ available: true, requested: true });
  await assert.rejects(invocation, /Zeitlimit/);
});
test('missing capabilities, launch errors and timeouts are explicit and never use a filesystem fallback', async () => {
  const { openTrash } = require('../open-trash'); let called = false;
  await assert.rejects(openTrash({ platform: 'freebsd', executeFile() { called = true; } }), { code: 'ENOTSUPPORTED' }); assert.equal(called, false);
  for (const [failure, expected] of [[{ code: 'ENOENT' }, /nicht verfügbar/], [{ code: 'ETIMEDOUT' }, /Zeitlimit/], [{ code: 'EACCES' }, /nicht geöffnet/]]) {
    let calls = 0;
    const nativeApi = { openSession: () => ({ close() {}, invoke() { calls++; throw Object.assign(new Error('blocked'), failure); } }) };
    await assert.rejects(openTrash({ platform: 'linux', nativeApi }), expected);
    assert.equal(calls, 1);
  }
});
