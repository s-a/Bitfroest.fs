const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zip = require('@zip.js/zip.js');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { createZipOperations } = require('../zip-operations');
  const operations = createZipOperations({ contains: value => path.resolve(value) === root || path.resolve(value).startsWith(root + path.sep) });
  t.after(() => operations.dispose());
  return { root, operations, archive: path.join(root, 'result.zip') };
}
async function contents(file, password) {
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(await fs.readFile(file)), { password, checkCrc32: true });
  try { return await Promise.all((await reader.getEntries()).map(async entry => ({ name: entry.filename, encrypted: entry.encrypted, method: entry.compressionMethod, comment: entry.comment, text: entry.directory ? null : await entry.getData(new zip.TextWriter(), { useWebWorkers: false }) }))); }
  finally { await reader.close(); }
}
test('ZIP-F17/F19 create stores selected directory structure, empty folders and comments', async t => {
  const { root, archive, operations } = await fixture(t);
  const folder = path.join(root, 'docs'); await fs.mkdir(path.join(folder, 'empty'), { recursive: true }); await fs.writeFile(path.join(folder, 'hello.txt'), 'hello');
  await operations.write({ archive, sources: [folder], comment: 'archive comment' });
  const entries = await contents(archive);
  assert.deepEqual(entries.map(e => e.name).sort(), ['docs/', 'docs/empty/', 'docs/hello.txt']);
  assert.equal(entries.find(e => e.name.endsWith('hello.txt')).text, 'hello');
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(await fs.readFile(archive)));
  await reader.getEntries(); assert.equal(new TextDecoder().decode(reader.comment), 'archive comment'); await reader.close();
});
for (const encryption of ['zipcrypto', 'aes128', 'aes192', 'aes256']) test(`ZIP-F27 ${encryption} creates encrypted content and rejects wrong password`, async t => {
  const { root, archive, operations } = await fixture(t);
  const source = path.join(root, 'secret.txt'); await fs.writeFile(source, 'secret content');
  await operations.write({ archive, sources: [source], encryption, password: 'correct' });
  const data = await contents(archive, 'correct'); assert.equal(data[0].encrypted, true); assert.equal(data[0].text, 'secret content');
  await assert.rejects(contents(archive, 'incorrect'));
});
test('ZIP-F21/F23/F24 editing preserves untouched encrypted bytes without their password', async t => {
  const { root, archive, operations } = await fixture(t);
  const original = path.join(root, 'secret.txt'); await fs.writeFile(original, 'keep encrypted');
  await operations.write({ archive, sources: [original], encryption: 'aes256', password: 'original' });
  const added = path.join(root, 'added.txt'); await fs.writeFile(added, 'added');
  await operations.write({ archive, sources: [added], inside: 'nested', verify: false });
  await operations.write({ archive, rename: [{ from: 'nested', to: 'renamed' }], verify: false });
  const data = await contents(archive, 'original'); assert.equal(data.find(e => e.name === 'secret.txt').encrypted, true);
  assert.equal(data.find(e => e.name === 'renamed/added.txt').text, 'added');
  await operations.write({ archive, remove: ['renamed'], verify: false });
  assert.deepEqual((await contents(archive, 'original')).map(e => e.name), ['secret.txt']);
});
test('ZIP-F21 replacement asks on conflict and never creates duplicate entries', async t => {
  const { root, archive, operations } = await fixture(t);
  const source = path.join(root, 'file.txt'); await fs.writeFile(source, 'first');
  await operations.write({ archive, sources: [source] }); await fs.writeFile(source, 'second');
  await operations.write({ archive, sources: [source] }, { onConflict: async () => 'skip' });
  assert.equal((await contents(archive))[0].text, 'first');
  await operations.write({ archive, sources: [source] }, { onConflict: async () => 'overwrite' });
  const data = await contents(archive); assert.equal(data.length, 1); assert.equal(data[0].text, 'second');
});
test('ZIP-F22/F33 cancelled update leaves original archive and move sources intact', async t => {
  const { root, archive, operations } = await fixture(t);
  const source = path.join(root, 'file.txt'); await fs.writeFile(source, 'first'); await operations.write({ archive, sources: [source] });
  const before = await fs.readFile(archive); await fs.writeFile(source, 'second');
  const controller = new AbortController();
  await assert.rejects(operations.write({ archive, sources: [source], move: true }, { signal: controller.signal, onConflict: async () => 'overwrite', onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.deepEqual(await fs.readFile(archive), before); assert.equal(await fs.readFile(source, 'utf8'), 'second');
  assert.deepEqual((await fs.readdir(root)).sort(), ['file.txt', 'result.zip']);
});
test('ZIP-F22 move deletes a source only after a successful archive commit', async t => {
  const { root, archive, operations } = await fixture(t);
  const source = path.join(root, 'file.txt'); await fs.writeFile(source, 'moved');
  await operations.write({ archive, sources: [source], move: true });
  assert.equal((await contents(archive))[0].text, 'moved'); await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});
test('ZIP mutation refuses stale revisions, self-inclusion and unsafe names before commit', async t => {
  const { root, archive, operations } = await fixture(t);
  const source = path.join(root, 'file.txt'); await fs.writeFile(source, 'one'); const first = await operations.write({ archive, sources: [source] });
  await fs.writeFile(source, 'two'); await operations.write({ archive, sources: [source] }, { onConflict: async () => 'overwrite' });
  const current = await fs.readFile(archive);
  await assert.rejects(operations.write({ archive, remove: ['file.txt'], revision: first.revision }), /geändert/);
  await assert.rejects(operations.write({ archive, sources: [archive] }), /Quellarchiv|sich selbst/);
  await assert.rejects(operations.write({ archive, rename: [{ from: 'file.txt', to: '../escape' }] }), /Archivpfad/);
  await assert.rejects(operations.write({ archive, additions: [{ name: 'dir//ambiguous.txt', data: 'ambiguous' }] }), /Archivpfad/);
  assert.deepEqual(await fs.readFile(archive), current);
});
test('ZIP rejects file and directory ancestor collisions without changing the archive', async t => {
  const { archive, operations } = await fixture(t);
  await operations.write({ archive, additions: [{ name: 'dir/inside.txt', data: 'inside' }, { name: 'other.txt', data: 'other' }] });
  const before = await fs.readFile(archive);
  await assert.rejects(operations.write({ archive, additions: [{ name: 'dir', data: 'file' }] }), /verzeichnis|pfad/i);
  assert.deepEqual(await fs.readFile(archive), before);
  await assert.rejects(operations.write({ archive, rename: [{ from: 'other.txt', to: 'dir' }] }), /verzeichnis|pfad/i);
  assert.deepEqual(await fs.readFile(archive), before);
  const second = archive.replace('result.zip', 'second.zip');
  await operations.write({ archive: second, additions: [{ name: 'dir', data: 'file' }] });
  const other = await fs.readFile(second);
  await assert.rejects(operations.write({ archive: second, additions: [{ name: 'dir/child.txt', data: 'child' }] }), /verzeichnis|pfad/i);
  assert.deepEqual(await fs.readFile(second), other);
});
test('ZIP-F28 adding an AES entry preserves existing clear entries as clear entries', async t => {
  const { root, archive, operations } = await fixture(t);
  const clear = path.join(root, 'clear.txt'), secret = path.join(root, 'secret.txt'); await fs.writeFile(clear, 'clear'); await fs.writeFile(secret, 'secret');
  await operations.write({ archive, sources: [clear] });
  await operations.write({ archive, sources: [secret], encryption: 'aes256', password: 'correct' });
  const data = await contents(archive, 'correct');
  assert.equal(data.find(e => e.name === 'clear.txt').encrypted, false);
  assert.equal(data.find(e => e.name === 'clear.txt').text, 'clear');
  assert.equal(data.find(e => e.name === 'secret.txt').encrypted, true);
});
test('ZIP update preserves unknown local extra fields and comments of untouched entries', async t => {
  const { root, archive, operations } = await fixture(t);
  const initial = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await initial.add('keep.txt', new zip.TextReader('keep'), { comment: 'entry comment', localExtraField: new Map([[0xcafe, new Uint8Array([1, 2, 3])]]) });
  await fs.writeFile(archive, await initial.close());
  const marker = Buffer.from([0xfe, 0xca, 3, 0, 1, 2, 3]); assert.ok((await fs.readFile(archive)).includes(marker));
  const added = path.join(root, 'added.txt'); await fs.writeFile(added, 'added'); await operations.write({ archive, sources: [added] });
  assert.ok((await fs.readFile(archive)).includes(marker));
  assert.equal((await contents(archive)).find(entry => entry.name === 'keep.txt').comment, 'entry comment');
});

test('ZIP rename preserves unknown local extra fields and encrypted payload bytes', async t => {
  const { archive, operations } = await fixture(t);
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('secret.txt', new zip.TextReader('secret'), { password: 'password', encryptionStrength: 3, localExtraField: new Map([[0xcafe, new Uint8Array([1, 2, 3])]]) });
  await fs.writeFile(archive, await writer.close());
  async function payload() {
    const bytes = await fs.readFile(archive), reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes));
    const [entry] = await reader.getEntries();
    const offset = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
    await reader.close(); return bytes.subarray(offset, offset + entry.compressedSize);
  }
  const before = await payload();
  await operations.write({ archive, rename: [{ from: 'secret.txt', to: 'renamed.txt' }], verify: false });
  assert.deepEqual(await payload(), before);
  assert.ok((await fs.readFile(archive)).includes(Buffer.from([0xfe, 0xca, 3, 0, 1, 2, 3])));
  assert.equal((await contents(archive, 'password'))[0].text, 'secret');
});
test('ZIP move cancellation at publication retains sources and reports cancellation', async t => {
  const { root, archive, operations } = await fixture(t);
  const source = path.join(root, 'source.txt'); await fs.writeFile(source, 'source');
  const controller = new AbortController(), originalLink = fs.link;
  fs.link = async (...args) => { const result = await originalLink(...args); if (args[1] === archive) controller.abort(); return result; };
  try {
    await assert.rejects(operations.write({ archive, sources: [source], move: true }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(await fs.readFile(source, 'utf8'), 'source');
    assert.equal((await contents(archive))[0].text, 'source');
  } finally { fs.link = originalLink; }
});

test('ZIP-F33 cancellation during the post-pack integrity test keeps the completed archive and move sources', async t => {
  const { root, archive, operations } = await fixture(t), source = path.join(root, 'source.txt'); await fs.writeFile(source, 'source');
  const controller = new AbortController();
  await assert.rejects(operations.write({ archive, sources: [source], move: true }, { signal: controller.signal, onProgress: progress => { if (progress.phase === 'verifying') { assert.equal(require('node:fs').existsSync(archive), true); controller.abort(); } } }), error => { assert.equal(error.name, 'AbortError'); assert.equal(error.committedResult?.committed, true); assert.equal(typeof error.committedResult.revision, 'string'); return true; });
  assert.equal((await contents(archive))[0].text, 'source'); assert.equal(await fs.readFile(source, 'utf8'), 'source');
});

test('ZIP mutation and explicit tests enforce the configured reader allocation budget', async t => {
  const { root, archive } = await fixture(t), writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  for (let index = 0; index < 40; index++) await writer.add(`file-${index}.txt`, new zip.TextReader('content'));
  await fs.writeFile(archive, await writer.close()); const before = await fs.readFile(archive);
  const { createZipOperations } = require('../zip-operations'), bounded = createZipOperations({ contains: value => value.startsWith(root), maxMetadataBytes: 1024 }); t.after(() => bounded.dispose());
  await assert.rejects(bounded.test(archive), /Lesebudget/);
  await assert.rejects(bounded.write({ archive, remove: ['file-0.txt'] }), /Lesebudget/);
  assert.deepEqual(await fs.readFile(archive), before); assert.deepEqual(await fs.readdir(root), ['result.zip']);
});

test('ZIP-F33 default post-pack verification checks retained entries and preserves the published archive on failure', async t => {
  const { archive, operations } = await fixture(t);
  await operations.write({ archive, additions: [{ name: 'old.txt', data: 'old data' }] });
  const bytes = await fs.readFile(archive), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(12345, central + 16); bytes.writeUInt32LE(12345, bytes.readUInt32LE(central + 42) + 14); await fs.writeFile(archive, bytes);
  await assert.rejects(operations.write({ archive, additions: [{ name: 'new.txt', data: 'new data' }] }));
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(await fs.readFile(archive)));
  assert.deepEqual((await reader.getEntries()).map(entry => entry.filename).sort(), ['new.txt', 'old.txt']); await reader.close();
});

test('ZIP reports a committed revision after a transient stage cleanup failure', async t => {
  const { archive, operations } = await fixture(t), unlink = fs.unlink; let failed = false, committed;
  fs.unlink = async value => { if (!failed && /\.zip-write-.*\.tmp$/.test(value)) { failed = true; throw Object.assign(new Error('Stage cleanup failed'), { code: 'EPERM' }); } return unlink(value); };
  try { await assert.rejects(operations.write({ archive, additions: [{ name: 'first.txt', data: 'first' }] }), error => { committed = error.committedResult; assert.equal(committed?.committed, true); return true; }); }
  finally { fs.unlink = unlink; }
  await operations.write({ archive, revision: committed.revision, additions: [{ name: 'second.txt', data: 'second' }] });
  assert.deepEqual((await contents(archive)).map(entry => entry.name).sort(), ['first.txt', 'second.txt']);
});
