const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createNativeApi } = require('../native-api');

const bindingPath = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

async function fixture(t, size = 8 * 1024 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-linux-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.bin');
  const target = path.join(root, '.stage', 'target.bin');
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(source, Buffer.alloc(size, 0x5a));
  await fs.chmod(source, 0o640);
  const stat = await fs.stat(source, { bigint: true });
  const request = {
    roots: [root], source, target,
    expected: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]))
  };
  const binding = require(bindingPath);
  const api = createNativeApi(binding);
  t.after(() => api.shutdownAsync());
  return { root, source, target, request, api };
}

test('Linux native files.copy preserves contents and POSIX mode and reports actual bytes', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  await fs.utimes(f.source, new Date('2001-02-03T04:05:06.123Z'), new Date('2001-02-03T04:05:07.456Z'));
  const sourceBefore = await fs.stat(f.source, { bigint: true });
  f.request.expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceBefore[key])]));
  assert.ok(['supported', 'conditional'].includes(f.api.capabilities['files.copy'].status), f.api.capabilities['files.copy'].reason);
  const session = f.api.openSession();
  const progress = [];
  const outcome = await session.invoke('files.copy', f.request, { onProgress: value => progress.push(value) });
  assert.equal(outcome.status, 'committed');
  const targetExact = await fs.stat(f.target, { bigint: true });
  assert.equal(String(targetExact.atimeNs), String(sourceBefore.atimeNs));
  assert.equal(String(targetExact.mtimeNs), String(sourceBefore.mtimeNs));
  const [sourceStat, targetStat] = await Promise.all([fs.stat(f.source), fs.stat(f.target)]);
  assert.equal(targetStat.mode & 0o7777, sourceStat.mode & 0o7777);
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.source));
  assert.ok(progress.some(event => event.transferred > 0 && event.transferred < event.total));
  assert.equal(progress.at(-1).transferred, 8 * 1024 * 1024);
  session.close();
});

test('Linux native files.copy ignores cancellation requested after commit and retains the committed destination', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  const rawSession = require(bindingPath).openSession();
  const pending = rawSession.invoke('files.copy', f.request);
  const committed = await pending;
  assert.equal(committed.status, 'committed');
  pending.cancel();
  assert.equal(committed.cancelled, false);
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.source));
  assert.equal((await fs.stat(f.target)).size, 4096);
  rawSession.close();
  await rawSession.whenClosed();
});

test('Linux native files.copy never replaces a destination and binds completion to the created inode', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  await fs.writeFile(f.target, 'existing');
  const session = f.api.openSession();
  await assert.rejects(session.invoke('files.copy', f.request), error => {
    assert.equal(error.outcome.status, 'unchanged');
    assert.equal(error.outcome.copied, false);
    return true;
  });
  assert.equal(await fs.readFile(f.target, 'utf8'), 'existing');
  session.close();
});

test('Linux native files.copy rejects stale source identity and symlinked path components before writing', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  const session = f.api.openSession();
  const stale = { ...f.request, target: path.join(f.root, '.stage', 'stale.bin'), expected: { ...f.request.expected, ino: String(BigInt(f.request.expected.ino) + 1n) } };
  await assert.rejects(session.invoke('files.copy', stale), error => {
    assert.equal(error.code, 'IdentityChanged');
    assert.equal(error.outcome.status, 'unchanged');
    assert.deepEqual(error.outcome.sourceIdentity.expected, stale.expected);
    return true;
  });
  const linkedDirectory = path.join(f.root, 'linked-stage');
  await fs.symlink(path.join(f.root, '.stage'), linkedDirectory, 'dir');
  const linked = { ...f.request, target: path.join(linkedDirectory, 'linked.bin') };
  await assert.rejects(session.invoke('files.copy', linked), error => error.outcome.status === 'unchanged');
  await assert.rejects(fs.stat(linked.target), { code: 'ENOENT' });
  session.close();
});

test('Linux native files.copy rejects a source replaced by a FIFO without blocking the worker', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  await fs.unlink(f.source);
  execFileSync('mkfifo', ['-m', '600', f.source]);
  const probe = [
    "const binding = require(process.env.NATIVE_BINDING_TEST_PATH);",
    "const request = JSON.parse(process.env.NATIVE_COPY_REQUEST);",
    "const session = binding.openSession();",
    "(async () => {",
    "  let result;",
    "  try { const value = await session.invoke('files.copy', request); result = { status: value.status }; }",
    "  catch (error) { result = { code: error.code, outcome: error.outcome?.status }; }",
    "  session.close(); await session.whenClosed(); process.stdout.write(JSON.stringify(result));",
    "})().catch(error => { console.error(error); process.exitCode = 1; });"
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', probe], {
    env: { ...process.env, NATIVE_BINDING_TEST_PATH: bindingPath, NATIVE_COPY_REQUEST: JSON.stringify(f.request) },
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'
  });
  assert.equal(child.error, undefined, `native copy child did not settle: ${child.error?.code || child.error}`);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: 'NativeFailure', outcome: 'unchanged' });
});

test('Linux native files.copy round-trips astral Unicode and literal backslashes and preserves pre-epoch mtime', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  const timestamp = new Date('1960-01-02T03:04:05.678Z');
  await fs.utimes(f.source, timestamp, timestamp);
  const sourceStat = await fs.stat(f.source, { bigint: true });
  const target = path.join(f.root, '.stage', 'target-😀\\part.bin');
  const request = {
    ...f.request,
    target,
    expected: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])]))
  };
  const session = f.api.openSession();
  const outcome = await session.invoke('files.copy', request);
  assert.equal(outcome.status, 'committed');
  const targetStat = await fs.stat(target, { bigint: true });
  assert.equal(String(targetStat.mtimeNs), String(sourceStat.mtimeNs));
  assert.deepEqual(await fs.readFile(target), await fs.readFile(f.source));
  session.close();
});

test('Linux native files.copy rejects cancellation before work without creating a destination', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  const session = f.api.openSession();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => session.invoke('files.copy', f.request, { signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.outcome.status, 'unchanged');
    return true;
  });
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  session.close();
});

test('Linux native N-API cancellation during byte progress returns the accepted cancel result and drains close', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 64 * 1024 * 1024);
  const rawSession = require(bindingPath).openSession();
  let copyPromise, cancelResult, observedProgress = false;
  copyPromise = rawSession.invoke('files.copy', f.request, event => {
    if (!observedProgress && event.transferred > 0 && event.transferred < event.total) {
      observedProgress = true;
      cancelResult = copyPromise.cancel();
    }
  });
  await assert.rejects(copyPromise, error => {
    assert.equal(error.outcome.cancelled, true);
    assert.ok(['partial', 'unchanged'].includes(error.outcome.status));
    if (error.outcome.status === 'partial') assert.ok(error.outcome.ownedDestination?.ino);
    return true;
  });
  assert.equal(observedProgress, true);
  assert.equal(cancelResult, undefined);
  assert.equal(rawSession.close(), true);
  await rawSession.whenClosed();
});

test('Linux native worker close waits for active copy shutdown after a real progress callback', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 64 * 1024 * 1024);
  const rawSession = require(bindingPath).openSession();
  let copyPromise, closed = false;
  copyPromise = rawSession.invoke('files.copy', f.request, event => {
    if (!closed && event.transferred > 0 && event.transferred < event.total) {
      closed = true;
      rawSession.close();
    }
  });
  await assert.rejects(copyPromise, error => {
    assert.equal(error.code, 'SessionClosed');
    assert.equal(error.outcome.cancelled, true);
    return true;
  });
  assert.equal(closed, true);
  await rawSession.whenClosed();
});
