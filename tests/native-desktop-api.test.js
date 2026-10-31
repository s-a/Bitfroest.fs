const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' };

test('native association requests reject invalid input before starting a broker', windows, () => {
  const session = require(binary).openSession();
  try {
    for (const request of [null, {}, { path: 'relative.txt' }, { path: 'C:relative.txt' },
      { path: 'C:\\file\0.txt' }, { path: 'C:\\file.txt', inspectOnly: 'true' },
      { path: 'C:\\' + 'x'.repeat(32768), inspectOnly: true }]) {
      assert.throws(() => session.invoke('shell.openAssociated', request), { code: 'InvalidRequest' });
    }
  } finally { session.close(); }
});

test('native association inspection returns a structured missing-file error without opening an application', windows, async () => {
  const session = require(binary).openSession();
  try {
    const missing = path.join(__dirname, `absent-association-${process.pid}-${Date.now()}.txt`);
    await assert.rejects(session.invoke('shell.openAssociated', { path: missing, inspectOnly: true }),
      error => error.code === 'NotFound' && error.nativeCode === 2 && error.operation === 'shell.openAssociated');
  } finally { session.close(); }
});

test('native association inspection preserves files without an extension or registered association', windows, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-association-'));
  const session = require(binary).openSession();
  try {
    for (const name of ['no-extension', 'file.unknown-association-573eaf']) {
      const target = path.join(directory, name);
      await fs.writeFile(target, 'unchanged');
      assert.deepEqual(await session.invoke('shell.openAssociated', { path: target, inspectOnly: true }), { editor: false });
      assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
    }
  } finally { session.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
