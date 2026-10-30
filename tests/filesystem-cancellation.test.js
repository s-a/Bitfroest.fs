const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');
const { abortError } = require('../native-copy');

test('directory preparation reports scanned entries and aborts without invalidating its confirmed snapshot', async t => {
  const f = await fixture(t), controller = new AbortController();
  await fs.mkdir(`${f.left}/nested`); await fs.writeFile(`${f.left}/nested/a.txt`, 'KEEP');
  const before = await f.provider.load(); const events = [];
  await assert.rejects(f.provider.prepare(before, { directories: [`${f.left}/nested`], recursive: true, signal: controller.signal, onProgress: event => { events.push(event); controller.abort(); } }), { name: 'AbortError' });
  assert.ok(events.some(event => event.phase === 'preparing' && event.filesScanned >= 1));
  const fresh = await f.provider.prepare(before, { directories: [`${f.left}/nested`], recursive: true });
  assert.equal(fresh.folders[`${f.left}/nested`][0].name, 'a.txt');
  assert.equal(await fs.readFile(`${f.left}/nested/a.txt`, 'utf8'), 'KEEP');
  assert.deepEqual(await fs.readdir(f.right), []);
});

test('a pre-aborted transfer remains cancellable before the first copy', async t => {
  let copies = 0;
  const f = await fixture(t, { copyFile: async (...args) => { copies++; return fs.copyFile(...args); } }), controller = new AbortController(); controller.abort();
  const result = await f.provider.apply(f.before, f.after, { transfer: f.transfer, signal: controller.signal });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.equal(copies, 0);
  assert.deepEqual(await fs.readdir(f.right), []);
  assert.equal(await fs.readFile(`${f.left}/a.txt`, 'utf8'), 'AAA');
});

test('pre-aborted copy acknowledges without rescanning the filesystem', async t => {
  const reads = [];
  const f = await fixture(t, { fs: { ...fs, readdir: async (...args) => { reads.push(args[0]); return fs.readdir(...args); } } });
  reads.length = 0;
  const controller = new AbortController(); controller.abort();
  const result = await f.provider.apply(f.before, f.after, { transfer: f.transfer, signal: controller.signal });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.deepEqual(reads, [], 'no writes require no reconciliation scan');
});

test('cancelled copy refreshes open tabs without rescanning recursively prepared unrelated folders', async t => {
  const reads = [], controller = new AbortController();
  const f = await fixture(t, {
    fs: { ...fs, readdir: async (...args) => { reads.push(args[0]); return fs.readdir(...args); } },
    copyFile: async (source, destination) => {
      if (source.endsWith('/b.txt')) { controller.abort(); throw abortError(); }
      await fs.copyFile(source, destination, 1);
    }
  });
  const unrelated = `${f.left}/unrelated`;
  await fs.mkdir(unrelated); await fs.writeFile(`${unrelated}/untouched.txt`, 'KEEP');
  f.before = await f.provider.load({ directories: [unrelated] });
  f.after = structuredClone(f.before);
  f.after.folders[f.right] = f.after.folders[f.left].filter(row => row.type !== 'folder').map((row, index) => ({ ...row, id: `copy-${index}` }));
  reads.length = 0;
  const result = await f.provider.apply(f.before, f.after, { transfer: f.transfer, signal: controller.signal });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.equal(reads.includes(unrelated), false);
  assert.equal(result.folders[f.right].some(row => row.name === 'a.txt'), true);
  assert.ok(result.unloadedFolders.includes(unrelated));
  const prepared = await f.provider.prepare(result, { directories: [unrelated] });
  assert.equal(prepared.folders[unrelated][0].name, 'untouched.txt');
});

test('one transfer reuses one native copy session and disposes it after publishing all files', async t => {
  let sessions = 0, copies = 0, disposed = 0;
  const f = await fixture(t, { createCopySession: () => { sessions++; return {
    async copy(input) { copies++; await fs.copyFile(input.source, input.target, 1); },
    async dispose() { disposed++; }
  }; } });
  await f.provider.apply(f.before, f.after, { signal: new AbortController().signal, transfer: f.transfer });
  assert.equal(sessions, 1); assert.equal(copies, 2); assert.equal(disposed, 1);
  assert.equal(await fs.readFile(`${f.right}/a.txt`, 'utf8'), 'AAA');
  assert.equal(await fs.readFile(`${f.right}/b.txt`, 'utf8'), 'BBBB');
});
async function fixture(t, options = {}, mode = 'copy') {
  const root = (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-cancel-')))).replace(/\\/g, '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = `${root}/left`, right = `${root}/right`;
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(`${left}/a.txt`, 'AAA'); await fs.writeFile(`${left}/b.txt`, 'BBBB');
  const provider = createProvider({ roots: [left, right], ...options }), before = await provider.load(), after = structuredClone(before);
  after.folders[right] = after.folders[left].map((file, index) => ({ ...file, id: `copy-${index}` }));
  if (mode === 'move') after.folders[left] = [];
  const transfer = { mode, sourcePath: left, ids: before.folders[left].map(file => file.id), sourceSide: 0 };
  return { provider, before, after, transfer, left, right };
}
test('abort before a transfer starts cannot publish files or remove sources', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: f.transfer });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.deepEqual(result.operationOutcome.completedIds, []);
  assert.deepEqual(await fs.readdir(f.right), []);
  assert.equal(await fs.readFile(`${f.left}/a.txt`, 'utf8'), 'AAA');
});
test('copy abort retains only fully verified earlier publications and restores untouched target backups', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { copyFile: async (source, destination, options) => {
    if (source.endsWith('/b.txt')) { controller.abort(); throw abortError(); }
    await fs.copyFile(source, destination, 1); options.onProgress?.({ transferred: 3, total: 3, granular: true });
  } });
  await fs.writeFile(`${f.right}/b.txt`, 'OLD');
  f.before = await f.provider.load(); f.after = structuredClone(f.before);
  f.after.folders[f.right] = f.after.folders[f.left].map((file, index) => ({ ...file, id: `copy-${index}` }));
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: f.transfer });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.deepEqual(result.operationOutcome.completedIds, [f.transfer.ids[0]]);
  assert.equal(await fs.readFile(`${f.right}/a.txt`, 'utf8'), 'AAA');
  assert.equal(await fs.readFile(`${f.right}/b.txt`, 'utf8'), 'OLD');
  assert.equal(await fs.readFile(`${f.left}/b.txt`, 'utf8'), 'BBBB');
});
test('partial move counts success only after the completed source has actually been removed', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { copyFile: async (source, destination) => {
    if (source.endsWith('/b.txt')) { controller.abort(); throw abortError(); }
    await fs.copyFile(source, destination, 1);
  } }, 'move');
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: f.transfer });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.deepEqual(result.operationOutcome.completedSourcePaths, [`${f.left}/a.txt`]);
  assert.deepEqual(await fs.readdir(f.left), ['b.txt']);
  assert.deepEqual(await fs.readdir(f.right), ['a.txt']);
});
test('an aborted non-transfer mutation retains its complete rollback contract', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { copyFile: async (source, destination) => { await fs.copyFile(source, destination, 1); controller.abort(); } });
  await assert.rejects(f.provider.apply(f.before, f.after, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(f.right), []);
});

test('append abort between chunks restores original target and retains every source', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { fs: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] === 'a') { const write = handle.write.bind(handle); handle.write = async (...values) => { const result = await write(...values); controller.abort(); return result; }; }
    return handle;
  } } });
  await fs.writeFile(`${f.left}/a.txt`, Buffer.alloc(200000, 9)); await fs.writeFile(`${f.right}/a.txt`, 'OLD');
  f.before = await f.provider.load(); f.after = structuredClone(f.before);
  const target = f.after.folders[f.right][0], source = f.after.folders[f.left][0];
  target.fsAppend = { source: source.fsSource, target: target.fsSource }; target.size += source.size; delete target.content;
  let writes = 0;
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: { ...f.transfer, ids: [source.id] }, onProgress: event => { if (event.phase === 'appending') writes++; } });
  assert.equal(result.operationOutcome.cancelled, true); assert.deepEqual(result.operationOutcome.completedIds, []);
  assert.equal(writes, 1); assert.equal(await fs.readFile(`${f.right}/a.txt`, 'utf8'), 'OLD');
  assert.equal((await fs.stat(`${f.left}/a.txt`)).size, 200000);
});

test('published transfer byte progress never moves backwards at the commit boundary', async t => {
  const events = [], controller = new AbortController();
  const f = await fixture(t, { copyFile: async (source, destination, options) => { await fs.copyFile(source, destination, 1); options.onProgress({ transferred: 300, total: 300, granular: true }); } });
  await f.provider.apply(f.before, f.after, { transfer: f.transfer, signal: controller.signal, onProgress: event => events.push(event) });
  const bytes = events.filter(event => event.phase !== 'validating');
  assert.ok(bytes.length > 0);
  assert.ok(bytes.every((event, index) => event.completedBytes <= event.totalBytes && (!index || event.completedBytes >= bytes[index - 1].completedBytes)));
  assert.equal(events.at(-1).completedBytes, 7);
});

test('real cancellable provider copy preserves readonly source and target bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), controller = new AbortController();
  await fs.chmod(`${f.left}/a.txt`, 0o444);
  f.before = await f.provider.load(); f.after = structuredClone(f.before); f.after.folders[f.right] = f.after.folders[f.left].map((file, i) => ({ ...file, id: `copied-${i}` }));
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: f.transfer });
  assert.equal(result.folders[f.right].length, 2); assert.equal(await fs.readFile(`${f.right}/a.txt`, 'utf8'), 'AAA');
  assert.equal((await fs.stat(`${f.right}/a.txt`)).mode & 0o222, 0);
});

test('partial move keeps empty destination subdirectories before removing completed source trees', async t => {
  const controller = new AbortController(), f = await fixture(t);
  await fs.mkdir(`${f.left}/docs`); await fs.mkdir(`${f.left}/docs/empty`); await fs.writeFile(`${f.left}/docs/item.txt`, 'child');
  f.before = await f.provider.load({ recursive: true }); f.after = structuredClone(f.before);
  const folder = f.after.folders[f.left].find(row => row.name === 'docs');
  f.after.folders[f.left] = f.after.folders[f.left].filter(row => row !== folder);
  f.after.folders[f.right].push({ ...folder, id: 'docs-copy' });
  for (const directory of Object.keys(f.after.folders).filter(dir => dir.startsWith(`${f.left}/docs`))) { f.after.folders[f.right + directory.slice(f.left.length)] = f.after.folders[directory].map(row => ({ ...row, id: `copy-${row.id}` })); delete f.after.folders[directory]; }
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: { ...f.transfer, mode: 'move', ids: [folder.id] }, onProgress: event => { if (event.phase === 'published') controller.abort(); } });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.equal((await fs.stat(`${f.right}/docs/empty`)).isDirectory(), true);
  assert.equal(await fs.readFile(`${f.right}/docs/item.txt`, 'utf8'), 'child');
});

test('source-removal failure after cancellation exposes recovery without a moved acknowledgement', async t => {
  const controller = new AbortController(), f = await fixture(t, { fs: { ...fs, rename: async (source, target) => { if (String(source).endsWith('/left/a.txt')) throw new Error('source removal denied'); return fs.rename(source, target); } } }, 'move');
  await assert.rejects(f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: f.transfer, onProgress: event => { if (event.phase === 'published') controller.abort(); } }), error => /recovery|Wiederherstellung/.test(error.message));
  assert.equal(await fs.readFile(`${f.left}/a.txt`, 'utf8'), 'AAA');
  assert.equal(await fs.readFile(`${f.right}/a.txt`, 'utf8'), 'AAA');
});

test('cancellation after a source quarantine retains acknowledged completed moves', async t => {
  const controller = new AbortController(), f = await fixture(t, { fs: { ...fs, rename: async (source, target) => { await fs.rename(source, target); if (String(source).endsWith('/left/a.txt')) controller.abort(); } } }, 'move');
  const result = await f.provider.apply(f.before, f.after, { signal: controller.signal, transfer: f.transfer });
  assert.equal(result.operationOutcome.cancelled, true);
  assert.deepEqual(result.operationOutcome.completedIds, f.transfer.ids);
  assert.deepEqual(await fs.readdir(f.left), []);
  assert.equal(await fs.readFile(`${f.right}/a.txt`, 'utf8'), 'AAA');
  assert.equal(await fs.readFile(`${f.right}/b.txt`, 'utf8'), 'BBBB');
});
