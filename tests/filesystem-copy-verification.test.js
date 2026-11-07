const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const nativeFs = require('node:fs');
const { createProvider } = require('../filesystem-provider');
const { createCopySession } = require('../native-copy');
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
  const source = before.folders[left][0];
  readBytes = 0;
  await provider.apply(before, undefined, { verifyAfterCopy: enabled, transfer: { mode: 'copy', sourcePath: left, targetPath: right, sourceSide: 0, ids: [source.id], changes: [{ kind: 'put', source: source.fsSource, target: right + '/source.bin' }] } });
  assert.equal(readBytes, enabled ? bytes.length * 2 : 0);
  assert.deepEqual(await fs.readFile(`${right}/source.bin`), bytes);
  assert.deepEqual(await fs.readFile(`${left}/source.bin`), bytes);
});

test('native staged copy refuses publication when its owned destination inode was exchanged', { skip: process.platform === 'darwin' }, async t => {
  const root = (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'copy-owned-destination-')))).replaceAll('\\', '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = `${root}/left`, right = `${root}/right`;
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/source.bin`, 'ORIGINAL');
  let displaced, preservedNative;
  const nativeApi = {
    capabilities: { 'files.copy': { status: 'supported' } },
    openSession: () => ({
      invoke: async (_operation, request) => {
        await fs.copyFile(request.source, request.target, nativeFs.constants.COPYFILE_EXCL);
        const stat = await fs.stat(request.target, { bigint: true });
        const ownedDestination = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
        preservedNative = `${request.target}.native-original`;
        await fs.rename(request.target, preservedNative);
        await fs.writeFile(request.target, 'EXTERN!!');
        await fs.utimes(request.target, new Date('2001-01-02T03:04:05Z'), new Date('2001-01-02T03:04:05Z'));
        displaced = request.target;
        return { status: 'committed', copied: true, cancelled: false, ownedDestination };
      },
      close() {}
    })
  };
  const provider = createProvider({ roots: [left, right], createCopySession: () => createCopySession({ platform: process.platform, nativeApi }) });
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ ...before.folders[left][0], id: 'copy' });
  await assert.rejects(provider.apply(before, after, { signal: new AbortController().signal }));
  assert.equal(await fs.readFile(displaced, 'utf8'), 'EXTERN!!');
  assert.equal(await fs.readFile(preservedNative, 'utf8'), 'ORIGINAL');
  assert.equal(await fs.readFile(`${left}/source.bin`, 'utf8'), 'ORIGINAL');
  await assert.rejects(fs.stat(`${right}/source.bin`), { code: 'ENOENT' });
});
