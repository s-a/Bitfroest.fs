const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');
const { createFolderLocks } = require('../folder-locks');

test('native lock timeout remains a rejected request when session cleanup fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-native-close-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const closeError = new Error('Native cleanup failed.');
  const nativeApi = { capabilities: { 'locks.scan': { status: 'supported' } }, openSession: () => ({
    close() { throw closeError; }, invoke: () => new Promise(() => {})
  }) };
  const provider = createFolderLocks({ platform: 'win32', roots: [root], nativeApi, timeout: 2 });
  t.after(() => provider.dispose());
  await assert.rejects(provider.scan(root), error => error.code === 'ETIMEDOUT' && error.cause === closeError);
});

test('native lock deadline closes the stalled session and allows a fresh explicit scan', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-native-deadline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const sessions = [];
  const nativeApi = { capabilities: { 'locks.scan': { status: 'supported' } }, openSession() {
    const index = sessions.length;
    const session = { closed: false, close() { session.closed = true; }, invoke() {
      if (index === 0) { entered(); return new Promise(resolve => { finish = resolve; }); }
      return Promise.resolve({ rows: [], inaccessible: 0 });
    } };
    sessions.push(session); return session;
  } };
  const provider = createFolderLocks({ platform: 'win32', roots: [root], nativeApi, timeout: 2 });
  t.after(() => provider.dispose());
  const pending = provider.scan(root);
  await started;
  let watchdog;
  try {
    await Promise.race([
      assert.rejects(pending, { code: 'ETIMEDOUT' }),
      new Promise((_, reject) => { watchdog = setTimeout(() => { finish({ rows: [], inaccessible: 0 }); reject(new Error('The native caller deadline did not fire.')); }, 100); })
    ]);
  } finally { clearTimeout(watchdog); }
  assert.equal(sessions[0].closed, true);
  finish({ rows: [], inaccessible: 9 });
  assert.equal((await provider.scan(root)).inaccessible, 0);
  assert.equal(sessions.length, 2);
});

test('disposing an active native lock provider rejects its pending caller immediately', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-native-dispose-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let entered, finish, closed = false;
  const started = new Promise(resolve => { entered = resolve; });
  const nativeApi = { capabilities: { 'locks.scan': { status: 'supported' } }, openSession: () => ({
    close() { closed = true; }, invoke() { entered(); return new Promise(resolve => { finish = resolve; }); }
  }) };
  const provider = createFolderLocks({ platform: 'win32', roots: [root], nativeApi });
  t.after(() => provider.dispose());
  const pending = provider.scan(root);
  await started;
  provider.dispose();
  let watchdog;
  try {
    await Promise.race([
      assert.rejects(pending, /geschlossen/),
      new Promise((_, reject) => { watchdog = setTimeout(() => { finish({ rows: [], inaccessible: 0 }); reject(new Error('The pending native caller was not rejected on dispose.')); }, 100); })
    ]);
  } finally { clearTimeout(watchdog); }
  assert.equal(closed, true);
});

const operations = ['locks.scan', 'locks.releaseHandles', 'locks.unloadModules', 'locks.rename', 'processes.terminate', 'restartDeletion.prepare', 'restartDeletion.commit'];
async function nativeFixture(t, invoke, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-native-api-'));
  const folder = path.join(root, 'target'); await fs.mkdir(folder);
  const file = path.join(folder, 'held.txt'); await fs.writeFile(file, 'fixture');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], session = {
    invoke(operation, request) { calls.push({ operation, request }); return invoke(operation, request); },
    close() { calls.push({ operation: 'close' }); }
  };
  const nativeApi = {
    capabilities: Object.fromEntries(operations.map(operation => [operation, { status: 'supported' }])),
    openSession: () => session
  };
  const provider = createFolderLocks({ platform: 'win32', roots: [root], nativeApi, spawn: () => { throw new Error('process start forbidden'); }, ...options });
  t.after(() => provider.dispose());
  return { root, folder, file, calls, provider };
}

test('a late native handle response cannot start module unloading after the caller deadline', async t => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { folder, file, calls, provider } = await nativeFixture(t, operation => {
    if (operation === 'locks.scan') return { rows: [
      { pid: 8123, started: '12345', file, kind: 'handle', handle: '124' },
      { pid: 8123, started: '12345', file, kind: 'module', module: '65536' }
    ], inaccessible: 0 };
    if (operation === 'locks.releaseHandles') { entered(); return new Promise(resolve => { finish = resolve; }); }
    assert.fail(`Unexpected operation after the native deadline: ${operation}`);
  }, { timeout: 2 });
  const state = await provider.scan(folder);
  const pending = provider.act('unlock', state.rows.map(row => row.id));
  await started;
  await assert.rejects(pending, { code: 'ETIMEDOUT' });
  finish({ changed: 1, errors: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.operation === 'locks.unloadModules').length, 0);
});

test('Windows scan uses the versioned native API and closes its session without starting a process', async t => {
  const { folder, calls, provider } = await nativeFixture(t, (operation) => {
    if (operation === 'locks.scan') return Promise.resolve({ rows: [], inaccessible: 0 });
    throw new Error(`Unexpected operation ${operation}`);
  });

  const state = await provider.scan(folder);
  assert.deepEqual(state.rows, []);
  assert.equal(calls[0].operation, 'locks.scan');
  assert.equal(calls[0].request.path, folder);
  provider.dispose();
  assert.equal(calls.at(-1).operation, 'close');
});

test('Windows default uses the packaged native binding without starting an interpreter', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-native-default-'));
  const folder = path.join(root, 'target'); await fs.mkdir(folder);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = stubPackagedNativeBinding(t, { 'locks.scan': () => ({ rows: [], inaccessible: 0 }) });
  const provider = createFolderLocks({ platform: 'win32', roots: [root], spawn: () => assert.fail('The Windows default must not start an interpreter.') });
  t.after(() => provider.dispose());

  const state = await provider.scan(folder);
  assert.deepEqual(state.rows, []);
  assert.deepEqual(app.calls, [{ operation: 'locks.scan', request: { path: folder } }]);
  provider.dispose();
  assert.equal(app.sessions[0].closed, true);
});

test('Windows actions preserve observed identities and route to typed native operations', async t => {
  let row;
  const { root, folder, file, calls, provider } = await nativeFixture(t, (operation, request) => {
    if (operation === 'locks.scan') return { rows: [
      { pid: 8123, started: '12345', file, kind: 'handle', handle: '124' },
      { pid: 8123, started: '12345', file, kind: 'module', module: '65536' },
      { pid: 8123, started: '12345', file, kind: 'image' }
    ], inaccessible: 1 };
    if (operation === 'restartDeletion.prepare') return { token: 'prepared-token', backup: request.backup };
    return { changed: 1, errors: [] };
  });
  const scanned = await provider.scan(folder);
  row = scanned.rows;
  await provider.act('unlock', row.map(item => item.id));
  assert.equal(calls[1].operation, 'locks.releaseHandles');
  assert.deepEqual(calls[1].request.rows.map(item => item.kind), ['handle', 'image']);
  assert.equal(calls[1].request.rows[0].handle, '124');
  assert.equal(calls[2].operation, 'locks.unloadModules');
  assert.equal(calls[2].request.rows[0].module, '65536');
  assert.equal(calls[1].request.hostPid, process.pid);

  await provider.act('terminate', [row[0].id]);
  assert.equal(calls[3].operation, 'processes.terminate');
  assert.equal(calls[3].request.rows[0].started, '12345');

  const destination = path.join(root, 'renamed');
  await provider.fileAction('rename', [], destination);
  assert.equal(calls[4].operation, 'locks.rename');
  assert.equal(calls[4].request.path, folder);
  assert.equal(calls[4].request.destination, destination);
  assert.deepEqual(Object.keys(calls[4].request.expected).sort(), ['dev', 'ino']);
  assert.deepEqual(Object.keys(calls[4].request.expectedParent).sort(), ['dev', 'ino']);

  const backup = path.join(root, 'backup.reg');
  await provider.schedule(backup);
  assert.equal(calls[5].operation, 'restartDeletion.prepare');
  assert.equal(calls[6].operation, 'restartDeletion.commit');
  assert.equal(calls[6].request.token, 'prepared-token');
  assert.equal(calls[6].request.backup, backup);
});
