const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('native copy confirms the destination after the server finalizes write timestamps', { skip: process.platform !== 'win32' }, async t => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-source-'));
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
  const targetRoot = await fs.mkdtemp(path.join(process.env.NATIVE_COPY_NETWORK_TEST_ROOT || os.tmpdir(), '.native-copy-target-'));
  t.after(() => fs.rm(targetRoot, { recursive: true, force: true }));
  const binding = require(process.env.NATIVE_BINDING_TEST_PATH || '../native/binding.node');
  const session = binding.openSession();
  t.after(async () => { session.close(); await session.whenClosed(); });
  for (const size of [0, 1024, 1024 * 1024]) {
    const source = path.join(sourceRoot, `source-${size}.bin`), target = path.join(targetRoot, `target-${size}.bin`);
    const bytes = Buffer.alloc(size, 17);
    await fs.writeFile(source, bytes);
    const timestamp = new Date('2001-01-02T03:04:05Z');
    await fs.utimes(source, timestamp, timestamp);
    const stat = await fs.stat(source, { bigint: true });
    const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
    const outcome = await session.invoke('files.copy', { roots: [sourceRoot, targetRoot], source, target, expected });
    assert.equal(outcome.status, 'committed');
    assert.equal(outcome.copied, true);
    const final = await fs.stat(target, { bigint: true });
    assert.deepEqual(outcome.ownedDestination, Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(final[key])])));
    assert.equal(final.mtimeNs, stat.mtimeNs);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.deepEqual(await fs.readFile(source), bytes);
  }
});
