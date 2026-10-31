const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createNativeApi } = require('../native-api');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' || process.arch !== 'x64' };
const operations = ['locks.scan', 'locks.releaseHandles', 'locks.unloadModules', 'locks.rename', 'processes.terminate', 'restartDeletion.prepare', 'restartDeletion.commit'];
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });

test('native lock capabilities declare platform and process access conditions', windows, () => {
  const api = createNativeApi(require(binary));
  try {
    for (const operation of operations) {
      assert.equal(api.capabilities[operation]?.status, 'conditional', operation);
      assert.equal(api.capabilities[operation]?.reason, 'Windows10Or11X64AndProcessAccess', operation);
    }
  } finally { api.shutdown(); }
});

test('native lock module unload verifies the owned library and leaves its process responsive', { ...windows, timeout: 70000 }, async t => {
  const moduleFixture = process.env.NATIVE_LOCKS_MODULE_FIXTURE;
  assert.ok(moduleFixture, 'NATIVE_LOCKS_MODULE_FIXTURE must name the prebuilt test module.');
  if (process.env.NATIVE_LOCKS_MODULE_CHILD !== '1') {
    const environment = { ...process.env, NATIVE_LOCKS_MODULE_CHILD: '1' };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-name-pattern=^native lock module unload', __filename], {
      env: environment, windowsHide: true, encoding: 'utf8', timeout: 60000
    });
    if (result.error) throw new Error(`The native module fixture did not finish.\n${result.stdout || ''}\n${result.stderr || ''}`, { cause: result.error });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-lock-module-')));
  const library = path.join(root, 'owned-version-fixture.dll');
  await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'version.dll'), library);
  const original = await fs.readFile(library);
  const code = `const fixture = require(process.argv[1]);
    const library = process.argv[2];
    setTimeout(() => process.exit(0), 30000);
    process.on('disconnect', () => process.exit(0));
    const base = String(fixture.load(library));
    process.on('message', message => {
      if (message === 'probe') process.send({ loaded: fixture.loaded(library) });
      if (message === 'exit') process.exit(0);
    });
    process.send({ ready: true, base });`;
  const child = spawn(process.execPath, ['-e', code, moduleFixture, library], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const api = createNativeApi(require(binary)), session = api.openSession();
  t.after(async () => {
    await api.shutdownAsync();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  });
  const ready = (await once(child, 'message'))[0];
  assert.equal(ready.ready, true, stderr);
  const probe = async () => { const received = once(child, 'message'); child.send('probe'); return (await received)[0]; };
  assert.equal((await probe()).loaded, true);
  const scan = await session.invoke('locks.scan', { path: root });
  const row = scan.rows.find(item => item.pid === child.pid && item.kind === 'module' && item.file.toLowerCase() === library.toLowerCase());
  assert.ok(row, 'The scan must identify the owned library loaded in the fixture child.');
  assert.equal(row.module, ready.base);
  const request = { path: root, hostPid: process.pid, rows: [row] };
  const stale = await session.invoke('locks.unloadModules', { ...request, rows: [{ ...row, module: '1' }] });
  assert.equal(stale.changed, 0);
  assert.equal(stale.errors.length, 1);
  assert.equal((await probe()).loaded, true);
  const result = await session.invoke('locks.unloadModules', request);
  assert.equal(result.changed, 1, result.errors.join('\n'));
  assert.deepEqual(result.errors, []);
  assert.equal((await probe()).loaded, false);
  assert.equal(child.exitCode, null);
  child.send('exit');
  await exited;
  assert.equal(child.exitCode, 0);
  assert.deepEqual(await fs.readFile(library), original);
});

test('native lock operations reject malformed requests before accessing processes or configuration', windows, () => {
  const session = require(binary).openSession();
  try {
    for (const operation of operations) {
      for (const request of [null, [], {}, { path: 'relative' }, { path: 'C:/tmp\0invalid' }]) {
        assert.throws(() => session.invoke(operation, request), { code: 'InvalidRequest' }, operation);
      }
    }
  } finally { session.close(); }
});

test('native lock rename validates the destination parent when moving between directories', windows, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-lock-rename-parent-')));
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  await fs.mkdir(left); await fs.mkdir(right);
  const source = path.join(left, 'folder'), destination = path.join(right, 'moved');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'child.txt'), 'preserved across parents');
  const api = createNativeApi(require(binary)), session = api.openSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  const request = { path: source, destination, expected: identity(await fs.stat(source, { bigint: true })), expectedParent: identity(await fs.stat(right, { bigint: true })) };
  await assert.rejects(session.invoke('locks.rename', { ...request, expectedParent: identity(await fs.stat(left, { bigint: true })) }));
  assert.equal(await fs.readFile(path.join(source, 'child.txt'), 'utf8'), 'preserved across parents');
  const result = await session.invoke('locks.rename', request);
  assert.equal(result.changed, 1);
  assert.equal(await fs.readFile(path.join(destination, 'child.txt'), 'utf8'), 'preserved across parents');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('native lock rename preserves children and rejects replaced source identities and occupied destinations', windows, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-lock-rename-')));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'child.txt'), 'original contents');
  const api = createNativeApi(require(binary)), session = api.openSession();
  t.after(async () => { await api.shutdownAsync(); await fs.rm(root, { recursive: true, force: true }); });
  const request = { path: source, destination, expected: identity(await fs.stat(source, { bigint: true })), expectedParent: identity(await fs.stat(root, { bigint: true })) };
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'external.txt'), 'external contents');
  await assert.rejects(session.invoke('locks.rename', request));
  assert.equal(await fs.readFile(path.join(destination, 'external.txt'), 'utf8'), 'external contents');
  assert.equal(await fs.readFile(path.join(source, 'child.txt'), 'utf8'), 'original contents');
  await fs.rm(destination, { recursive: true });
  await fs.rename(source, source + '-saved');
  await fs.mkdir(source);
  await assert.rejects(session.invoke('locks.rename', request));
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await fs.rmdir(source);
  await fs.rename(source + '-saved', source);
  const result = await session.invoke('locks.rename', request);
  assert.equal(result.changed, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(await fs.readFile(path.join(destination, 'child.txt'), 'utf8'), 'original contents');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

async function fileHandleScenario(t, forceStopFailure = false) {
  const diagnosticPath = forceStopFailure ? process.env.NATIVE_LOCKS_DETACH_TEST_BINDING : process.env.NATIVE_LOCKS_DIAGNOSTIC_BINDING;
  if (forceStopFailure) assert.ok(diagnosticPath, 'NATIVE_LOCKS_DETACH_TEST_BINDING must name the prebuilt fault test module.');
  if (process.env.NATIVE_LOCKS_PROCESS_CHILD !== '1') {
    const environment = { ...process.env, NATIVE_LOCKS_PROCESS_CHILD: '1' };
    delete environment.NODE_TEST_CONTEXT;
    const pattern = forceStopFailure ? '^native lock forced detach' : '^native lock scan release';
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', `--test-name-pattern=${pattern}`, __filename], {
      env: environment, windowsHide: true, encoding: 'utf8', timeout: diagnosticPath ? 15000 : 60000
    });
    if (result.error) throw new Error(`The native lock fixture did not finish.\n${result.stdout || ''}\n${result.stderr || ''}`, { cause: result.error });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return;
  }
  const phase = name => process.stderr.write(`Native lock fixture phase: ${name}\n`);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-lock-process-')));
  const file = path.join(root, 'held.txt');
  await fs.writeFile(file, 'owned file contents');
  const code = `const fs = require('node:fs');
    setTimeout(() => process.exit(0), 30000);
    process.on('disconnect', () => process.exit(0));
    const fd = fs.openSync(process.argv[1], 'r');
    process.on('message', message => {
      if (message === 'probe') {
        try { fs.fstatSync(fd); process.send({ open: true }); }
        catch (error) { process.send({ open: false, code: error.code }); }
      }
    });
    process.send({ ready: true });`;
  const child = spawn(process.execPath, ['-e', code, file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const api = createNativeApi(require(binary)), session = api.openSession();
  t.after(async () => {
    phase('cleanup native sessions');
    await api.shutdownAsync();
    phase('cleanup fixture process');
    if (child.exitCode === null && child.signalCode === null) phase(`cleanup kill requested=${child.kill()}`);
    await exited;
    phase('cleanup fixture exited');
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal((await once(child, 'message'))[0].ready, true, stderr);
  const probe = async () => { const received = once(child, 'message'); child.send('probe'); return (await received)[0]; };
  phase('initial probe');
  assert.equal((await probe()).open, true);
  phase('scan');
  const scan = await session.invoke('locks.scan', { path: root });
  assert.ok(Number.isInteger(scan.inaccessible));
  const row = scan.rows.find(item => item.pid === child.pid && item.kind === 'handle' && item.file.toLowerCase() === file.toLowerCase());
  assert.ok(row, 'The scan must identify the file handle held by the owned child.');
  assert.match(row.started, /^\d+$/);
  assert.ok(row.commandLine.includes(file));
  phase('release');
  let released;
  if (diagnosticPath) {
    phase('diagnostic load');
    const diagnostic = require(diagnosticPath);
    phase('diagnostic loaded');
    const timer = setInterval(() => {
      const state = diagnostic.traceState();
      process.stderr.write(`Native release trace: api=${state.api} active=${state.active} pid=${state.processId} handle=${state.handle}\n`);
    }, 1000);
    try {
      phase('diagnostic request');
      if (forceStopFailure) diagnostic.forceStopFailure(true);
      const pending = diagnostic.release(root, process.pid, row);
      phase('diagnostic queued');
      released = await pending;
      const trace = diagnostic.traceState();
      phase(`diagnostic result api=${trace.api} active=${trace.active} pid=${trace.processId} handle=${trace.handle}`);
    } catch (error) {
      const trace = error.trace || diagnostic.traceState();
      phase(`diagnostic failure api=${trace.api} active=${trace.active} code=${error.nativeCode}`);
      throw error;
    }
    finally { clearInterval(timer); }
  } else {
    released = await session.invoke('locks.releaseHandles', { path: root, hostPid: process.pid, rows: [row] });
  }
  phase(`release returned changed=${released.changed} errors=${released.errors.join(';')}`);
  assert.equal(released.changed, forceStopFailure ? 0 : 1, released.errors.join('\n'));
  if (forceStopFailure) assert.equal(released.errors.length, 1);
  else assert.deepEqual(released.errors, []);
  assert.equal(child.exitCode, null);
  phase('released handle probe');
  assert.equal((await probe()).open, false);
  phase('terminate');
  const stopped = await session.invoke('processes.terminate', { path: root, hostPid: process.pid, rows: [row] });
  assert.equal(stopped.changed, 1, stopped.errors.join('\n'));
  assert.deepEqual(stopped.errors, []);
  await exited;
  phase('complete');
  assert.equal(await fs.readFile(file, 'utf8'), 'owned file contents');
}

test('native lock scan release and termination affect only the owned fixture process', { ...windows, timeout: 70000 }, t => fileHandleScenario(t));
test('native lock forced detach failure reports the error and leaves its process responsive', { ...windows, timeout: 70000 }, t => fileHandleScenario(t, true));
