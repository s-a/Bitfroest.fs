const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const { createDirectoryReader } = require('../native-directory');
const { createNativeApi } = require('../native-api');
const windows = { skip: process.platform !== 'win32' };
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('directory enumeration supplies complete metadata and identities in batches', windows, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'ä film.txt'), 'contents');
  await fs.mkdir(path.join(root, 'folder'));
  const s = require(binary).openSession(); t.after(() => s.close());
  const result = await s.invoke('files.readDirectory', { path: root });
  assert.deepEqual(result.entries.map(entry => entry.name).sort(), ['folder', 'ä film.txt']);
  for (const entry of result.entries) {
    const stat = await fs.lstat(path.join(root, entry.name), { bigint: true });
    assert.equal(result.volume, stat.dev);
    assert.equal(entry.fileId, stat.ino);
    assert.equal(entry.size, stat.size);
    assert.equal((entry.lastWriteTime - 116444736000000000n) * 100n, stat.mtimeNs);
    assert.equal((entry.changeTime - 116444736000000000n) * 100n, stat.ctimeNs);
    assert.equal(typeof entry.dosName, 'string');
  }
  assert.ok(result.batches >= 1);
  await assert.rejects(s.invoke('files.readDirectory', { path: path.join(root, 'missing') }), { code: 'NotFound' });
  for (const target of ['relative', 'C:/file/../other', 'C:/bad\0path']) {
    assert.throws(() => s.invoke('files.readDirectory', { path: target }), { code: 'InvalidRequest' });
  }
  for (const request of [null, {}, [], { path: 42 }]) {
    assert.throws(() => s.invoke('files.readDirectory', request), { code: 'InvalidRequest' });
  }
  const pending = s.invoke('files.readDirectory', { path: root });
  assert.equal(typeof pending.cancel, 'function'); pending.cancel();
  await assert.rejects(pending, { code: 'Cancelled' });
  // Completed enumeration must retain no directory handle.
  await fs.rename(root, `${root}-renamed`);
  await fs.rename(`${root}-renamed`, root);
});

test('native directory batches include every entry across buffer boundaries', windows, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-many-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let start = 0; start < 3000; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 3000 - start) }, (_, offset) => fs.writeFile(path.join(root, `film-${start + offset}.mkv`), 'abc')));
  }
  const session = require(binary).openSession(); t.after(() => session.close());
  const result = await session.invoke('files.readDirectory', { path: root });
  assert.equal(result.entries.length, 3000);
  assert.equal(new Set(result.entries.map(entry => entry.name)).size, 3000);
  assert.ok(result.batches > 1);
  assert.ok(result.batches < 100, `${result.batches} native directory batches`);
  assert.ok(result.entries.every(entry => entry.size === 3n && entry.fileId !== 0n));
});

test('provider lists 3000 entries without per-entry stat or attribute queries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sample = path.join(root, 'sample.txt'); await fs.writeFile(sample, 'abc');
  const stat = await fs.lstat(sample, { bigint: true });
  const rows = Array.from({ length: 3000 }, (_, index) => ({ name: `film-${index}.mkv`, stat, attributes: { hidden: false, directory: false, readonly: false, archive: true, system: false, compressed: false, encrypted: false, sparse: false, offline: false, dosName: '' } }));
  let reads = 0, childStats = 0, attributes = 0;
  const directoryStat = await fs.lstat(root, { bigint: true });
  const provider = createProvider({ roots: [root], readDirectory: async () => { reads++; return { entries: rows, dev: directoryStat.dev, ino: directoryStat.ino }; },
    readAttributes: async () => { attributes++; return {}; },
    fs: { ...fs, lstat: async (target, ...args) => { if (String(target).includes('film-') || String(target) === sample) childStats++; return fs.lstat(target, ...args); } } });
  const result = await provider.load({ visibleOnly: true, directories: [root] });
  const directory = root.replace(/\\/g, '/');
  assert.equal(reads, 1);
  assert.equal(result.folders[directory].length, 3000);
  assert.equal(result.folders[directory][0].size, 3);
  assert.equal(childStats, 0);
  assert.equal(attributes, 0);
});

test('native listing preserves display metadata and write-time identity checks', windows, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'short.txt'), 'abc');
  await fs.mkdir(path.join(root, 'folder'));
  const reader = createDirectoryReader({ apiFactory: () => createNativeApi(require(binary)) });
  t.after(() => reader.dispose());
  let childStats = 0, attributeCalls = 0;
  const provider = createProvider({ roots: [root],
    readDirectory: (directory, signal) => reader.readDirectory(directory, signal),
    readAttributes: async () => { attributeCalls++; throw new Error('Unexpected attribute query'); },
    fs: { ...fs, lstat: async (target, ...args) => { if (path.dirname(String(target)) === root || String(target).replace(/\\/g, '/') === `${root.replace(/\\/g, '/')}/short.txt`) childStats++; return fs.lstat(target, ...args); } },
    deletePath: target => fs.unlink(target) });
  const before = await provider.load({ directories: [root], visibleOnly: true });
  const key = root.replace(/\\/g, '/');
  assert.equal(childStats, 0);
  assert.equal(attributeCalls, 0);
  const file = before.folders[key].find(row => row.name === 'short.txt');
  assert.equal(file.size, 3);
  assert.equal(file.dosName.toLowerCase(), 'short.txt');
  const stat = await fs.lstat(path.join(root, 'short.txt'), { bigint: true });
  const listing = await reader.readDirectory(root);
  for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'atimeNs']) {
    assert.equal(listing.entries.find(row => row.name === 'short.txt').stat[field], stat[field], field);
  }
  await fs.writeFile(path.join(root, 'short.txt'), 'changed externally');
  await assert.rejects(provider.remove(before, { paths: [file.fsSource], useTrash: false }), /extern geändert/);
  assert.equal(await fs.readFile(path.join(root, 'short.txt'), 'utf8'), 'changed externally');
  const fresh = await provider.load({ directories: [root], visibleOnly: true });
  await provider.remove(fresh, { paths: [file.fsSource], useTrash: false });
  await assert.rejects(fs.stat(path.join(root, 'short.txt')), { code: 'ENOENT' });
});

test('directory requests reject cancellation and closed readers without publishing stale results', windows, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reader = createDirectoryReader({ apiFactory: () => createNativeApi(require(binary)) });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.readDirectory(root, controller.signal), { name: 'AbortError' });
  const pending = reader.readDirectory(root);
  reader.dispose();
  await assert.rejects(pending, { code: 'SessionClosed' });
  await assert.rejects(reader.readDirectory(root), { code: 'SessionClosed' });
});

test('directory reader falls back only for unsupported queries and rejects invalid entries', async () => {
  let response, failure;
  const reader = createDirectoryReader({ platform: 'win32', apiFactory: () => ({
    capabilities: { 'files.readDirectory': { status: 'supported' } },
    openSession: () => ({ invoke: async () => { if (failure) throw failure; return response; }, close() {} })
  }) });
  failure = Object.assign(new Error('unsupported'), { code: 'UnsupportedDirectoryQuery' });
  assert.equal(await reader.readDirectory('C:/example'), null);
  failure = Object.assign(new Error('denied'), { code: 'Denied' });
  await assert.rejects(reader.readDirectory('C:/example'), { code: 'Denied' });
  failure = null;
  for (const name of ['..', '../escape', 'file/child', 'file\0name']) {
    response = { volume: 1n, directoryId: 2n, entries: [{ name }] };
    await assert.rejects(reader.readDirectory('C:/example'), { code: 'InvalidResponse' });
  }
  for (const malformed of [null, { volume: 1n, directoryId: 2n, entries: [null] }]) {
    response = malformed;
    await assert.rejects(reader.readDirectory('C:/example'), { code: 'InvalidResponse' });
  }
  reader.dispose(); await assert.rejects(reader.readDirectory('C:/example'), { code: 'SessionClosed' });
});

test('Linux directory reads use the portable Node path without loading a Windows binding', async t => {
  const reader = createDirectoryReader({ platform: 'linux', apiFactory: () => { throw new Error('Native binding must not be loaded'); } });
  assert.equal(await reader.readDirectory('/media/films'), null);
  reader.dispose();
  if (process.platform !== 'linux') return;
  const binding = require(binary);
  assert.equal(binding.capabilities['files.readDirectory'].status, 'unsupported');
  const session = binding.openSession(); t.after(() => session.close());
  assert.throws(() => session.invoke('files.readDirectory', { path: '/tmp' }), { code: 'UnsupportedOperation' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-linux-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = 'film\\edition.mkv'; await fs.writeFile(path.join(root, filename), 'film');
  await fs.chmod(path.join(root, filename), 0o440);
  const portable = createDirectoryReader(); t.after(() => portable.dispose());
  const provider = createProvider({ roots: [root], readDirectory: (directory, signal) => portable.readDirectory(directory, signal) });
  const state = await provider.load({ directories: [root], visibleOnly: true });
  const row = state.folders[root].find(entry => entry.name === filename);
  assert.ok(row);
  assert.equal(row.size, 4);
  assert.equal(row.posixMode & 0o777, 0o440);
  assert.equal(row.attributeFlags.readonly, true);
});

test('an enumeration bound to a replaced parent is never accepted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-parent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = createProvider({ roots: [root], readDirectory: async () => ({ entries: [], dev: 0n, ino: 0n }) });
  await assert.rejects(provider.load({ directories: [root], visibleOnly: true }), { code: 'DirectoryChangedDuringScan' });
});
