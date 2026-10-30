const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zip } = require('./support/search-archives.cjs');
const { createZipProvider } = require('../zip-provider');
async function fixture(t, suffix = '.zip') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, `source${suffix}`);
  await fs.writeFile(archive, zip({ 'nested/a.txt': 'alpha', 'b.txt': 'beta' }));
  const provider = createZipProvider({ contains: value => path.resolve(value).startsWith(root) });
  t.after(() => provider.dispose());
  return { root, archive, provider };
}
async function collect(iterable) { const rows = []; for await (const row of iterable) rows.push(row); return rows; }
async function text(iterable) { return Buffer.concat((await collect(iterable)).map(bytes => Buffer.from(bytes))).toString(); }
test('shared ZIP metadata and selected streaming reads preserve canonical references', async t => {
  const { archive, provider } = await fixture(t);
  const rows = await collect(provider.entries(archive));
  const file = rows.find(row => row.archiveEntry === 'nested/a.txt');
  assert.ok(file.revision); assert.ok(file.fsSource.startsWith('zip:')); assert.equal(file.size, 5);
  assert.equal(rows.find(row => row.archiveEntry === 'nested').directory, true);
  assert.equal(await text(provider.readEntry(file)), 'alpha');
});
test('shared ZIP streams accept Office containers while browsing stays ZIP only', async t => {
  const { archive, provider } = await fixture(t, '.docx');
  await assert.rejects(provider.open(archive));
  const rows = await collect(provider.entries(archive));
  assert.equal(await text(provider.readEntry(rows.find(row => row.archiveEntry === 'nested/a.txt'))), 'alpha');
});
test('shared ZIP references reject changed archives across provider instances', async t => {
  const { root, archive, provider } = await fixture(t);
  const row = (await collect(provider.entries(archive))).find(row => row.archiveEntry === 'nested/a.txt');
  const other = createZipProvider({ contains: value => path.resolve(value).startsWith(root) }); t.after(() => other.dispose());
  assert.equal(await text(other.readEntry(row)), 'alpha');
  await fs.writeFile(archive, zip({ 'nested/a.txt': 'changed data' }));
  await assert.rejects(text(other.readEntry(row)), /geändert/);
});
test('shared ZIP early return and cancellation leave independent reads usable', async t => {
  const { archive, provider } = await fixture(t);
  const row = (await collect(provider.entries(archive))).find(row => row.archiveEntry === 'nested/a.txt');
  for await (const chunk of provider.readEntry(row)) { assert.ok(chunk.length); break; }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(text(provider.readEntry(row, { signal: controller.signal })), { name: 'AbortError' });
  assert.deepEqual(await Promise.all([text(provider.readEntry(row)), text(provider.readEntry(row))]), ['alpha', 'alpha']);
});
test('shared ZIP full consumption rejects an incorrect CRC', async t => {
  const { archive, provider } = await fixture(t);
  const bytes = zip({ 'bad.txt': 'bad CRC' }); bytes.writeUInt32LE(1234, 14);
  bytes.writeUInt32LE(1234, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
  await fs.writeFile(archive, bytes);
  const row = (await collect(provider.entries(archive)))[0];
  await assert.rejects(text(provider.readEntry(row)));
});
test('shared ZIP structured copy uses the existing extraction path', async t => {
  const { root, archive, provider } = await fixture(t), target = path.join(root, 'out'); await fs.mkdir(target);
  const rows = (await collect(provider.entries(archive))).filter(row => !row.directory);
  const result = await provider.copyEntries({ entries: rows, target });
  assert.equal(result.completed, 2); assert.equal(await fs.readFile(path.join(target, 'nested/a.txt'), 'utf8'), 'alpha');
});

test('shared ZIP simultaneous uncached listings do not invalidate each other', async t => {
  const { archive, provider } = await fixture(t);
  const a = provider.entries(archive), b = provider.entries(archive);
  await Promise.all([a.next(), b.next()]);
  assert.equal((await collect(a)).length, 2); assert.equal((await collect(b)).length, 2);
});

test('shared ZIP clear cancels a copy waiting on a conflict without publishing', async t => {
  const { root, archive, provider } = await fixture(t), target = path.join(root, 'out'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'b.txt'), 'original');
  const row = (await collect(provider.entries(archive))).find(row => row.archiveEntry === 'b.txt');
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const copying = provider.copyEntries({ entries: [row], target }, { onConflict: () => { entered(); return new Promise(resolve => { resume = resolve; }); } });
  await ready; provider.clear(); resume('overwrite');
  await assert.rejects(copying, { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(target, 'b.txt'), 'utf8'), 'original');
});

test('shared ZIP selected reads reuse parsed directory metadata', async t => {
  const { root, archive } = await fixture(t), reads = [];
  const files = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`file-${i}.txt`, 'payload']));
  await fs.writeFile(archive, zip(files));
  const provider = createZipProvider({ contains: value => path.resolve(value).startsWith(root), onRead: range => reads.push(range) }); t.after(() => provider.dispose());
  const rows = await collect(provider.entries(archive)); reads.length = 0;
  assert.equal(await text(provider.readEntry(rows[0])), 'payload');
  assert.ok(reads.reduce((sum, range) => sum + range.length, 0) < 4096);
});

test('shared ZIP explicit directory metadata survives an earlier implicit parent', async t => {
  const { archive, provider } = await fixture(t);
  await fs.writeFile(archive, zip({ 'nested/a.txt': 'alpha', 'nested/': '' }));
  const row = (await collect(provider.entries(archive))).find(row => row.archiveEntry === 'nested');
  assert.ok(row.mtimeMs > 0);
});
