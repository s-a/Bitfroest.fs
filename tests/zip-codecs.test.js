const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { zip } = require('./support/search-archives.cjs');

for (const method of [93, 20]) test(`ZIP-F40 Zstandard method ${method} lists without decompression and streams selected content with CRC validation`, { skip: !zlib.zstdCompressSync }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-zstd-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'zstd.zip'), target = path.join(root, 'out');
  await fs.writeFile(archive, zip({ 'file.txt': 'Zstandard content' }, { compressionMethod: method, pack: zlib.zstdCompressSync }));
  const { createZipProvider } = require('../zip-provider'), provider = createZipProvider({ contains: value => path.resolve(value).startsWith(root + path.sep) }); t.after(() => provider.dispose());
  const opened = await provider.open(archive); assert.deepEqual(await fs.readdir(root), ['zstd.zip']);
  const refs = []; for await (const ref of provider.entries(archive)) refs.push(ref); assert.equal(refs[0].compressionMethod, method);
  const bytes = []; for await (const chunk of provider.readEntry(refs[0])) bytes.push(chunk);
  assert.equal(Buffer.concat(bytes).toString(), 'Zstandard content');
  await provider.copy({ path: opened.path, ids: [refs[0].id], target }); assert.equal(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'Zstandard content');
  const { createZipOperations } = require('../zip-operations'), operations = createZipOperations({ contains: value => value.startsWith(root) }); t.after(() => operations.dispose());
  assert.equal((await operations.test(archive)).files, 1);
});
