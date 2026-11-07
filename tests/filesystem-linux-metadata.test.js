const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');

test('Linux cancellation before directory metadata does not confirm the whole folder as completed', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-folder-metadata-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left'), right = path.join(root, 'right'), source = path.join(left, 'folder');
  await Promise.all([fs.mkdir(source, { recursive: true }), fs.mkdir(right)]);
  await fs.writeFile(path.join(source, 'data.txt'), 'copied data');
  const provider = createProvider({ roots: [left, right] });
  const before = await provider.load({ recursive: true });
  const folder = before.folders[left][0], target = path.join(right, 'folder');
  const changes = [{ kind: 'put', source, target }, { kind: 'put', source: path.join(source, 'data.txt'), target: path.join(target, 'data.txt') }];
  const controller = new AbortController();
  const result = await provider.apply(before, undefined, { signal: controller.signal,
    transfer: { mode: 'copy', sourcePath: left, targetPath: right, sourceSide: 0, ids: [folder.id], changes },
    onProgress: event => { if (event.phase === 'metadata') controller.abort(); }
  });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.deepEqual(result.operationOutcome.completedIds, []);
  assert.equal(await fs.readFile(path.join(source, 'data.txt'), 'utf8'), 'copied data');
});

test('Linux folder copying restores directory metadata after publishing its children', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-folder-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  const source = path.join(left, 'folder'), child = path.join(source, 'nested');
  await Promise.all([fs.mkdir(child, { recursive: true }), fs.mkdir(right)]);
  await fs.writeFile(path.join(child, 'data.txt'), 'directory children');
  await fs.chmod(source, 0o751); await fs.chmod(child, 0o710);
  await fs.utimes(child, 1000000000, 1000000001);
  await fs.utimes(source, 1000000002, 1000000003);
  const provider = createProvider({ roots: [left, right] });
  const before = await provider.load({ recursive: true });
  const after = structuredClone(before);
  const folder = before.folders[left].find(row => row.name === 'folder');
  const target = path.join(right, 'folder');
  after.folders[right].push({ ...folder, id: 'copied-folder' });
  after.folders[target] = before.folders[source].map(row => ({ ...row, id: `copied-${row.id}` }));
  after.folders[path.join(target, 'nested')] = before.folders[child].map(row => ({ ...row, id: `copied-${row.id}` }));
  await provider.apply(before, after, { signal: new AbortController().signal });
  for (const [original, copied] of [[source, target], [child, path.join(target, 'nested')]]) {
    const expected = await fs.lstat(original, { bigint: true }), actual = await fs.lstat(copied, { bigint: true });
    assert.equal(actual.mode, expected.mode);
    assert.equal(actual.uid, expected.uid);
    assert.equal(actual.gid, expected.gid);
    assert.equal(actual.mtimeNs, expected.mtimeNs);
  }
  assert.equal(await fs.readFile(path.join(target, 'nested/data.txt'), 'utf8'), 'directory children');
});
