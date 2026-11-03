const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' };

test('native window inspection scopes hidden-window lookup without revealing any windows', windows, async () => {
  const session = require(binary).openSession();
  const titleToken = require('node:crypto').randomUUID();
  try {
    const result = await session.invoke('windows.inspect', { titleToken });
    assert.equal(result.titleToken, titleToken);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.windows, []);
    for (const request of [{ titleToken: '' }, { titleToken: null }, { titleToken: 1 }, { titleToken: 'short' }, { titleToken: 'x'.repeat(129) }, { titleToken: titleToken + '\0' }, { titleToken, extra: true }]) {
      assert.throws(() => session.invoke('windows.inspect', request), { code: 'InvalidRequest' });
    }
  } finally { session.close(); }
});

test('native maximize rejects an unscoped title before accessing windows', windows, () => {
  const session = require(binary).openSession();
  try {
    for (const request of [null, {}, { titleToken: '' }, { titleToken: 'short' }, { titleToken: 'x'.repeat(129) }, { titleToken: 'x'.repeat(20) + '\0' }]) {
      assert.throws(() => session.invoke('windows.maximize', request), { code: 'InvalidRequest' });
    }
  } finally { session.close(); }
});

test('native trash inspection validates its request without opening a window', windows, async () => {
  const session = require(binary).openSession();
  try {
    for (const request of [null, [], { inspectOnly: 'yes' }]) {
      assert.throws(() => session.invoke('shell.openTrash', request), { code: 'InvalidRequest' });
    }
    const result = await session.invoke('shell.openTrash', { inspectOnly: true });
    assert.equal(result.available, true);
    assert.equal(result.requested, false);
  } finally { session.close(); }
});
