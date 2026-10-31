const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeApi } = require('../native-api');
const { createCopySession } = require('../native-copy');
const { createProvider } = require('../filesystem-provider');

const bindingPath = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '..', 'native', 'binding.node');
const childMode = process.env.BITFROEST_NATIVE_TRANSFER_CHILD === '1';
const available = process.platform === 'win32' && nativeFs.existsSync(bindingPath);
const slash = value => value.replace(/\\/g, '/');
const clone = value => JSON.parse(JSON.stringify(value));
const row = (state, directory, name) => state.folders[directory].find(file => file.name === name);
const expected = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));

async function fixture(t, createSession = nativeApi => createCopySession({ nativeApi })) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-transfer-provider-')));
  assert.equal(nativeFs.existsSync(path.join(path.dirname(bindingPath), 'file-broker-win.exe')), false);
  const left = path.join(parent, 'left'), right = path.join(parent, 'right');
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(path.join(left, 'first.txt'), 'first file contents');
  await fs.writeFile(path.join(left, 'second.bin'), Buffer.from([0, 255, 3, 9, 11]));
  await fs.writeFile(path.join(left, 'empty.bin'), Buffer.alloc(0));
  const nativeApi = createNativeApi(require(bindingPath));
  const provider = createProvider({ roots: [left, right], createCopySession: () => createSession(nativeApi) });
  t.after(async () => {
    await nativeApi.shutdownAsync();
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { provider, nativeApi, left: slash(left), right: slash(right) };
}

if (childMode) {

test('native copy preserves external targets and rejects changed sources and paths outside approved roots', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-integrity-')));
  const source = path.join(root, 'source.txt'), target = path.join(root, 'target.txt');
  const api = createNativeApi(require(bindingPath)), session = api.openSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(source, 'source');
  const request = { roots: [root], source, target, expected: expected(await fs.stat(source, { bigint: true })) };
  await fs.writeFile(target, 'external target');
  await assert.rejects(session.invoke('files.copy', request), error => error.outcome?.status === 'unchanged');
  assert.equal(await fs.readFile(target, 'utf8'), 'external target');
  await fs.unlink(target);
  await fs.appendFile(source, ' changed');
  await assert.rejects(session.invoke('files.copy', request), error => error.code === 'IdentityChanged' && error.outcome?.status === 'unchanged');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await assert.rejects(session.invoke('files.copy', { ...request, roots: [path.join(root, 'other')] }), error => error.code === 'OutsideRoots' && error.outcome?.status === 'unchanged');
  await assert.rejects(session.invoke('files.copy', { ...request, source: root, expected: expected(await fs.stat(root, { bigint: true })) }),
    error => error.nativeCode === 267 && error.outcome?.status === 'unchanged');
  assert.equal(await fs.readFile(source, 'utf8'), 'source changed');
});

test('native copy supports long Unicode paths and refuses junction ancestors', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-paths-')));
  const api = createNativeApi(require(bindingPath)), session = api.openSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, ...Array(10).fill('Größe-文件-123456789'));
  await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, '源.txt'), target = path.join(directory, 'Ziel-ä.txt');
  await fs.writeFile(source, Buffer.from([0, 255, 17, 34]));
  assert.ok(source.length > 260);
  const signature = expected(await fs.stat(source, { bigint: true }));
  assert.equal((await session.invoke('files.copy', { roots: [root], source, target, expected: signature })).status, 'committed');
  assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
  const junction = path.join(root, 'linked');
  await fs.symlink(directory, junction, 'junction');
  const forbiddenTarget = path.join(root, 'forbidden.txt');
  await assert.rejects(session.invoke('files.copy', { roots: [root], source: path.join(junction, '源.txt'), target: forbiddenTarget, expected: signature }),
    error => error.code === 'ReparsePoint' && error.outcome?.status === 'unchanged');
  await assert.rejects(fs.stat(forbiddenTarget), { code: 'ENOENT' });
});
test('native final witness identifies the committed inode and changes after same-inode external mutation', async t => {
  assert.equal(available, true);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-transfer-witness-')));
  const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
  await fs.writeFile(source, Buffer.from([0x31, 0x32, 0x33, 0x34]));
  const sourceStat = await fs.stat(source, { bigint: true });
  const nativeApi = createNativeApi(require(bindingPath));
  const session = nativeApi.openSession();
  t.after(async () => {
    await session.closeAsync();
    await nativeApi.shutdownAsync();
    await fs.rm(root, { recursive: true, force: true });
  });
  const outcome = await session.invoke('files.copy', { roots: [root], source, target, expected: expected(sourceStat) });
  assert.equal(outcome.status, 'committed');
  const before = await fs.stat(target, { bigint: true });
  assert.deepEqual(outcome.ownedDestination, expected(before));
  const file = await fs.open(target, 'r+');
  try { await file.write(Buffer.from([0x78]), 0, 1, 0); } finally { await file.close(); }
  const after = await fs.stat(target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.notEqual(`${after.mtimeNs}:${after.ctimeNs}`, `${before.mtimeNs}:${before.ctimeNs}`);
  assert.deepEqual(await fs.readFile(target), Buffer.from([0x78, 0x32, 0x33, 0x34]));
});

test('cancellation before the first progress callback leaves no destination', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-transfer-early-cancel-')));
  const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
  await fs.writeFile(source, Buffer.alloc(64 * 1024 * 1024, 0x61));
  const sourceStat = await fs.stat(source, { bigint: true });
  const nativeApi = createNativeApi(require(bindingPath));
  const session = nativeApi.openSession();
  t.after(async () => {
    await session.closeAsync();
    await nativeApi.shutdownAsync();
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  let progressCount = 0;
  const copy = session.invoke('files.copy', { roots: [root], source, target, expected: expected(sourceStat) }, {
    signal: controller.signal,
    onProgress: () => { progressCount++; }
  });
  controller.abort();
  await assert.rejects(copy, error => error.outcome?.status === 'unchanged' && error.outcome.copied === false);
  assert.equal(progressCount, 0);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('cancellation after real native progress preserves the source and reports the actual destination outcome', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-midway-')));
  const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
  const contents = Buffer.alloc(128 * 1024 * 1024, 0x57);
  await fs.writeFile(source, contents);
  const before = await fs.stat(source, { bigint: true });
  const api = createNativeApi(require(bindingPath)), session = api.openSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  let cancelRequested = false;
  const operation = session.invoke('files.copy', { roots: [root], source, target, expected: expected(before) }, {
    signal: controller.signal,
    onProgress(event) {
      if (event.transferred > 0 && !cancelRequested) {
        cancelRequested = true;
        controller.abort();
      }
    }
  });
  let outcome;
  try {
    outcome = await operation;
  } catch (error) {
    outcome = error.outcome;
    assert.ok(['unchanged', 'partial', 'unknown'].includes(outcome?.status));
    if (outcome.status === 'unchanged') {
      assert.equal(outcome.cancelled, true);
      await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    } else if (outcome.status === 'partial') {
      assert.ok(outcome.ownedDestination);
      assert.deepEqual(outcome.ownedDestination, expected(await fs.stat(target, { bigint: true })));
    } else {
      assert.equal(outcome.ownedDestination, undefined);
    }
  }
  assert.equal(cancelRequested, true);
  if (outcome.status === 'committed') {
    assert.deepEqual(outcome.ownedDestination, expected(await fs.stat(target, { bigint: true })));
    assert.deepEqual(await fs.readFile(target), contents);
  }
  assert.deepEqual(expected(await fs.stat(source, { bigint: true })), expected(before));
  assert.deepEqual(await fs.readFile(source), contents);
});

test('native copy drains the latest coalesced progress after the JavaScript thread resumes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-progress-drain-')));
  const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
  await fs.writeFile(source, Buffer.alloc(128 * 1024 * 1024, 0x38));
  const stat = await fs.stat(source, { bigint: true });
  const api = createNativeApi(require(bindingPath)), session = api.openSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  let settled = false;
  const events = [];
  const copy = session.invoke('files.copy', { roots: [root], source, target, expected: expected(stat) }, {
    onProgress(event) { events.push({ event, settled }); }
  });
  const observed = copy.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, 1000);
  const outcome = await observed;
  assert.equal(outcome.status, 'committed');
  assert.ok(events.length > 0);
  assert.ok(events.some(item => !item.settled));
  const last = events.at(-1).event;
  assert.equal(last.transferred, last.total);
});

test('worker termination during native copy does not unload active threadpool callbacks', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-transfer-unload-')));
  const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
  await fs.writeFile(source, Buffer.alloc(128 * 1024 * 1024, 0x6a));
  const stat = await fs.stat(source, { bigint: true });
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { createNativeApi } = require(workerData.apiPath);
    const api = createNativeApi(require(workerData.bindingPath));
    const session = api.openSession();
    let held = false;
    const copy = session.invoke('files.copy', workerData.request, { onProgress: () => {
      if (held) return;
      held = true;
      parentPort.postMessage('copy-entered-progress');
      Atomics.wait(new Int32Array(workerData.signal), 0, 0, 3000);
    }});
    copy.catch(() => {});
  `;
  const worker = new Worker(code, { eval: true, workerData: {
    apiPath: path.join(__dirname, '..', 'native-api.js'), bindingPath,
    signal, request: { roots: [root], source, target, expected: expected(stat) }
  }});
  t.after(async () => { await worker.terminate().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Copy did not reach native progress.')), 30000);
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('message', message => { clearTimeout(timer); assert.equal(message, 'copy-entered-progress'); resolve(); });
  });
  const exitCode = await worker.terminate();
  assert.equal(Number.isInteger(exitCode), true);
});

test('provider stages and publishes real files through one native API session', { skip: !available && 'The Windows file transfer binding is unavailable.' }, async t => {
  const { provider, left, right } = await fixture(t);
  const before = await provider.load(), after = clone(before);
  const files = ['first.txt', 'second.bin', 'empty.bin'].map(name => row(after, left, name));
  after.folders[right].push(...files.map(file => ({ ...file, id: `copy-${file.id}` })));
  await provider.apply(before, after, { transfer: { mode: 'copy', sourcePath: left, ids: files.map(file => file.id), sourceSide: 0 }, signal: new AbortController().signal });
  for (const file of files) assert.deepEqual(await fs.readFile(`${right}/${file.name}`), await fs.readFile(file.fsSource));
  assert.deepEqual((await fs.readdir(right)).sort(), ['empty.bin', 'first.txt', 'second.bin']);
});

test('provider rolls back a completed native copy when the next staged copy fails', { skip: !available && 'The Windows file transfer binding is unavailable.' }, async t => {
  let copies = 0;
  const { provider, left, right } = await fixture(t, nativeApi => {
    const session = createCopySession({ nativeApi });
    return {
      copy(input, options) {
        if (++copies === 2) throw new Error('Injected second-copy failure.');
        return session.copy(input, options);
      },
      dispose: () => session.dispose()
    };
  });
  const before = await provider.load(), after = clone(before);
  const files = ['first.txt', 'second.bin'].map(name => row(after, left, name));
  after.folders[right].push(...files.map(file => ({ ...file, id: `copy-${file.id}` })));
  await assert.rejects(provider.apply(before, after, { transfer: { mode: 'copy', sourcePath: left, ids: files.map(file => file.id), sourceSide: 0 }, signal: new AbortController().signal }), /second-copy failure/);
  assert.equal(copies, 2);
  assert.deepEqual(await fs.readdir(right), []);
  for (const file of files) assert.ok((await fs.readFile(file.fsSource)).length > 0);
});
} else {
  test('provider copy works with an isolated binding and no sibling executable', { skip: process.platform !== 'win32' && 'This integration test requires Windows.' }, async () => {
    assert.equal(process.platform, 'win32');
    assert.ok(nativeFs.existsSync(bindingPath), `The required native test binding is missing: ${bindingPath}`);
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-transfer-binding-')));
    const isolatedDirectory = path.join(parent, 'native');
    await fs.mkdir(isolatedDirectory);
    const isolatedBinding = path.join(isolatedDirectory, 'binding.node');
    await fs.copyFile(bindingPath, isolatedBinding);
    try {
      assert.equal(nativeFs.existsSync(path.join(isolatedDirectory, 'file-broker-win.exe')), false);
      const childEnvironment = { ...process.env, BITFROEST_NATIVE_TRANSFER_CHILD: '1', NATIVE_BINDING_TEST_PATH: isolatedBinding };
      delete childEnvironment.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', __filename], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
        env: childEnvironment
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /pass 9\b/, result.stdout);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
}
