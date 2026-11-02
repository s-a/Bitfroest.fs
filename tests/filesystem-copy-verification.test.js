const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');
for (const enabled of [false, true]) test(`additional copy comparison ${enabled} controls the full content read`, async t => {
  const root = (await fs.mkdtemp(path.join(os.tmpdir(), 'copy-verification-'))).replaceAll('\\', '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = `${root}/left`, right = `${root}/right`; await fs.mkdir(left); await fs.mkdir(right);
  const bytes = Buffer.alloc(1024 * 1024, 19); await fs.writeFile(`${left}/source.bin`, bytes);
  let readBytes = 0;
  const provider = createProvider({ roots: [left, right], fs: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args), read = handle.read.bind(handle);
    handle.read = async (...values) => { const result = await read(...values); readBytes += result.bytesRead; return result; };
    return handle;
  } } });
  const before = await provider.load({ directories: [left, right], visibleOnly: true });
  const after = structuredClone(before), source = before.folders[left][0]; after.folders[right].push({ ...source, id: 'copied' });
  readBytes = 0;
  await provider.apply(before, after, { verifyAfterCopy: enabled, transfer: { mode: 'copy', sourcePath: left, sourceSide: 0, ids: [source.id] } });
  assert.equal(readBytes, enabled ? bytes.length * 2 : 0);
  assert.deepEqual(await fs.readFile(`${right}/source.bin`), bytes);
  assert.deepEqual(await fs.readFile(`${left}/source.bin`), bytes);
});
