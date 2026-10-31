const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { copyFileCancellable, createCopySession } = require('../native-copy');
async function fixture(t, bytes = 1024) {
  const root = (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-copy-')))).replace(/\\/g, '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = `${root}/source.bin`, target = `${root}/target.bin`;
  await fs.writeFile(source, Buffer.alloc(bytes, 17));
  const stat = await fs.stat(source, { bigint: true });
  return { root, source, target, input: { roots: [root], source, target, expected: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])])) } };
}
test('native copy preserves bytes, alternate data stream and source timestamp', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await fs.writeFile(`${f.source}:note`, 'stream data');
  await fs.utimes(f.source, new Date('2001-01-02T03:04:05Z'), new Date('2001-01-02T03:04:05Z'));
  const stat = await fs.stat(f.source, { bigint: true }); for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) f.input.expected[key] = String(stat[key]);
  const progress = []; await copyFileCancellable(f.input, { onProgress: value => progress.push(value) });
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.source));
  assert.equal(await fs.readFile(`${f.target}:note`, 'utf8'), 'stream data');
  assert.equal((await fs.stat(f.target)).mtimeMs, (await fs.stat(f.source)).mtimeMs);
  assert.ok(progress.length);
});
test('native callback abort stops mid-file and leaves no partial destination', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 32 * 1024 * 1024), controller = new AbortController();
  let progressSeen = false;
  await assert.rejects(copyFileCancellable(f.input, { signal: controller.signal, onProgress: event => { if (event.transferred < event.total) { progressSeen = true; controller.abort(); } } }), { name: 'AbortError' });
  assert.equal(progressSeen, true);
  assert.equal(await fs.readFile(f.target).catch(error => { assert.equal(error.code, 'ENOENT'); return null; }), null);
  assert.equal((await fs.stat(f.source)).size, 32 * 1024 * 1024);
});
test('native exclusive copy never replaces an independently created destination', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'EXTERNAL');
  await assert.rejects(copyFileCancellable(f.input));
  assert.equal(await fs.readFile(f.target, 'utf8'), 'EXTERNAL');
});

test('native copy rejects an exchanged source and preserves readonly attributes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await fs.rename(f.source, `${f.root}/saved.bin`); await fs.writeFile(f.source, 'FOREIGN');
  await assert.rejects(copyFileCancellable(f.input)); assert.equal(await fs.readFile(f.source, 'utf8'), 'FOREIGN');
  await fs.chmod(f.source, 0o444); t.after(() => fs.chmod(f.source, 0o666).catch(() => {}));
  const stat = await fs.stat(f.source, { bigint: true }); for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) f.input.expected[key] = String(stat[key]);
  await copyFileCancellable(f.input); assert.equal((await fs.stat(f.target)).mode & 0o222, 0);
  await fs.chmod(f.target, 0o666);
});

test('native abort of readonly source leaves no writable or readonly partial destination', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 32 * 1024 * 1024), controller = new AbortController();
  await fs.chmod(f.source, 0o444); const stat = await fs.stat(f.source, { bigint: true }); for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) f.input.expected[key] = String(stat[key]);
  await assert.rejects(copyFileCancellable(f.input, { signal: controller.signal, onProgress: event => { if (event.transferred < event.total) controller.abort(); } }), { name: 'AbortError' });
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' }); assert.equal((await fs.stat(f.source)).size, 32 * 1024 * 1024);
});

test('one native session copies multiple files with isolated identities and no process per file', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), session = createCopySession(); t.after(() => session.dispose());
  for (let index = 0; index < 8; index++) {
    const target = `${f.root}/target-${index}.bin`, progress = [];
    await session.copy({ ...f.input, target }, { onProgress: value => progress.push(value) });
    assert.deepEqual(await fs.readFile(target), await fs.readFile(f.source));
    assert.equal(progress.at(-1).transferred, 1024);
  }
  await session.dispose();
});

test('disposing an idle native session releases all source handles', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), session = createCopySession();
  await session.copy(f.input); await session.dispose();
  await fs.rename(f.source, `${f.root}/renamed.bin`);
  await assert.rejects(session.copy(f.input), /beendet/);
});
