const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-case-')));
  const api = require('../native-api').createNativeApi(require(binary));
  const session = api.openSession();
  t.after(async () => { api.shutdown(); assert.ok(root.startsWith(await fs.realpath(os.tmpdir()))); await fs.rm(root, { recursive: true, force: true }); });
  return { root, session, source: path.join(root, 'lower.txt'), target: path.join(root, 'LOWER.txt') };
}
async function request(f) {
  const stat = await fs.lstat(f.source, { bigint: true });
  return { source: f.source, target: f.target, roots: [f.root], expected: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])])) };
}

test('native case rename preserves the file object and bytes without an intermediate name', windows, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.source, 'ORIGINAL');
  const input = await request(f);
  const result = await f.session.invoke('files.rename', input);
  assert.equal(result.status, 'committed');
  assert.equal(result.renamed, true);
  assert.deepEqual(await fs.readdir(f.root), ['LOWER.txt']);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'ORIGINAL');
  assert.equal(String((await fs.lstat(f.target, { bigint: true })).ino), input.expected.ino);
});

test('native directory case rename preserves nested contents', windows, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.source); await fs.writeFile(path.join(f.source, 'child'), 'CHILD');
  await f.session.invoke('files.rename', await request(f));
  assert.deepEqual(await fs.readdir(f.root), ['LOWER.txt']);
  assert.equal(await fs.readFile(path.join(f.target, 'child'), 'utf8'), 'CHILD');
});

test('native rename supports Unicode names and paths longer than MAX_PATH', windows, async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, ...Array.from({ length: 8 }, (_, i) => `directory-${i}-${'x'.repeat(30)}`));
  await fs.mkdir(folder, { recursive: true });
  const inputPaths = { ...f, source: path.join(folder, 'grüße-文件.txt'), target: path.join(folder, 'GRÜßE-文件.txt') };
  await fs.writeFile(inputPaths.source, 'LONG UNICODE');
  await f.session.invoke('files.rename', await request(inputPaths));
  assert.deepEqual(await fs.readdir(folder), ['GRÜßE-文件.txt']);
  assert.equal(await fs.readFile(inputPaths.target, 'utf8'), 'LONG UNICODE');
});

test('exchanged and changed sources are rejected before mutation', windows, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.source, 'ORIGINAL');
  const input = await request(f);
  await fs.rename(f.source, path.join(f.root, 'saved'));
  await fs.writeFile(f.source, 'EXTERNAL');
  await assert.rejects(f.session.invoke('files.rename', input), { code: 'IdentityChanged' });
  assert.equal(await fs.readFile(f.source, 'utf8'), 'EXTERNAL');
  const changed = await request(f);
  await fs.writeFile(f.source, 'LONGER EXTERNAL CONTENT');
  await assert.rejects(f.session.invoke('files.rename', changed), { code: 'IdentityChanged' });
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['lower.txt', 'saved']);
});

test('same-sized edits with restored mtime remain rejected by change time', windows, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.source, 'ORIGINAL'); await fs.utimes(f.source, 1000000000, 1000000000);
  const input = await request(f);
  await new Promise(resolve => setTimeout(resolve, 30));
  await fs.writeFile(f.source, 'EXTERNAL'); await fs.utimes(f.source, 1000000000, 1000000000);
  await assert.rejects(f.session.invoke('files.rename', input), { code: 'IdentityChanged' });
  assert.equal(await fs.readFile(f.source, 'utf8'), 'EXTERNAL');
});

test('reparse ancestors and source links cannot redirect a native rename', windows, async t => {
  const f = await fixture(t);
  const real = path.join(f.root, 'real'), link = path.join(f.root, 'link');
  await fs.mkdir(real); await fs.writeFile(path.join(real, 'lower.txt'), 'EXTERNAL');
  await fs.symlink(real, link, 'junction');
  const input = await request({ ...f, source: path.join(link, 'lower.txt'), target: path.join(link, 'LOWER.txt') });
  await assert.rejects(f.session.invoke('files.rename', input), { code: 'ReparsePoint' });
  assert.deepEqual(await fs.readdir(real), ['lower.txt']);
  await fs.symlink(real, f.source, 'junction');
  await assert.rejects(f.session.invoke('files.rename', await request(f)), { code: 'ReparsePoint' });
  assert.deepEqual(await fs.readdir(real), ['lower.txt']);
});

test('scope, path and identity validation cannot create mutations', windows, async t => {
  const f = await fixture(t); await fs.writeFile(f.source, 'ORIGINAL');
  const input = await request(f);
  for (const invalid of [null, {}, { ...input, expected: {} }, { ...input, roots: [] }, { ...input, roots: [f.root + '-other'] }, { ...input, source: 'relative' }, { ...input, target: input.source }, { ...input, target: input.target + ':stream' }, { ...input, target: path.join(f.root, 'other') }, { ...input, source: input.source + '\0suffix' }, { ...input, target: f.root + '\\..\\' + path.basename(f.root) + '\\LOWER.txt' }]) {
    assert.throws(() => f.session.invoke('files.rename', invalid), { code: 'InvalidRequest' });
  }
  assert.deepEqual(await fs.readdir(f.root), ['lower.txt']);
});

test('an existing writable handle prevents commit and reports the actual request identity', windows, async t => {
  const f = await fixture(t); await fs.writeFile(f.source, 'ORIGINAL');
  const input = await request(f), handle = await fs.open(f.source, 'r+');
  try {
    await assert.rejects(f.session.invoke('files.rename', input), error => error.code === 'Busy' && error.operation === 'files.rename' && error.requestId === 1n && error.generation === f.session.generation && error.outcome?.status === 'unchanged');
  } finally { await handle.close(); }
  assert.deepEqual(await fs.readdir(f.root), ['lower.txt']);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'ORIGINAL');
  assert.equal((await f.session.invoke('files.rename', input)).status, 'committed');
});

test('closing during rename always reports whether the mutation committed', windows, async t => {
  const f = await fixture(t); await fs.writeFile(f.source, 'ORIGINAL');
  const pending = f.session.invoke('files.rename', await request(f));
  f.session.close();
  let outcome;
  try { outcome = await pending; } catch (error) {
    assert.equal(error.code, 'SessionClosed');
    assert.equal(error.requestId, 1n);
    assert.equal(error.generation, f.session.generation);
    outcome = error.outcome;
  }
  const entries = await fs.readdir(f.root);
  assert.deepEqual(entries, [outcome?.status === 'committed' ? 'LOWER.txt' : 'lower.txt']);
  assert.equal(await fs.readFile(path.join(f.root, entries[0]), 'utf8'), 'ORIGINAL');
});
