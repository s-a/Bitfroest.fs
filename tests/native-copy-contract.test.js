const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('compiled copy exposes separate cancellation functions and preserves a completed destination', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-contract-')));
  const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
  const contents = Buffer.from([0, 17, 255, 32]);
  await fs.writeFile(source, contents);
  const stat = await fs.stat(source, { bigint: true });
  const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
  const session = require(binary).openSession();
  t.after(async () => { session.close(); await session.whenClosed(); await fs.rm(root, { recursive: true, force: true }); });
  const copy = session.invoke('files.copy', { roots: [root], source, target, expected });
  copy.catch(() => {});
  assert.equal(typeof copy.cancel, 'function');
  assert.equal(typeof copy.cancelIo, 'function');
  assert.notEqual(copy.cancel, copy.cancelIo);
  assert.equal((await copy).status, 'committed');
  copy.cancelIo();
  copy.cancel();
  assert.deepEqual(await fs.readFile(target), contents);
  assert.deepEqual(await fs.readFile(source), contents);
});
