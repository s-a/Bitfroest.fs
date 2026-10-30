const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { zip } = require('./support/search-archives.cjs');
const { zipEntries, officeText } = require('../search-archives');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-shared-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'source.zip').replaceAll('\\', '/');
  await fs.writeFile(archive, zip({ 'actual.txt': 'original bytes' }));
  return { root, archive };
}
function sharedProvider(archive, rows, data = {}) {
  const calls = { lists: 0, reads: [], closedLists: 0, closedReads: 0, disposed: 0 };
  const provider = {
    async *entries(target, { signal } = {}) {
      assert.equal(target, archive); assert.equal(signal?.aborted || false, false); calls.lists++;
      try { for (const row of rows) yield row; } finally { calls.closedLists++; }
    },
    async *readEntry(reference, { signal } = {}) {
      assert.equal(signal?.aborted || false, false); calls.reads.push(reference);
      try { yield Buffer.from(data[reference.archiveEntry] || 'shared content'); } finally { calls.closedReads++; }
    },
    dispose() { calls.disposed++; }
  };
  return { provider, calls };
}
const metadata = archive => ({ archive, archiveEntry: 'nested/hit.txt', id: 'shared-entry', fsSource: 'zip:opaque-provider-location!/nested/hit.txt', name: 'hit.txt', directory: false, size: 14, mtimeMs: 1000, revision: 'source-revision' });

test('ZIP search adapter lists through the shared provider without opening entry streams', async t => {
  const { archive } = await fixture(t), row = metadata(archive), { provider, calls } = sharedProvider(archive, [row]);
  const entries = []; for await (const entry of zipEntries(archive, undefined, { provider })) entries.push(entry);
  assert.equal(calls.lists, 1); assert.equal(calls.reads.length, 0); assert.equal(calls.closedLists, 1);
  assert.equal(entries[0].archiveEntry, row.archiveEntry); assert.equal(entries[0].fsSource, row.fsSource); assert.equal(entries[0].revision, row.revision);
  assert.equal(entries[0].stat.size, row.size); assert.equal(entries[0].stat.mtimeMs, row.mtimeMs);
  assert.equal(calls.disposed, 0);
});

test('ZIP search adapter streams only the selected provider reference and closes an early read', async t => {
  const { archive } = await fixture(t), row = metadata(archive), { provider, calls } = sharedProvider(archive, [row, { ...row, archiveEntry: 'other.txt' }]);
  for await (const entry of zipEntries(archive, undefined, { provider })) {
    for await (const chunk of entry.chunks()) { assert.equal(Buffer.from(chunk).toString(), 'shared content'); break; }
    break;
  }
  assert.equal(calls.reads.length, 1); assert.equal(calls.reads[0].archiveEntry, row.archiveEntry); assert.equal(calls.reads[0].revision, row.revision);
  assert.equal(calls.closedReads, 1); assert.equal(calls.closedLists, 1);
});

test('ZIP search adapter preserves directory metadata without reading directory contents', async t => {
  const { archive } = await fixture(t), { provider, calls } = sharedProvider(archive, [{ ...metadata(archive), archiveEntry: 'empty', name: 'empty', directory: true, size: 0 }]);
  for await (const entry of zipEntries(archive, undefined, { provider })) { assert.equal(entry.stat.isDirectory(), true); assert.equal(entry.stat.isFile(), false); }
  assert.equal(calls.reads.length, 0);
});

test('Office text extraction uses shared ZIP streams and ignores unrelated metadata', async t => {
  const { archive } = await fixture(t), row = metadata(archive);
  const { provider, calls } = sharedProvider(archive, [{ ...row, archiveEntry: 'docProps/core.xml' }, { ...row, archiveEntry: 'word/document.xml' }], { 'word/document.xml': '<w:p><w:t>nee</w:t><w:t>dle &amp; text</w:t></w:p>' });
  const chunks = []; for await (const bytes of officeText(archive, undefined, { provider })) chunks.push(bytes);
  assert.equal(Buffer.concat(chunks).toString(), 'needle & text\n\n');
  assert.deepEqual(calls.reads.map(ref => ref.archiveEntry), ['word/document.xml']);
});

test('search results preserve provider identity and structured archive references', async t => {
  const { root, archive } = await fixture(t), row = metadata(archive);
  const source = { ...row, entry: row.archiveEntry, stat: { size: row.size, mtimeMs: row.mtimeMs, mode: 0o644, isFile: () => true, isDirectory: () => false }, async *chunks() { yield Buffer.from('shared content'); } };
  const { results } = await require('../file-search').searchFiles({ roots: [root], archiveEntries: async function* () { yield source; } }, { searchIn: root, archives: true, name: '*.txt' });
  assert.equal(results.length, 1); assert.equal(results[0].fsSource, row.fsSource); assert.equal(results[0].archiveEntry, row.archiveEntry); assert.equal(results[0].revision, row.revision); assert.equal(results[0].id, row.id);
});

test('result refinement resolves structured references without interpreting opaque UI paths', async t => {
  const { root, archive } = await fixture(t), row = metadata(archive);
  const source = { ...row, entry: row.archiveEntry, stat: { size: row.size, mtimeMs: row.mtimeMs, mode: 0o644, isFile: () => true, isDirectory: () => false }, async *chunks() { yield Buffer.from('shared content'); } };
  const { results } = await require('../file-search').searchFiles({ roots: [root], archiveEntries: async function* () { yield source; } }, { searchIn: root, name: '*.txt', textEnabled: true, text: 'shared', inResults: [{ archive, archiveEntry: row.archiveEntry, revision: row.revision, fsSource: row.fsSource }] });
  assert.equal(results.length, 1); assert.equal(results[0].fsSource, row.fsSource);
});

test('ZIP search keeps distinct provider entries whose inner names differ only in case', async t => {
  const { root, archive } = await fixture(t);
  await fs.writeFile(archive, zip({ 'A.txt': 'upper', 'a.txt': 'lower' }));
  const { results } = await require('../file-search').searchFiles({ roots: [root] }, { searchIn: root, archives: true, name: '*.txt' });
  assert.deepEqual(results.map(row => row.archiveEntry).sort(), ['A.txt', 'a.txt']);
  assert.equal(new Set(results.map(row => row.id)).size, 2);
});
