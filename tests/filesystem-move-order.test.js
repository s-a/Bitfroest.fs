const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const slash = value => value.replace(/\\/g, '/');
async function fixture(t, copy) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-move-order-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const left = slash(path.join(directory, 'left')), right = slash(path.join(directory, 'right'));
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/source.bin`, Buffer.from([0, 2, 4, 6]));
  const adapter = Object.create(fs); adapter.copyFile = (source, target, flags) => copy(source, target, flags, { left, right });
  const provider = createProvider({ roots: [left, right], fs: adapter });
  const before = await provider.load(), after = structuredClone(before), file = after.folders[left][0];
  after.folders[left] = []; after.folders[right].push({ ...file, id: 'moved' });
  return { provider, before, after, left, right };
}
test('a slow move keeps its original source path until the verified destination exists', async t => {
  let release, entered;
  const copying = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const { provider, before, after, left, right } = await fixture(t, async (source, target, flags) => {
    entered(); await wait; return fs.copyFile(source, target, flags);
  });
  const operation = provider.apply(before, after);
  await copying;
  const sourceStillPresent = await fs.readFile(`${left}/source.bin`).then(() => true, () => false);
  const targetBeforeCompletion = await fs.stat(`${right}/source.bin`).then(() => true, () => false);
  release(); await operation;
  assert.equal(sourceStillPresent, true);
  assert.equal(targetBeforeCompletion, false);
  await assert.rejects(fs.stat(`${left}/source.bin`), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(`${right}/source.bin`), Buffer.from([0, 2, 4, 6]));
});
test('a failed move keeps the original source readable and the old destination intact', async t => {
  let originalWasPresent;
  const { provider, left, right } = await fixture(t, async (_source, _target, _flags, roots) => {
    originalWasPresent = await fs.readFile(`${roots.left}/source.bin`).then(() => true, () => false);
    throw new Error('Copy failed');
  });
  await fs.writeFile(`${right}/source.bin`, 'old target');
  const before = await provider.load(), after = structuredClone(before), file = after.folders[left][0];
  after.folders[left] = []; after.folders[right] = [{ ...file, id: 'moved' }];
  await assert.rejects(provider.apply(before, after), /Copy failed/);
  assert.equal(originalWasPresent, true);
  assert.deepEqual(await fs.readFile(`${left}/source.bin`), Buffer.from([0, 2, 4, 6]));
  assert.equal(await fs.readFile(`${right}/source.bin`, 'utf8'), 'old target');
});

test('a move verifies destination size and cached bytes before removing its source', async t => {
  for (const badBytes of [Buffer.from([0]), Buffer.from([8, 8, 8, 8])]) {
    const { provider, before, after, left, right } = await fixture(t, async (_source, target) => fs.writeFile(target, badBytes, { flag: 'wx' }));
    await assert.rejects(provider.apply(before, after), /Kopierprüfung/);
    assert.deepEqual(await fs.readFile(`${left}/source.bin`), Buffer.from([0, 2, 4, 6]));
    assert.deepEqual(await fs.readdir(right), []);
  }
});
