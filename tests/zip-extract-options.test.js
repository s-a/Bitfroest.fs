const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zip = require('@zip.js/zip.js');
const { createZipProvider } = require('../zip-provider');
test('ZIP-F10/F11 extraction filters names, flattens paths and preserves modification times', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-options-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip'), target = path.join(root, 'new-target');
  const date = new Date('2020-03-04T10:12:14Z'), writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('docs/hello world.txt', new zip.TextReader('hello'), { lastModDate: date });
  await writer.add('docs/skip.bin', new zip.TextReader('skip')); await fs.writeFile(archive, await writer.close());
  const provider = createZipProvider({ contains: value => value.startsWith(root) }); t.after(() => provider.dispose());
  const opened = await provider.open(archive);
  await provider.copy({ path: opened.path, ids: opened.folders[opened.path].map(row => row.id), target, paths: false, filter: '"hello world.txt"' });
  assert.deepEqual(await fs.readdir(target), ['hello world.txt']);
  assert.equal(await fs.readFile(path.join(target, 'hello world.txt'), 'utf8'), 'hello');
  assert.equal((await fs.stat(path.join(target, 'hello world.txt'))).mtimeMs, date.getTime());
});
test('ZIP-F32 explicit archive test validates every selected entry without producing files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip'), writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('first.txt', new zip.TextReader('one')); await writer.add('second.txt', new zip.TextReader('two')); await fs.writeFile(archive, await writer.close());
  const { createZipOperations } = require('../zip-operations'); const operations = createZipOperations({ contains: value => value.startsWith(root) }); t.after(() => operations.dispose());
  const result = await operations.test(archive); assert.equal(result.files, 2); assert.equal(result.bytes, 6);
  assert.deepEqual(await fs.readdir(root), ['sample.zip']);
});

test('ZIP archive test is cancelled by disposal and refuses later work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-dispose-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip'), writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('file.txt', new zip.TextReader('content')); await fs.writeFile(archive, await writer.close());
  const { createZipOperations } = require('../zip-operations'); const operations = createZipOperations({ contains: value => value.startsWith(root) });
  await assert.rejects(operations.test(archive, { onProgress: () => operations.dispose() }), { name: 'AbortError' });
  await assert.rejects(operations.test(archive), /geschlossen/);
});
