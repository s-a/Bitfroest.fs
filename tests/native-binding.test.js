const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

test('Windows content metadata reports sparse and offline flags and actual short names', { skip: process.platform !== 'win32' }, async () => {
  const session = require(binary).openSession();
  try {
    const result = await session.invoke('metadata.query', { path: __filename, shortName: true });
    assert.equal(typeof result.attributes.sparse, 'boolean');
    assert.equal(typeof result.attributes.offline, 'boolean');
    assert.equal(typeof result.dosName, 'string');
    assert.ok(result.dosName.length <= 12);
    assert.throws(() => session.invoke('metadata.query', { path: __filename, shortName: 'yes' }), { code: 'InvalidRequest' });
  } finally { session.close(); }
});

test('Windows DOS names retain an existing short filename without generating an alias', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-shortname-'));
  const target = path.join(directory, 'short.txt'); await fs.writeFile(target, 'same');
  const session = require(binary).openSession();
  try { assert.equal((await session.invoke('metadata.query', { path: target, shortName: true })).dosName.toLowerCase(), 'short.txt'); }
  finally { session.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
const fs = require('node:fs/promises');
const os = require('node:os');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('compiled binding exposes an honest versioned capability contract', () => {
  const binding = require(binary);
  assert.deepEqual(binding.apiVersion, { major: 1, minor: 2 });
  assert.equal(binding.capabilities['git.status'].dirtySummary, true);
  assert.ok(Object.keys(binding.capabilities).length >= 20);
  for (const [operation, capability] of Object.entries(binding.capabilities)) {
    if (process.platform === 'win32' && process.arch === 'x64' && ['locks.scan', 'locks.releaseHandles', 'locks.unloadModules', 'locks.rename', 'processes.terminate', 'restartDeletion.prepare', 'restartDeletion.commit'].includes(operation)) {
      assert.equal(capability.status, 'conditional');
      assert.equal(capability.reason, 'Windows10Or11X64AndProcessAccess');
    } else if (process.platform === 'win32' && operation === 'files.rename') {
      assert.equal(capability.status, 'conditional');
      assert.equal(capability.reason, 'CaseOnlySameDirectory');
    } else if (process.platform === 'win32' && ['encoding.decodeBlock', 'encoding.decodeChunk'].includes(operation)) {
      assert.equal(capability.status, 'conditional');
      assert.equal(capability.reason, 'SingleDoubleByteUtf8AndGB18030Codepages');
    } else if (['git.status', 'git.info'].includes(operation) || (process.platform === 'win32' && ['metadata.query', 'paths.resolveNetwork', 'encoding.describe', 'icons.resolve', 'files.copy', 'shell.openAssociated', 'shell.openTrash', 'shell.openTerminal', 'shell.showContextMenu', 'windows.maximize', 'clipboard.readFiles', 'clipboard.writeFiles', 'clipboard.acknowledge', 'clipboard.cancelFiles'].includes(operation))) {
      assert.equal(capability.status, 'supported');
    } else {
      assert.equal(capability.status, 'unsupported');
      assert.equal(capability.reason, 'NotImplemented');
    }
  }
  assert.ok(Object.isFrozen(binding.capabilities));
});

test('native sessions validate receivers, close idempotently and reject closed use', () => {
  const binding = require(binary);
  const a = binding.openSession(), b = binding.openSession();
  assert.notEqual(a.generation, b.generation);
  assert.throws(() => a.close.call({}), { code: 'InvalidSession' });
  assert.throws(() => a.invoke('runShell', {}), { code: 'UnknownOperation' });
  assert.throws(() => a.invoke('locks.scan', {}), { code: process.platform === 'win32' && process.arch === 'x64' ? 'InvalidRequest' : 'UnsupportedOperation' });
  assert.equal(a.close(), true);
  assert.equal(a.close(), false);
  assert.throws(() => a.invoke('metadata.query', {}), { code: 'SessionClosed' });
  b.close();
});

test('Windows metadata reads actual Unicode paths, flags and native errors without mutation', { skip: process.platform !== 'win32' }, async () => {
  const binding = require(binary);
  const { createNativeApi } = require('../native-api');
  const api = createNativeApi(binding);
  const session = api.openSession();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'native-metadata-'));
  const target = path.join(folder, 'Grüße-文件.txt');
  try {
    await fs.writeFile(target, 'unchanged');
    const file = await session.invoke('metadata.query', { path: target });
    assert.equal(file.provenance, 'win32.fileAttributes');
    assert.equal(file.attributes.directory, false);
    assert.equal(file.attributes.readonly, false);
    assert.equal(file.attributes.compressed, false);
    assert.equal(file.attributes.encrypted, false);
    assert.equal(file.attributes.archive, true);
    assert.equal((await session.invoke('metadata.query', { path: folder })).attributes.directory, true);
    await assert.rejects(session.invoke('metadata.query', { path: target + '.missing' }), { code: 'NotFound', operation: 'metadata.query' });
    assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
    assert.throws(() => session.invoke('metadata.query', { path: 'relative.txt' }), { code: 'InvalidRequest' });
    assert.throws(() => session.invoke('metadata.query', { path: target + '\0tail' }), { code: 'InvalidRequest' });
    assert.throws(() => session.invoke('metadata.query', {}), { code: 'InvalidRequest' });
    assert.throws(() => session.invoke('metadata.query', null), { code: 'InvalidRequest' });
  } finally { api.shutdown(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('Windows file clipboard is advertised and rejects invalid requests before using the system clipboard', { skip: process.platform !== 'win32' }, () => {
  const binding = require(binary);
  for (const operation of ['clipboard.readFiles', 'clipboard.writeFiles', 'clipboard.acknowledge']) {
    assert.equal(binding.capabilities[operation]?.status, 'supported');
  }
  const session = binding.openSession();
  try {
    assert.throws(() => session.invoke('clipboard.writeFiles', { paths: ['relative.txt'], mode: 'copy' }), { code: 'InvalidRequest' });
    assert.throws(() => session.invoke('clipboard.acknowledge', { token: '', paths: [], mode: 'copy', remainingPaths: [] }), { code: 'InvalidRequest' });
  } finally {
    session.close();
  }
});

test('closing a session rejects pending metadata instead of returning stale success', { skip: process.platform !== 'win32' }, async () => {
  const session = require(binary).openSession();
  const pending = session.invoke('metadata.query', { path: __filename });
  session.close();
  await assert.rejects(pending, { code: 'SessionClosed' });
});

test('binding supports independent worker environments and teardown', async () => {
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const b = require(workerData); b.openSession(); parentPort.postMessage(b.apiVersion.major);`, { eval: true, workerData: binary });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
  })));
});
