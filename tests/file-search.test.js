const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { searchFiles, compileName, validateSettings } = require('../file-search');

async function fixture(t) {
  const root = (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-search-')))).replaceAll('\\', '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(`${root}/deep`); await fs.mkdir(`${root}/excluded`);
  for (const [name, content] of Object.entries({ 'one.txt': 'needle', 'two.txt': 'NEEDLE', 'note.md': 'other', 'deep/three.txt': 'a needle b', 'excluded/skip.txt': 'needle' })) await fs.writeFile(`${root}/${name}`, content);
  return { root, run: (settings, options = {}) => searchFiles({ roots: [root], ...options }, { searchIn: root, name: '*', depth: -1, ...settings }) };
}

test('name masks preserve substring, exact dotted names, multiple masks, quotes and exclusions', () => {
  for (const [mask, yes, no] of [
    ['note', 'my notes.txt', 'other.txt'], ['one.txt', 'one.txt', 'someone.txt'],
    ['*.txt *.md | skip*', 'notes.md', 'skip.txt'], ['"my file.txt" | *.bak', 'my file.txt', 'file.txt'],
    ['*.*', 'README', ''], ['dir/foobar', 'dir/foobar', 'dir/foo']
  ]) { const match = compileName(mask); assert.equal(match(yes), true, mask); if (no) assert.equal(match(no), false, mask); }
});

test('recursive masks exclude directories without reading unrelated content', async t => {
  const { run } = await fixture(t);
  const result = await run({ name: '*.txt | excluded\\' });
  assert.deepEqual(result.results.map(row => row.name).sort(), ['one.txt', 'three.txt', 'two.txt']);
  assert.ok(result.results.every(row => row.fsSource.endsWith(row.name)));
  assert.equal(result.errors.length, 0);
});

test('content search supplies a versioned byte measurement for the current file', async t => {
  const { run } = await fixture(t), events = [];
  await run({ name: 'one.txt', textEnabled: true, text: 'needle', encodings: ['utf-8'] }, { onProgress: event => events.push(event) });
  assert.ok(events.length);
  assert.ok(events.every(event => event.version === 1 && event.overall && event.current));
  assert.ok(events.some(event => event.path.endsWith('one.txt') && event.current.unit === 'bytes' && event.current.total === 6));
});

test('depth, selected files and selected directories constrain traversal', async t => {
  const { root, run } = await fixture(t);
  assert.deepEqual((await run({ name: '*.txt', depth: 0 })).results.map(row => row.name).sort(), ['one.txt', 'two.txt']);
  assert.deepEqual((await run({ name: '*.txt', selectedOnly: true, selected: [`${root}/deep`] })).results.map(row => row.name), ['three.txt']);
  assert.deepEqual((await run({ selectedOnly: true, selected: [`${root}/one.txt`] })).results.map(row => row.name), ['one.txt']);
});

test('content predicates combine case, whole words, negation and encodings', async t => {
  const { root, run } = await fixture(t);
  await fs.writeFile(`${root}/wide.txt`, Buffer.from('snow \u2603 needle', 'utf16le'));
  assert.deepEqual((await run({ name: '*.txt | excluded\\', textEnabled: true, text: 'needle', caseSensitive: true, encodings: ['utf-8'] })).results.map(row => row.name).sort(), ['one.txt', 'three.txt']);
  assert.deepEqual((await run({ name: 'wide.txt', textEnabled: true, text: '\u2603 needle', encodings: ['utf-16le'] })).results.map(row => row.name), ['wide.txt']);
  assert.deepEqual((await run({ name: '*.md', textEnabled: true, text: 'needle', notContaining: true })).results.map(row => row.name), ['note.md']);
  await fs.writeFile(`${root}/partial.txt`, 'needles');
  assert.equal((await run({ name: 'partial.txt', textEnabled: true, text: 'needle', wholeWords: true })).results.length, 0);
});

test('literal content search finds matches across read blocks and accepts regex and mixed hex', async t => {
  const { root, run } = await fixture(t);
  await fs.writeFile(`${root}/large.bin`, Buffer.concat([Buffer.alloc(65535, 32), Buffer.from('PK\x01\x02needle')]));
  assert.equal((await run({ name: 'large.bin', textEnabled: true, text: 'needle' })).results.length, 1);
  assert.equal((await run({ name: 'large.bin', textEnabled: true, text: '"PK"0102', hex: true, caseSensitive: true })).results.length, 1);
  assert.equal((await run({ name: 'one.txt', textEnabled: true, text: '^n.*e$', textRegex: true })).results.length, 1);
});

test('size, modified dates and plugin rules filter the same candidate', async t => {
  const { root, run } = await fixture(t);
  await fs.utimes(`${root}/one.txt`, new Date('2020-01-01'), new Date('2020-01-01'));
  const result = await run({ name: '*.txt', sizeEnabled: true, size: 6, sizeUnit: 1, sizeOperator: '=', dateEnabled: true, dateTo: '2021-01-01', pluginsEnabled: true, rules: [{ field: 'name', operator: 'contains', value: 'one' }] });
  assert.deepEqual(result.results.map(row => row.name), ['one.txt']);
  const either = await run({ name: '*.txt', pluginsEnabled: true, combine: 'or', rules: [{ field: 'name', operator: '=', value: 'one.txt' }, { field: 'name', operator: '=', value: 'two.txt' }] });
  assert.equal(either.results.length, 2);
});

test('duplicate content requires byte equality and keeps grouped results', async t => {
  const { root, run } = await fixture(t);
  await fs.writeFile(`${root}/deep/copy.txt`, 'needle');
  const result = await run({ name: '*.txt | excluded\\', duplicates: true, sameName: false, sameSize: true, sameContent: true });
  assert.deepEqual(result.results.map(row => row.name).sort(), ['copy.txt', 'one.txt']);
  assert.equal(new Set(result.results.map(row => row.group)).size, 1);
});

test('list input and prior result inputs use actual paths and honor nonrecursive mode', async t => {
  const { root, run } = await fixture(t);
  await fs.writeFile(`${root}/list.txt`, `\ufeffone.txt\ndeep\n`);
  assert.deepEqual((await run({ searchIn: `@${root}/list.txt`, depth: 0, name: 'ignored' })).results.map(row => row.name).sort(), ['deep', 'one.txt']);
  assert.deepEqual((await run({ inResults: [`${root}/deep/three.txt`], name: '*.txt' })).results.map(row => row.name), ['three.txt']);
});

test('invalid regex, incompatible options and unavailable providers fail before traversal', () => {
  assert.throws(() => validateSettings({ nameRegex: true, name: '[' }), /regul|expression|Ausdruck/i);
  assert.throws(() => validateSettings({ textEnabled: true, hex: true, text: 'xyz' }), /Hex/);
  assert.throws(() => validateSettings({ everything: true }), /Everything/);
  assert.throws(() => validateSettings({ pluginsEnabled: true, rules: [{ provider: 'missing', field: 'x' }] }), /Plugin/);
});

test('abort and skip-directory act on the current job without losing reported matches', async t => {
  const { run } = await fixture(t), controller = new AbortController(); let events = 0;
  await assert.rejects(run({}, { signal: controller.signal, onProgress: () => { if (++events === 2) controller.abort(); } }), { name: 'AbortError' });
  const result = await run({ name: '*.txt' }, { skipDirectory: directory => directory.endsWith('/excluded') });
  assert.equal(result.results.some(row => row.name === 'skip.txt'), false);
});

test('paths outside roots and symbolic links cannot be searched', async t => {
  const { root, run } = await fixture(t);
  await assert.rejects(run({ searchIn: path.dirname(root) }), /Root|erlaubt/);
  try { await fs.symlink(path.dirname(root), `${root}/link`, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  const result = await run({ name: '*' }); assert.equal(result.results.some(row => row.fsSource.includes('/link/')), false);
});

test('ZIP names and contents are searched without extracting files, and Office XML text spans formatting runs', async t => {
  const { root, run } = await fixture(t); const { zip } = require('./support/search-archives.cjs');
  await fs.writeFile(`${root}/archive.zip`, zip({ 'nested/hit.txt': 'needle', 'nested/no.txt': 'other' }));
  await fs.writeFile(`${root}/unsafe.zip`, zip({ '../escape.txt': 'needle' }));
  await fs.writeFile(`${root}/letter.docx`, zip({ 'word/document.xml': '<w:p><w:r><w:t>nee</w:t></w:r><w:r><w:t>dle &amp; snow</w:t></w:r></w:p>' }));
  const result = await run({ name: 'hit.txt', archives: true, textEnabled: true, text: 'needle', encodings: ['utf-8'] });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].entry, 'nested/hit.txt');
  assert.ok(result.errors.some(row => row.path.endsWith('/unsafe.zip')));
  assert.equal((await run({ name: 'letter.docx', office: true, textEnabled: true, text: 'needle & snow', encodings: ['utf-8'] })).results.length, 1);
  assert.equal((await fs.readdir(root)).includes('nested'), false);
});

test('name regex targets the basename, absolute name paths supply the start directory and root exclusions keep only descendants', async t => {
  const { root, run } = await fixture(t);
  assert.equal((await run({ name: '^deep$', nameRegex: true })).results.filter(row => row.name === 'three.txt').length, 0);
  assert.deepEqual((await run({ name: `${root}/deep/*.txt` })).results.map(row => row.name), ['three.txt']);
  assert.deepEqual((await run({ name: '*.txt | \\' })).results.map(row => row.name).sort(), ['skip.txt', 'three.txt']);
});

test('recursive list sources ignore the name mask for explicit files and support wildcard lines', async t => {
  const { root, run } = await fixture(t);
  await fs.writeFile(`${root}/list.txt`, '\ufeffone.txt\ndeep/*.txt\n');
  assert.deepEqual((await run({ searchIn: `@${root}/list.txt`, name: '*.md' })).results.map(row => row.name).sort(), ['one.txt', 'three.txt']);
});

test('gzip payload names and archived duplicate content participate in the same search filters', async t => {
  const { root, run } = await fixture(t), { zip } = require('./support/search-archives.cjs');
  await fs.writeFile(`${root}/compressed.txt.gz`, require('node:zlib').gzipSync('needle'));
  assert.equal((await run({ name: 'compressed.txt', archives: true, textEnabled: true, text: 'needle', encodings: ['utf-8'] })).results.length, 1);
  await fs.writeFile(`${root}/dupes.zip`, zip({ 'a.dat': 'equal', 'b.dat': 'equal', 'c.dat': 'other' }));
  const duplicates = await run({ name: '*.dat', archives: true, duplicates: true, sameSize: true, sameContent: true });
  assert.deepEqual(duplicates.results.map(row => row.name), ['a.dat', 'b.dat']);
});

test('whole-word matching cannot invent a boundary when a retained read tail begins inside a word', async () => {
  const { contentMatches } = require('../file-search');
  const chunks = async function* () { yield Buffer.from('xneedle' + ' '.repeat(10)); yield Buffer.from('more spaces'); };
  const found = await contentMatches(chunks(), { text: 'needle', wholeWords: true, encodings: ['utf-8'] }, {}, undefined);
  assert.equal(found, false);
});

test('plugin values support size units, local dates and duplicate field slices', async t => {
  const { root, run } = await fixture(t);
  assert.equal((await run({ name: 'one.txt', pluginsEnabled: true, rules: [{ field: 'size', operator: '>', value: 1, unit: 'kbytes' }] })).results.length, 0);
  await fs.utimes(`${root}/one.txt`, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal((await run({ name: 'one.txt', pluginsEnabled: true, rules: [{ field: 'modified', operator: '<', value: '01.01.2021 00:00' }] })).results.length, 1);
  await fs.writeFile(`${root}/onecopy.bin`, 'different');
  const result = await run({ name: 'one*', duplicates: true, sameFields: ['[=tc.name:1-3]'] });
  assert.deepEqual(result.results.map(row => row.name).sort(), ['one.txt', 'onecopy.bin']);
});

test('TAR and compressed TAR traversal reads member content and ignores symbolic-link members', async t => {
  const { root, run } = await fixture(t);
  const header = Buffer.alloc(512); header.write('nested/hit.txt'); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write('00000000006\0', 124); header.write('00000000001\0', 136); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257);
  header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const tar = Buffer.concat([header, Buffer.from('needle'), Buffer.alloc(506), Buffer.alloc(1024)]);
  await fs.writeFile(`${root}/files.tar`, tar); await fs.writeFile(`${root}/files.tgz`, require('node:zlib').gzipSync(tar));
  const result = await run({ name: 'hit.txt', archives: true, textEnabled: true, text: 'needle', encodings: ['utf-8'] });
  assert.equal(result.results.length, 2); assert.ok(result.results.every(row => row.entry === 'nested/hit.txt'));
});

test('legacy ZIP codepage names and PAX TAR metadata preserve searchable names and timestamps', async t => {
  const { root, run } = await fixture(t), { zip, tar, pax } = require('./support/search-archives.cjs');
  await fs.writeFile(`${root}/legacy.zip`, zip({ legacy: 'needle' }, { legacy: true, encodedNames: { legacy: Buffer.from([0x84, 46, 116, 120, 116]) } }));
  assert.equal((await run({ name: 'ä.txt', archives: true })).results.length, 1);
  await fs.writeFile(`${root}/pax.tar`, tar([{ name: 'metadata', type: 'x', text: pax({ path: 'deep/ü-long.txt', size: '6', mtime: '123.5' }) }, { name: 'short', headerSize: 0, text: 'needle' }]));
  const result = await run({ name: 'ü-long.txt', archives: true, textEnabled: true, text: 'needle', encodings: ['utf-8'] });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].mtimeMs, 123500);
});

test('F2 result refinement resolves archived file paths to their original entries', async t => {
  const { root, run } = await fixture(t), { zip } = require('./support/search-archives.cjs');
  await fs.writeFile(`${root}/refine.zip`, zip({ 'a.txt': 'needle', 'b.txt': 'other' }));
  const first = await run({ name: '*.txt', archives: true });
  const result = await run({ inResults: first.results.filter(row => row.archive).map(row => row.fsSource), name: '*.txt', textEnabled: true, text: 'needle', encodings: ['utf-8'] });
  assert.deepEqual(result.results.map(row => row.entry), ['a.txt']);
});

test('deleted gzip source reports a stream error without leaving the decoder waiting', async t => {
  const { root } = await fixture(t), file = `${root}/missing.txt.gz`; await fs.writeFile(file, require('node:zlib').gzipSync('content'));
  const iterator = require('../search-archives').archiveEntries(file); const entry = (await iterator.next()).value;
  await fs.rm(file);
  await assert.rejects(async () => { for await (const chunk of entry.chunks()) void chunk; }, /ENOENT/);
  await iterator.return();
});

test('concatenated gzip members use their complete uncompressed size for size filters', async t => {
  const { root, run } = await fixture(t), { gzipSync } = require('node:zlib');
  await fs.writeFile(`${root}/joined.txt.gz`, Buffer.concat([gzipSync('first'), gzipSync('second')]));
  const result = await run({ name: 'joined.txt', archives: true, sizeEnabled: true, sizeOperator: '=', size: 11, sizeUnit: 1 });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].size, 11);
});

test('inactive content filters do not reject a filename-only search', async t => {
  const { run } = await fixture(t);
  assert.equal((await run({ name: 'one.txt', textEnabled: false, text: '[invalid', hex: true, textRegex: true })).results.length, 1);
});
