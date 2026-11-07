const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');

test('Linux copies and moves on a real filesystem without hardlink support', {
  skip: process.platform !== 'linux', timeout: 15000
}, async t => {
  const mountedRoot = process.env.NATIVE_HARDLINK_FREE_ROOT;
  if (!mountedRoot) {
    if (process.env.BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS === '1') assert.fail('The required hardlink-free filesystem fixture is missing.');
    t.skip('The private hardlink-free filesystem is not mounted.'); return;
  }
  const root = await fs.mkdtemp(path.join(mountedRoot, 'copy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  await Promise.all([fs.mkdir(left), fs.mkdir(right)]);
  const source = path.join(left, 'source.txt'), target = path.join(right, 'source.txt');
  await fs.writeFile(source, 'copy without hardlink publication');
  await assert.rejects(fs.link(source, path.join(left, 'hardlink-probe')), error => ['EPERM', 'EOPNOTSUPP', 'ENOTSUP'].includes(error.code));
  const provider = createProvider({ roots: [left, right] });
  let before = await provider.load();
  let entry = before.folders[left].find(row => row.name === 'source.txt');
  await provider.apply(before, undefined, { signal: new AbortController().signal, transfer: { mode: 'copy', sourcePath: left, targetPath: right, sourceSide: 0, ids: [entry.id],
    changes: [{ kind: 'put', source, target }] } });
  assert.equal(await fs.readFile(target, 'utf8'), 'copy without hardlink publication');
  assert.equal(await fs.readFile(source, 'utf8'), 'copy without hardlink publication');
  before = await provider.load();
  entry = before.folders[right].find(row => row.name === 'source.txt');
  await provider.apply(before, undefined, { signal: new AbortController().signal, transfer: { mode: 'move', sourcePath: right, targetPath: left, sourceSide: 1, ids: [entry.id],
    changes: [{ kind: 'put', source: target, target: path.join(left, 'moved.txt') }] } });
  assert.equal(await fs.readFile(path.join(left, 'moved.txt'), 'utf8'), 'copy without hardlink publication');
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(root)).sort(), ['left', 'right']);
});
