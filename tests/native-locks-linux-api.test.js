const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createNativeApi } = require('../native-api');

const linux = { skip: process.platform !== 'linux' };
const bindingPath = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });

function nativeSession() {
  const api = createNativeApi(require(bindingPath));
  return { api, session: api.openSession() };
}

test('Linux native lock rename checks source and destination-parent identity and never replaces', linux, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-rename-')));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  const { api, session } = nativeSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });

  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'payload'), 'source');
  const request = {
    path: source,
    destination,
    expected: identity(await fs.stat(source, { bigint: true })),
    expectedParent: identity(await fs.stat(root, { bigint: true }))
  };

  const wrongParent = { ...request, expectedParent: { ...request.expectedParent, ino: String(BigInt(request.expectedParent.ino) + 1n) } };
  await assert.rejects(session.invoke('locks.rename', wrongParent));
  assert.equal(await fs.readFile(path.join(source, 'payload'), 'utf8'), 'source');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'payload'), 'destination');
  await assert.rejects(session.invoke('locks.rename', request));
  assert.equal(await fs.readFile(path.join(destination, 'payload'), 'utf8'), 'destination');
  assert.equal(await fs.readFile(path.join(source, 'payload'), 'utf8'), 'source');
  await fs.rm(destination, { recursive: true });

  const result = await session.invoke('locks.rename', request);
  assert.equal(result.changed, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.outcome, { status: 'committed', changed: 1, signalled: 0 });
  assert.equal(await fs.readFile(path.join(destination, 'payload'), 'utf8'), 'source');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('Linux native lock rename rejects malformed identities before mutation', linux, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-invalid-')));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  const { api, session } = nativeSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(source);
  const request = {
    path: source,
    destination,
    expected: identity(await fs.stat(source, { bigint: true })),
    expectedParent: identity(await fs.stat(root, { bigint: true }))
  };
  assert.throws(() => session.invoke('locks.rename', { ...request, expected: { dev: 'not-a-number', ino: request.expected.ino } }), { code: 'InvalidRequest' });
  assert.throws(() => session.invoke('locks.rename', { ...request, path: 'relative/source' }), { code: 'InvalidRequest' });
  assert.throws(() => session.invoke('processes.terminate', {
    path: root,
    hostPid: process.pid,
    rows: [{ pid: process.pid, started: 'test', file: '/etc/passwd', kind: 'handle' }]
  }), { code: 'InvalidRequest' });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await fs.stat(source);
});

test('Linux native process termination rejects stale identities and terminates only the confirmed child', { ...linux, timeout: 15000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-process-')));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  const { api, session } = nativeSession();
  t.after(async () => {
    await api.shutdownAsync();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  });
  await once(child, 'spawn');
  let stat;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { stat = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8'); if (stat) break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(stat, 'owned child has a procfs identity');
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const started = `linux:${boot}:${fields[19]}`;
  const row = { pid: child.pid, started, file: root, kind: 'handle' };
  const request = { path: root, hostPid: process.pid, rows: [row] };

  const stale = await session.invoke('processes.terminate', { ...request, rows: [{ ...row, started: `${started}:stale` }] });
  assert.equal(stale.changed, 0);
  assert.equal(stale.errors.length, 1);
  assert.deepEqual(stale.outcome, { status: 'unchanged', changed: 0, signalled: 0 });
  assert.equal(child.exitCode, null);

  const result = await session.invoke('processes.terminate', request);
  assert.equal(result.changed, 1, result.errors.join('\n'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.outcome, { status: 'committed', changed: 1, signalled: 1 });
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
});

test('Linux close barrier settles after queued native lock work and preserves its mutation outcome', linux, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-close-')));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  const { api, session } = nativeSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(source);
  const request = {
    path: source,
    destination,
    expected: identity(await fs.stat(source, { bigint: true })),
    expectedParent: identity(await fs.stat(root, { bigint: true }))
  };
  const operation = session.invoke('locks.rename', request);
  const rejection = assert.rejects(operation, error => {
    assert.equal(error.code, 'SessionClosed');
    assert.ok(['committed', 'unchanged'].includes(error.outcome?.status));
    return true;
  });
  session.close();
  await session.closeAsync();
  await rejection;
  const sourceExists = await fs.stat(source).then(() => true, () => false);
  const destinationExists = await fs.stat(destination).then(() => true, () => false);
  assert.notEqual(sourceExists, destinationExists, 'rename outcome and filesystem state agree');
});

test('Linux native lock work is cancelled during worker termination and the binding remains callable', { ...linux, timeout: 25000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-worker-')));
  const source = path.join(root, 'worker-source'), destination = path.join(root, 'worker-destination');
  const followupSource = path.join(root, 'followup-source'), followupDestination = path.join(root, 'followup-destination');
  await fs.mkdir(source);
  await fs.mkdir(followupSource);
  await fs.writeFile(path.join(source, 'payload'), 'worker-owned');
  await fs.writeFile(path.join(followupSource, 'payload'), 'parent-owned');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const apiFactory = path.join(__dirname, '../native-api.js');
  const workerCode = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { createNativeApi } = require(workerData.apiFactory);",
    "const api = createNativeApi(require(workerData.binding));",
    "const session = api.openSession();",
    "const fs = require('node:fs');",
    "const parent = fs.statSync(workerData.root, { bigint: true });",
    "const item = fs.statSync(workerData.source, { bigint: true });",
    "parentPort.postMessage('ready');",
    "parentPort.once('message', () => {",
    "  for (let index = 0; index < 16; index++) session.invoke('locks.rename', { path: workerData.source, destination: workerData.destination, expected: { dev: String(item.dev), ino: String(item.ino) }, expectedParent: { dev: String(parent.dev), ino: String(parent.ino) } }).catch(() => {});",
    "  parentPort.postMessage('queued');",
    "  for (;;) {}",
    "});"
  ].join('\n');
  const scenario = [
    '(async () => {',
    "const { Worker } = require('node:worker_threads');",
    "const { once } = require('node:events');",
    "const fs = require('node:fs/promises');",
    "const crypto = require('node:crypto');",
    "const { createNativeApi } = require(process.env.LOCKS_API_FACTORY);",
    "const root = process.env.LOCKS_ROOT;",
    "const bindingPath = process.env.NATIVE_BINDING_TEST_PATH;",
    "const worker = new Worker(process.env.LOCKS_WORKER_CODE, { eval: true, workerData: { apiFactory: process.env.LOCKS_API_FACTORY, binding: bindingPath, root, source: process.env.LOCKS_SOURCE, destination: process.env.LOCKS_DESTINATION } });",
    "if ((await once(worker, 'message'))[0] !== 'ready') throw new Error('worker did not prepare native request');",
    "let completedPbkdf2 = 0;",
    "for (let i = 0; i < 4; i++) crypto.pbkdf2('input', 'salt', 20000000, 32, 'sha256', () => { completedPbkdf2++; });",
    "await new Promise(resolve => setTimeout(resolve, 100));",
    "worker.postMessage('go');",
    "if ((await once(worker, 'message'))[0] !== 'queued') throw new Error('worker did not queue native work');",
    "if (completedPbkdf2 !== 0) throw new Error('PBKDF2 work completed before native request was queued');",
    "let poolProbeSettled = false;",
    "const poolProbe = fs.stat(root, { bigint: true }).then(() => { poolProbeSettled = true; });",
    "await new Promise(resolve => setImmediate(resolve));",
    "if (poolProbeSettled || completedPbkdf2 !== 0) throw new Error('the libuv pool was not blocked when native work was queued');",
    "const termination = worker.terminate();",
    "await Promise.all([termination, poolProbe]);",
    "if ((await fs.stat(process.env.LOCKS_SOURCE).then(() => true, () => false)) !== true) throw new Error('closed worker session mutated the source after queue release');",
    "if (await fs.stat(process.env.LOCKS_DESTINATION).then(() => true, () => false)) throw new Error('closed worker session published its destination');",
    "const api = createNativeApi(require(bindingPath));",
    "const session = api.openSession();",
    "const parent = await fs.stat(root, { bigint: true });",
    "const item = await fs.stat(process.env.LOCKS_FOLLOWUP_SOURCE, { bigint: true });",
    "const result = await session.invoke('locks.rename', { path: process.env.LOCKS_FOLLOWUP_SOURCE, destination: process.env.LOCKS_FOLLOWUP_DESTINATION, expected: { dev: String(item.dev), ino: String(item.ino) }, expectedParent: { dev: String(parent.dev), ino: String(parent.ino) } });",
    "if (result.changed !== 1 || result.outcome.status !== 'committed') throw new Error('binding did not remain usable after worker termination');",
    "await api.shutdownAsync();",
    '})().catch(error => { console.error(error); process.exitCode = 1; });'
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', scenario], {
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: '4',
      NATIVE_BINDING_TEST_PATH: bindingPath,
      LOCKS_API_FACTORY: apiFactory,
      LOCKS_ROOT: root,
      LOCKS_SOURCE: source,
      LOCKS_DESTINATION: destination,
      LOCKS_FOLLOWUP_SOURCE: followupSource,
      LOCKS_FOLLOWUP_DESTINATION: followupDestination,
      LOCKS_WORKER_CODE: workerCode
    },
    encoding: 'utf8',
    timeout: 20000
  });
  if (result.error) throw new Error(`Worker cleanup fixture did not finish.\n${result.stdout}\n${result.stderr}`, { cause: result.error });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Linux native lock operations reject invalid request shapes synchronously', linux, () => {
  const { api, session } = nativeSession();
  try {
    assert.throws(() => session.invoke('locks.rename', null), { code: 'InvalidRequest' });
    assert.throws(() => session.invoke('processes.terminate', { path: '/tmp', hostPid: process.pid, rows: [{ pid: 0, started: 'x', file: '/tmp', kind: 'handle' }] }), { code: 'InvalidRequest' });
  } finally { api.shutdown(); }
});

test('Linux session close drains multiple pending native requests without mutating their sources', linux, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-drain-')));
  const { api, session } = nativeSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  const parent = identity(await fs.stat(root, { bigint: true }));
  const requests = [];
  for (let index = 0; index < 16; index++) {
    const source = path.join(root, `source-${index}`), destination = path.join(root, `destination-${index}`);
    await fs.mkdir(source);
    requests.push({ path: source, destination, expected: identity(await fs.stat(source, { bigint: true })), expectedParent: parent });
  }
  const results = Promise.allSettled(requests.map(request => session.invoke('locks.rename', request)));
  await session.closeAsync();
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'SessionClosed');
    assert.equal(result.reason.outcome.status, 'unchanged');
  }
  for (const request of requests) {
    await fs.stat(request.path);
    await assert.rejects(fs.stat(request.destination), { code: 'ENOENT' });
  }
});

test('Linux native mutation completes while all shared Node work threads remain occupied', { ...linux, timeout: 15000 }, async t => {
  const crypto = require('node:crypto');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-locks-linux-pool-')));
  const { api, session } = nativeSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  await fs.mkdir(source);
  const request = { path: source, destination, expected: identity(await fs.stat(source, { bigint: true })), expectedParent: identity(await fs.stat(root, { bigint: true })) };
  let completed = 0;
  const busy = Array.from({ length: Number(process.env.UV_THREADPOOL_SIZE) || 4 }, () => new Promise((resolve, reject) => {
    crypto.pbkdf2('input', 'salt', 20000000, 32, 'sha256', error => {
      completed++;
      if (error) reject(error); else resolve();
    });
  }));
  try {
    const result = await session.invoke('locks.rename', request);
    assert.equal(result.changed, 1);
    assert.equal(completed, 0, 'native mutation must not wait behind shared Node work');
  } finally { await Promise.all(busy); }
  await fs.stat(destination);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});
