const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { zip } = require('./support/search-archives.cjs');
async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-pilot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip'), target = path.join(root, 'out');
  await fs.mkdir(target); await fs.writeFile(archive, zip(files));
  const { createZipProvider } = require('../zip-provider');
  const reads = [];
  const provider = createZipProvider({ contains: value => path.resolve(value) === root || path.resolve(value).startsWith(root + path.sep), onRead: value => reads.push(value) });
  t.after(() => provider.dispose());
  return { root, archive, target, provider, reads };
}
test('ZIP opens and navigates from directory metadata without extracting content', async t => {
  const { root, archive, provider, reads } = await fixture(t, { 'docs/large.bin': crypto.randomBytes(8 * 1024 * 1024), 'empty/': '', 'note.txt': 'hello' });
  const opened = await provider.open(archive);
  assert.deepEqual(opened.folders[opened.path].map(row => row.name).sort(), ['docs', 'empty', 'note.txt']);
  assert.equal(opened.folders[`${opened.path}/docs`][0].name, 'large.bin');
  assert.deepEqual(opened.folders[`${opened.path}/empty`], []);
  assert(reads.reduce((sum, read) => sum + read.length, 0) < 100000);
  assert.deepEqual((await fs.readdir(root)).sort(), ['out', 'sample.zip']);
  const count = reads.length;
  assert.deepEqual((await provider.open(archive)).folders, opened.folders);
  assert.equal(reads.length, count);
});

test('ZIP rejects ambiguous empty path segments instead of mapping them onto another entry', async t => {
  const { archive, provider } = await fixture(t, { 'dir//file.txt': 'first', 'dir/file.txt': 'second' });
  await assert.rejects(provider.open(archive), /Archivpfad|Unsafe filename/);
});
test('ZIP copies only selected file and folder subtrees, preserves bytes and handles conflicts', async t => {
  const { archive, target, provider } = await fixture(t, { 'docs/one.bin': Buffer.from([0, 255, 3]), 'docs/sub/two.txt': 'two', 'other.txt': 'other' });
  const opened = await provider.open(archive), row = opened.folders[opened.path].find(row => row.name === 'docs');
  const request = { path: opened.path, ids: [row.id], target };
  await provider.copy(request);
  assert.deepEqual(await fs.readFile(path.join(target, 'docs/one.bin')), Buffer.from([0, 255, 3]));
  assert.equal(await fs.readFile(path.join(target, 'docs/sub/two.txt'), 'utf8'), 'two');
  await assert.rejects(fs.stat(path.join(target, 'other.txt')), { code: 'ENOENT' });
  await fs.writeFile(path.join(target, 'docs/one.bin'), 'existing');
  await provider.copy(request, { onConflict: async () => 'skip' });
  assert.equal(await fs.readFile(path.join(target, 'docs/one.bin'), 'utf8'), 'existing');
  await provider.copy(request, { onConflict: async () => 'overwrite' });
  assert.deepEqual(await fs.readFile(path.join(target, 'docs/one.bin')), Buffer.from([0, 255, 3]));
});

test('ZIP extraction reports aggregate and individual byte totals including empty entries', async t => {
  const { archive, target, provider } = await fixture(t, { 'one.txt': 'one', 'two.txt': 'second', 'empty.txt': '' });
  const view = await provider.open(archive), events = [];
  await provider.copy({ path: view.path, ids: view.folders[view.path].map(row => row.id), target }, { onProgress: event => events.push(event) });
  assert.equal(events[0].overall.total, 9);
  assert.ok(events.some(event => event.currentPath === 'one.txt' && event.current.total === 3));
  assert.ok(events.some(event => event.currentPath === 'empty.txt' && event.current.total === 0));
  assert.equal(events.at(-1).overall.completed, 9);
  assert.ok(events.every(event => event.version === 1));
});
test('ZIP rejects unsafe paths and changed archives, and aborts without output', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'hello' });
  const opened = await provider.open(archive), request = { path: opened.path, ids: [opened.folders[opened.path][0].id], target };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.copy(request, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(target), []);
  await fs.writeFile(archive, zip({ 'file.txt': 'changed' }));
  await assert.rejects(provider.copy(request), /geändert/);
  await fs.writeFile(archive, zip({ '../outside.txt': 'bad' }));
  await assert.rejects(provider.open(archive), /Unsafe filename|Archivpfad/);
});
test('ZIP corrupt payload is not decoded at open and never published on extraction error', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'hello' });
  const bytes = await fs.readFile(archive); bytes[38] = 255; await fs.writeFile(archive, bytes);
  const opened = await provider.open(archive);
  await assert.rejects(provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target }));
  assert.deepEqual(await fs.readdir(target), []);
});
test('ZIP cancellation during writing preserves an existing target and removes temporary output', async t => {
  const { archive, target, provider } = await fixture(t, { 'large.bin': crypto.randomBytes(1024 * 1024) });
  const opened = await provider.open(archive), controller = new AbortController();
  await fs.writeFile(path.join(target, 'large.bin'), 'original');
  await assert.rejects(provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target }, {
    signal: controller.signal, onConflict: async () => 'overwrite', onProgress: () => controller.abort()
  }), { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(target, 'large.bin'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(target), ['large.bin']);
});
test('ZIP archive names containing exclamation marks remain distinct from archive boundaries', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'hello' });
  const renamed = archive.replace('sample.zip', 'sample!ä.zip'); await fs.rename(archive, renamed);
  const opened = await provider.open(renamed);
  await provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target });
  assert.equal(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'hello');
});
test('ZIP extraction cannot overwrite its source archive or a hardlink alias', async t => {
  const { root, archive, provider } = await fixture(t, { 'sample.zip': 'replacement', 'alias.zip': 'replacement' });
  const original = await fs.readFile(archive), opened = await provider.open(archive);
  const sample = opened.folders[opened.path].find(row => row.name === 'sample.zip');
  await assert.rejects(provider.copy({ path: opened.path, ids: [sample.id], target: root }, { onConflict: async () => 'overwrite' }), /Quellarchiv/);
  assert.deepEqual(await fs.readFile(archive), original);
  const alias = path.join(root, 'alias.zip'); await fs.link(archive, alias);
  const aliasRow = opened.folders[opened.path].find(row => row.name === 'alias.zip');
  await assert.rejects(provider.copy({ path: opened.path, ids: [aliasRow.id], target: root }, { onConflict: async () => 'overwrite' }), /Quellarchiv/);
  assert.deepEqual(await fs.readFile(alias), original);
});
test('ZIP publication rejects a truncated fallback source and restores the previous target', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': Buffer.alloc(600000, 65) });
  const destination = path.join(target, 'file.txt'); await fs.writeFile(destination, 'OLD TARGET');
  const opened = await provider.open(archive), link = fs.link, open = fs.open; let shortened = false;
  fs.link = async (source, output) => {
    if (output === destination) throw Object.assign(new Error('No hardlinks'), { code: 'ENOTSUP' });
    return link(source, output);
  };
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'r' && /\.zip-.*\.tmp$/.test(args[0])) {
      const read = handle.read.bind(handle); let seen = false;
      handle.read = async (...values) => {
        if (seen && !shortened) { await fs.truncate(args[0], 262144); shortened = true; }
        seen = true; return read(...values);
      };
    }
    return handle;
  };
  try { await assert.rejects(provider.copy({ path: opened.path, ids: opened.folders[opened.path].map(row => row.id), target }, { onConflict: async () => 'overwrite' })); }
  finally { fs.link = link; fs.open = open; }
  assert.equal(shortened, true);
  assert.equal(await fs.readFile(destination, 'utf8'), 'OLD TARGET');
  assert.deepEqual(await fs.readdir(target), ['file.txt']);
});

test('ZIP fallback rejects a replaced destination and retains the external file and original backup', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': Buffer.alloc(600000, 65) });
  const destination = path.join(target, 'file.txt'); await fs.writeFile(destination, 'OLD TARGET');
  const opened = await provider.open(archive), link = fs.link, open = fs.open; let replaced = false;
  fs.link = async (source, output) => {
    if (output === destination) throw Object.assign(new Error('No hardlinks'), { code: 'ENOTSUP' });
    return link(source, output);
  };
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === destination && args[1] === 'wx+') {
      const write = handle.write.bind(handle);
      handle.write = async (...values) => {
        const result = await write(...values);
        if (!replaced) { await fs.rename(destination, destination + '.displaced'); await fs.writeFile(destination, 'EXTERNAL'); replaced = true; }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(provider.copy({ path: opened.path, ids: opened.folders[opened.path].map(row => row.id), target }, { onConflict: async () => 'overwrite' }), /Wiederherstellung/); }
  finally { fs.link = link; fs.open = open; }
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(destination, 'utf8'), 'EXTERNAL');
  const backup = (await fs.readdir(target)).find(name => name.endsWith('.backup'));
  assert.ok(backup); assert.equal(await fs.readFile(path.join(target, backup), 'utf8'), 'OLD TARGET');
});

test('ZIP extraction reports the original backup when a published destination disappears', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'NEW' });
  const destination = path.join(target, 'file.txt'); await fs.writeFile(destination, 'OLD TARGET');
  const opened = await provider.open(archive), link = fs.link, lstat = fs.lstat; let published = false, checks = 0, backup;
  fs.link = async (...args) => { const result = await link(...args); if (args[1] === destination) published = true; return result; };
  fs.lstat = async (...args) => {
    if (published && path.resolve(args[0]) === path.resolve(destination) && ++checks === 2) await fs.unlink(destination);
    return lstat(...args);
  };
  try { await assert.rejects(provider.copy({ path: opened.path, ids: opened.folders[opened.path].map(row => row.id), target }, { onConflict: async () => 'overwrite' }), error => { backup = error.presentation?.paths[0]; return Boolean(backup); }); }
  finally { fs.link = link; fs.lstat = lstat; }
  assert.equal(await fs.readFile(backup, 'utf8'), 'OLD TARGET');
});

test('ZIP fallback detects same-size wrong output bytes and restores the previous target', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': Buffer.alloc(600000, 65) });
  const destination = path.join(target, 'file.txt'); await fs.writeFile(destination, 'OLD TARGET');
  const opened = await provider.open(archive), link = fs.link, open = fs.open; let corrupted = false;
  fs.link = async (source, output) => {
    if (output === destination) throw Object.assign(new Error('No hardlinks'), { code: 'ENOTSUP' });
    return link(source, output);
  };
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === destination && args[1] === 'wx+') {
      const write = handle.write.bind(handle);
      handle.write = async (buffer, offset, length) => {
        if (!corrupted) { const wrong = Buffer.from(buffer); wrong[offset] ^= 1; corrupted = true; return write(wrong, offset, length); }
        return write(buffer, offset, length);
      };
    }
    return handle;
  };
  try { await assert.rejects(provider.copy({ path: opened.path, ids: opened.folders[opened.path].map(row => row.id), target }, { onConflict: async () => 'overwrite' }), /Kopierprüfung/); }
  finally { fs.link = link; fs.open = open; }
  assert.equal(corrupted, true); assert.equal(await fs.readFile(destination, 'utf8'), 'OLD TARGET');
  assert.deepEqual(await fs.readdir(target), ['file.txt']);
});

test('ZIP extraction supports destinations without hardlink support', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'hello' });
  const opened = await provider.open(archive), originalLink = fs.link, events = [];
  fs.link = async (source, destination) => { if (source.startsWith(target + path.sep)) throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); return originalLink(source, destination); };
  try {
    await provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target }, { onProgress: event => events.push(event) });
    assert.equal(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'hello');
    const publication = events.filter(event => event.phase === 'publishing');
    assert.deepEqual(publication.map(event => event.current.completed), [0, 5]);
    assert.ok(publication.every(event => event.current.unit === 'bytes' && event.current.total === 5));
  } finally { fs.link = originalLink; }
});
test('ZIP publication cancellation cannot report success on the copy fallback', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'hello' });
  const opened = await provider.open(archive), originalLink = fs.link, controller = new AbortController();
  fs.link = async (source, destination) => { if (source.startsWith(target + path.sep)) { controller.abort(); throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); } return originalLink(source, destination); };
  try {
    await assert.rejects(provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target }, { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(await fs.readdir(target), []);
  } finally { fs.link = originalLink; }
});
test('ZIP requires a password before writing any selected encrypted files', async t => {
  const { archive, target, provider } = await fixture(t, { 'first.txt': 'first', 'encrypted.txt': 'second' });
  const bytes = await fs.readFile(archive), marker = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const first = bytes.indexOf(marker), second = bytes.indexOf(marker, first + 4);
  bytes.writeUInt16LE(bytes.readUInt16LE(second + 8) | 1, second + 8);
  const local = bytes.readUInt32LE(second + 42); bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 1, local + 6);
  await fs.writeFile(archive, bytes);
  const opened = await provider.open(archive);
  await assert.rejects(provider.copy({ path: opened.path, ids: opened.folders[opened.path].map(row => row.id), target }), /Passwort/);
  assert.deepEqual(await fs.readdir(target), []);
});
test('ZIP64 end records are listed and selected content can be extracted', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': 'hello' });
  const bytes = await fs.readFile(archive), end = Buffer.from(bytes.subarray(bytes.length - 22));
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40); record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(bytes.length - 22), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(65535, 8); end.writeUInt16LE(65535, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  await fs.writeFile(archive, Buffer.concat([bytes.subarray(0, bytes.length - 22), record, locator, end]));
  const opened = await provider.open(archive);
  assert.equal(opened.folders[opened.path][0].size, 5);
  await provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target });
  assert.equal(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'hello');
});
test('ZIP fallback cancellation during publication removes its partial file and restores the previous target', async t => {
  const { archive, target, provider } = await fixture(t, { 'file.txt': crypto.randomBytes(512 * 1024) });
  const destination = path.join(target, 'file.txt'); await fs.writeFile(destination, 'original');
  const opened = await provider.open(archive), originalLink = fs.link, originalOpen = fs.open, controller = new AbortController();
  let interrupted = false;
  fs.link = async (source, destination) => { if (source.startsWith(target + path.sep)) throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); return originalLink(source, destination); };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === destination && args[1] === 'wx+' && !interrupted) {
      const write = handle.write.bind(handle);
      handle.write = async (...values) => { const result = await write(...values); interrupted = true; controller.abort(); return result; };
    }
    return handle;
  };
  try {
    await assert.rejects(provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target }, { signal: controller.signal, onConflict: async () => 'overwrite' }), { name: 'AbortError' });
    assert.equal(interrupted, true);
    assert.equal(await fs.readFile(destination, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(target), ['file.txt']);
  } finally { fs.link = originalLink; fs.open = originalOpen; }
});
