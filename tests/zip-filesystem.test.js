const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const { zip } = require('./support/search-archives.cjs');
test('ZIP integration preserves an unavailable base filesystem during activation', async () => {
  const { createZipFilesystem } = require('../zip-filesystem');
  const provider = createZipFilesystem({ contains: () => false, load: async () => null });
  assert.equal(await provider.load(), null); provider.dispose();
});
test('archive overlay preserves real snapshots, restores ZIP tabs, and rejects mutation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-bridge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left').replaceAll('\\', '/'), right = path.join(root, 'right').replaceAll('\\', '/');
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/sample.zip`, zip({ 'file.txt': 'hello' }));
  const { createZipFilesystem } = require('../zip-filesystem');
  const provider = createZipFilesystem(createProvider({ roots: [left, right] }));
  t.after(() => provider.dispose());
  const initial = await provider.load();
  const opened = await provider.openArchive(initial, `${left}/sample.zip`);
  assert.equal(opened.state.folders[opened.path][0].name, 'file.txt');
  await provider.copyArchive({ path: opened.path, ids: [opened.state.folders[opened.path][0].id], target: right });
  assert.equal(await fs.readFile(`${right}/file.txt`, 'utf8'), 'hello');
  const restored = await provider.load({ directories: [opened.path] });
  assert.equal(restored.folders[opened.path][0].name, 'file.txt');
  const mutated = structuredClone(restored); mutated.folders[opened.path] = [];
  await assert.rejects(provider.apply(restored, mutated), /Archiv/);
  const copied = structuredClone(restored), row = copied.folders[right][0];
  copied.folders[left].push({ ...row, id: 'normal-copy' });
  await provider.apply(restored, copied);
  assert.equal(await fs.readFile(`${left}/file.txt`, 'utf8'), 'hello');
});
test('ZIP writing derives sources and selected entry names from confirmed host state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-bridge-write-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left').replaceAll('\\', '/'), right = path.join(root, 'right').replaceAll('\\', '/');
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/file.txt`, 'hello');
  const { createZipFilesystem } = require('../zip-filesystem');
  const provider = createZipFilesystem(createProvider({ roots: [left, right] })); t.after(() => provider.dispose());
  const state = await provider.load(), id = state.folders[left][0].id;
  await provider.writeArchive(state, { action: 'pack', archive: `${right}/created.zip`, sourcePath: left, ids: [id] });
  const opened = await provider.openArchive(await provider.load(), `${right}/created.zip`);
  assert.equal(opened.state.folders[opened.path][0].name, 'file.txt');
  await provider.writeArchive(opened.state, { action: 'rename', path: opened.path, ids: [opened.state.folders[opened.path][0].id], name: 'renamed.txt' });
  assert.equal((await provider.openArchive(await provider.load(), `${right}/created.zip`)).state.folders[opened.path][0].name, 'renamed.txt');
  await assert.rejects(provider.writeArchive(state, { action: 'pack', archive: `${right}/other.zip`, sourcePath: left, ids: ['forged'] }), /auswahl/i);
});
test('ZIP whole-archive extraction uses selected archives and separate destination folders', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-unpack-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left').replaceAll('\\', '/'), right = path.join(root, 'right').replaceAll('\\', '/'); await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(`${left}/one.zip`, zip({ 'file.txt': 'one' })); await fs.writeFile(`${left}/two.zip`, zip({ 'file.txt': 'two' }));
  const { createZipFilesystem } = require('../zip-filesystem'); const provider = createZipFilesystem(createProvider({ roots: [left, right] })); t.after(() => provider.dispose());
  const state = await provider.load();
  await provider.unpackArchives(state, { sourcePath: left, ids: state.folders[left].map(row => row.id), target: right, separate: true });
  assert.equal(await fs.readFile(`${right}/one/file.txt`, 'utf8'), 'one'); assert.equal(await fs.readFile(`${right}/two/file.txt`, 'utf8'), 'two');
});

test('ZIP editor replacement retains encryption and rejects a stale editor revision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-editor-bridge-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip'), z = require('@zip.js/zip.js');
  const writer = new z.ZipWriter(new z.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('file.txt', new z.TextReader('original'), { password: 'secret', encryptionStrength: 2, comment: 'entry comment', externalFileAttributes: 0x81ed0000, localExtraField: new Map([[0xcafe, new Uint8Array([1, 2, 3])]]) }); await fs.writeFile(archive, await writer.close());
  const { createZipFilesystem } = require('../zip-filesystem'); const provider = createZipFilesystem(createProvider({ roots: [root] })); t.after(() => provider.dispose());
  const opened = await provider.openArchive(await provider.load(), archive), reference = opened.state.folders[opened.path][0];
  const changed = await provider.replaceArchiveEntry(reference, Buffer.from('edited'), { password: 'secret' });
  assert.notEqual(changed.revision, reference.revision);
  const reader = new z.ZipReader(new z.Uint8ArrayReader(await fs.readFile(archive))); const [entry] = await reader.getEntries();
  assert.equal(entry.encrypted, true); assert.equal(entry.extraFieldAES.strength, 2); assert.equal(await entry.getData(new z.TextWriter(), { password: 'secret', useWebWorkers: false }), 'edited'); await reader.close();
  assert.equal(entry.comment, 'entry comment'); assert.equal(entry.externalFileAttributes, 0x81ed0000);
  assert.ok((await fs.readFile(archive)).includes(Buffer.from([0xfe, 0xca, 3, 0, 1, 2, 3])));
  await assert.rejects(provider.replaceArchiveEntry(reference, Buffer.from('stale'), { password: 'secret' }), /geändert/);
  await provider.replaceArchiveEntry({ ...reference, revision: changed.revision }, Buffer.from('edited twice'), { password: 'secret' });
});

for (const destination of ['B.zip', 'alias.zip']) test(`ZIP multi-archive extraction cannot overwrite the selected source through ${destination}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-source-protection-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'A.zip'), b = path.join(root, 'B.zip'), alias = path.join(root, 'alias.zip');
  await fs.writeFile(a, zip({ [destination]: 'replacement' })); await fs.writeFile(b, zip({ 'file.txt': 'source' })); await fs.link(b, alias);
  const before = await fs.readFile(b), { createZipFilesystem } = require('../zip-filesystem');
  const provider = createZipFilesystem(createProvider({ roots: [root] })); t.after(() => provider.dispose());
  const state = await provider.load(), sourcePath = root.replaceAll('\\', '/');
  const ids = state.folders[sourcePath].filter(row => ['A.zip', 'B.zip'].includes(row.name)).map(row => row.id);
  await assert.rejects(provider.unpackArchives(state, { sourcePath, ids, target: root, overwrite: true }), /Quellarchiv/);
  assert.deepEqual(await fs.readFile(b), before); assert.deepEqual(await fs.readFile(alias), before);
});

test('ZIP-F25 selected archive subtrees copy directly into another ZIP without changing the source', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-to-zip-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.zip'), target = path.join(root, 'target.zip');
  await fs.writeFile(source, zip({ 'docs/chosen.txt': 'chosen', 'other.txt': 'other' })); await fs.writeFile(target, zip({ 'keep.txt': 'keep' })); const before = await fs.readFile(source);
  const { createZipFilesystem } = require('../zip-filesystem'), provider = createZipFilesystem(createProvider({ roots: [root] })); t.after(() => provider.dispose());
  const opened = await provider.openArchive(await provider.load(), source), destination = await provider.openArchive(opened.state, target);
  const id = destination.state.folders[opened.path].find(row => row.name === 'docs').id;
  await provider.writeArchive(destination.state, { action: 'pack', sourcePath: opened.path, path: destination.path, ids: [id] });
  assert.deepEqual(await fs.readFile(source), before);
  const reader = require('../zip-provider').createZipProvider({ contains: value => value.startsWith(root) }); t.after(() => reader.dispose());
  const rows = []; for await (const entry of reader.entries(target)) rows.push(entry.archiveEntry);
  assert.deepEqual(rows.sort(), ['docs', 'docs/chosen.txt', 'keep.txt']);
});
