const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' };

test('native window inspection exposes a read-only contract without accepting arbitrary targets', windows, async () => {
  const binding = require(binary), session = binding.openSession();
  try {
    assert.notEqual(binding.capabilities['windows.inspect']?.status, undefined);
    for (const value of [null, [], { processId: 1 }, { handle: '1' }, { titleToken: 'arbitrary' }]) assert.throws(() => session.invoke('windows.inspect', value), { code: 'InvalidRequest' });
    const result = await session.invoke('windows.inspect', {});
    assert.equal(result.version, 1); assert.equal(result.readOnly, true);
    assert.equal(result.processId, process.pid);
    assert.ok(Array.isArray(result.windows)); assert.ok(result.windows.length <= 64);
    assert.equal(typeof result.truncated, 'boolean');
    for (const window of result.windows) {
      assert.equal(typeof window.handle, 'string');
      assert.equal(typeof window.visible, 'boolean');
      assert.equal(typeof window.rect.width, 'number');
      assert.equal(typeof window.processCreated, 'string');
      assert.equal(Object.hasOwn(window, 'title'), false);
    }
  } finally { session.close(); }
});
