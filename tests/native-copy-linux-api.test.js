const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createNativeApi } = require('../native-api');

const bindingPath = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

function identityFrom(stat) {
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
}

test('Linux native copy delivers queued progress before its promise completes', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 1);
  await fs.unlink(f.source);
  await fs.symlink('dangling-target', f.source);
  const stat = await fs.lstat(f.source, { bigint: true });
  const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
  const session = require(bindingPath).openSession();
  t.after(async () => { session.close(); await session.whenClosed(); });
  for (let index = 0; index < 32; index++) {
    const events = [];
    await session.invoke('files.copy', { ...f.request, expected, target: `${f.target}-${index}` }, event => events.push(event));
    assert.equal(events.length, 1, 'The actual final callback must be delivered before completion.');
    assert.equal(events[0].transferred, Number(stat.size));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.length, 1, 'No progress callback may arrive after completion.');
  }
});

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

test('Linux native files.copy preserves sparse holes and reports logical and written-byte measurements', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 0);
  const logicalSize = 16n * 1024n * 1024n;
  const handle = await fs.open(f.source, 'r+');
  await handle.truncate(Number(logicalSize));
  await handle.write(Buffer.from('first-data'), 0, 10, 0);
  await handle.write(Buffer.from('last-data'), 0, 9, Number(15n * 1024n * 1024n));
  await handle.close();
  const sourceStat = await fs.stat(f.source, { bigint: true });
  assert.ok(sourceStat.blocks * 512n < sourceStat.size, 'the fixture filesystem must expose the source hole');
  f.request.expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])]));
  const session = f.api.openSession();
  const progress = [];
  const outcome = await session.invoke('files.copy', f.request, { onProgress: event => progress.push(event) });
  assert.equal(outcome.status, 'committed');
  const targetStat = await fs.stat(f.target, { bigint: true });
  assert.equal(targetStat.size, logicalSize);
  assert.ok(targetStat.blocks * 512n < targetStat.size, 'the destination must retain sparse storage');
  const target = await fs.open(f.target, 'r');
  const first = Buffer.alloc(10), last = Buffer.alloc(9), gap = Buffer.alloc(1);
  await target.read(first, 0, first.length, 0);
  await target.read(gap, 0, gap.length, Number(8n * 1024n * 1024n));
  await target.read(last, 0, last.length, Number(15n * 1024n * 1024n));
  await target.close();
  assert.equal(first.toString(), 'first-data');
  assert.equal(gap[0], 0);
  assert.equal(last.toString(), 'last-data');
  assert.ok(progress.length > 0);
  for (const event of progress) {
    assert.equal(event.measurementBasis, 'logical');
    assert.equal(event.logicalProcessed, event.transferred);
    assert.equal(event.total, Number(logicalSize));
    assert.ok(Number.isSafeInteger(event.dataBytesWritten));
    assert.ok(event.dataBytesWritten <= event.logicalProcessed);
  }
  assert.equal(progress.at(-1).transferred, Number(logicalSize));
  assert.ok(progress.at(-1).dataBytesWritten < Number(logicalSize));
  session.close();
});

test('Linux native files.copy copies a symlink to an external file as a link without changing its target', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-copy-linux-external-target-'));
  t.after(() => fs.rm(externalRoot, { recursive: true, force: true }));
  const externalTarget = path.join(externalRoot, 'outside.bin');
  await fs.writeFile(externalTarget, 'external-target-unchanged');
  await fs.unlink(f.source);
  await fs.symlink(externalTarget, f.source);
  const sourceStat = await fs.lstat(f.source, { bigint: true });
  f.request.expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])]));
  const session = f.api.openSession();
  const outcome = await session.invoke('files.copy', f.request);
  assert.equal(outcome.status, 'committed');
  const targetStat = await fs.lstat(f.target, { bigint: true });
  assert.equal(targetStat.isSymbolicLink(), true);
  assert.equal(await fs.readlink(f.target), externalTarget);
  assert.equal(await fs.readFile(externalTarget, 'utf8'), 'external-target-unchanged');
  assert.equal(String(targetStat.uid), String(sourceStat.uid));
  assert.equal(String(targetStat.gid), String(sourceStat.gid));
  assert.equal(String(targetStat.atimeNs), String(sourceStat.atimeNs));
  assert.equal(String(targetStat.mtimeNs), String(sourceStat.mtimeNs));
  session.close();
});

test('Linux native files.copy rejects source symlink exchange as unknown without taking ownership of the new path', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  await fs.unlink(f.source);
  await fs.symlink('original-link-text', f.source);
  const sourceStat = await fs.lstat(f.source, { bigint: true });
  f.request.expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])]));
  const parked = path.join(f.root, 'source-original');
  const rawSession = require(bindingPath).openSession();
  let exchanged = false;
  const pending = rawSession.invoke('files.copy', f.request, () => {
    if (exchanged) return;
    fsSync.renameSync(f.source, parked);
    fsSync.symlinkSync('foreign-link-text', f.source);
    exchanged = true;
  });
  let outcome, operationError;
  try { outcome = await pending; } catch (error) { operationError = error; outcome = error.outcome; }
  assert.equal(exchanged, true);
  assert.ok(['committed', 'unknown'].includes(outcome.status));
  if (outcome.status === 'unknown') {
    assert.equal(operationError.code, 'DestinationOwnershipUnknown');
    assert.equal(outcome.ownedDestination, undefined);
  } else {
    assert.ok(outcome.ownedDestination?.ino);
    const destinationStat = await fs.lstat(f.target, { bigint: true });
    assert.equal(String(destinationStat.ino), outcome.ownedDestination.ino);
    assert.equal(String(destinationStat.dev), outcome.ownedDestination.dev);
  }
  assert.equal(await fs.readlink(f.target), 'original-link-text');
  assert.equal(await fs.readlink(parked), 'original-link-text');
  assert.equal(await fs.readlink(f.source), 'foreign-link-text');
  rawSession.close();
  await rawSession.whenClosed();
});

test('Linux native files.copy handles pre-publication and post-publication symlink cancellation separately', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 4096);
  await fs.unlink(f.source);
  await fs.symlink('cancelled-link-text', f.source);
  const sourceStat = await fs.lstat(f.source, { bigint: true });
  f.request.expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])]));
  const controller = new AbortController();
  controller.abort();
  const session = f.api.openSession();
  assert.throws(() => session.invoke('files.copy', f.request, { signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.outcome.status, 'unchanged');
    return true;
  });
  await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' });
  session.close();

  const postTarget = path.join(f.root, '.stage', 'post-cancel-link');
  const rawSession = require(bindingPath).openSession();
  let pending;
  pending = rawSession.invoke('files.copy', { ...f.request, target: postTarget }, () => pending.cancel());
  const outcome = await pending;
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.cancelled, false);
  assert.equal(await fs.readlink(postTarget), 'cancelled-link-text');
  rawSession.close();
  await rawSession.whenClosed();
});

test('Linux native files.copy reports a distinct partial outcome when an unprivileged host cannot preserve source ownership', {
  skip: process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0
}, async t => {
  const f = await fixture(t, 4096);
  await fs.chmod(f.root, 0o777);
  await fs.chmod(path.dirname(f.target), 0o777);
  await fs.chown(f.source, 12345, 12345);
  await fs.chmod(f.source, 0o644);
  const sourceStat = await fs.stat(f.source, { bigint: true });
  f.request.expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])]));
  const childSource = [
    'process.setgid(65534);',
    'process.setuid(65534);',
    'const binding = require(process.env.NATIVE_BINDING_TEST_PATH);',
    'const request = JSON.parse(process.env.NATIVE_COPY_REQUEST);',
    'const session = binding.openSession();',
    '(async () => {',
    '  let result;',
    '  try { result = await session.invoke("files.copy", request); }',
    '  catch (error) { result = { code: error.code, outcome: error.outcome, ownedDestination: error.ownedDestination }; }',
    '  session.close(); await session.whenClosed(); process.stdout.write(JSON.stringify(result));',
    '})().catch(error => { console.error(error); process.exitCode = 1; });'
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', childSource], {
    cwd: f.root,
    env: { ...process.env, NATIVE_BINDING_TEST_PATH: bindingPath, NATIVE_COPY_REQUEST: JSON.stringify(f.request) },
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL'
  });
  assert.equal(child.error, undefined, `unprivileged native copy child did not settle: ${child.error?.code || child.error}`);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.code, 'MetadataFailure');
  assert.equal(result.outcome.status, 'partial');
  assert.ok(result.outcome.ownedDestination?.ino);
  assert.ok(result.ownedDestination?.ino);
  const targetStat = await fs.stat(f.target, { bigint: true });
  assert.equal(String(targetStat.uid), '65534');
  assert.equal(String(sourceStat.uid), '12345');
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.source));
});

test('Linux native files.copy metadataOnly preserves existing directory identity, children, mode and times', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 0);
  const sourceDirectory = path.join(f.root, 'source-directory');
  const targetDirectory = path.join(f.root, '.stage', 'existing-directory');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(targetDirectory);
  await fs.writeFile(path.join(sourceDirectory, 'source-child'), 'source-directory-child');
  await fs.writeFile(path.join(targetDirectory, 'target-child'), 'target-directory-child');
  await fs.chmod(sourceDirectory, 0o751);
  await fs.chmod(targetDirectory, 0o700);
  await fs.utimes(sourceDirectory, new Date('2001-02-03T04:05:06.123Z'), new Date('2001-02-03T04:05:07.456Z'));
  const [sourceStat, targetBefore] = await Promise.all([
    fs.stat(sourceDirectory, { bigint: true }), fs.stat(targetDirectory, { bigint: true })
  ]);
  const request = {
    roots: [f.root], source: sourceDirectory, target: targetDirectory, metadataOnly: true,
    expected: identityFrom(sourceStat), expectedTarget: identityFrom(targetBefore)
  };
  const rawSession = require(bindingPath).openSession();
  const outcome = await rawSession.invoke('files.copy', request);
  assert.equal(outcome.status, 'committed');
  assert.ok(outcome.ownedDestination?.ino);
  const targetAfter = await fs.stat(targetDirectory, { bigint: true });
  assert.equal(String(targetAfter.dev), String(targetBefore.dev));
  assert.equal(String(targetAfter.ino), String(targetBefore.ino));
  assert.equal(String(targetAfter.ino), outcome.ownedDestination.ino);
  assert.equal(String(targetAfter.uid), String(sourceStat.uid));
  assert.equal(String(targetAfter.gid), String(sourceStat.gid));
  assert.equal(targetAfter.mode & 0o7777n, sourceStat.mode & 0o7777n);
  assert.equal(String(targetAfter.atimeNs), String(sourceStat.atimeNs));
  assert.equal(String(targetAfter.mtimeNs), String(sourceStat.mtimeNs));
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'source-child'), 'utf8'), 'source-directory-child');
  assert.equal(await fs.readFile(path.join(targetDirectory, 'target-child'), 'utf8'), 'target-directory-child');
  rawSession.close();
  await rawSession.whenClosed();
});

test('Linux native files.copy metadataOnly requires the full expected target identity synchronously', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 0);
  const sourceDirectory = path.join(f.root, 'source-directory');
  const targetDirectory = path.join(f.root, '.stage', 'existing-directory');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(targetDirectory);
  await fs.chmod(targetDirectory, 0o700);
  const sourceStat = await fs.stat(sourceDirectory, { bigint: true });
  const rawSession = require(bindingPath).openSession();
  assert.throws(() => rawSession.invoke('files.copy', {
    roots: [f.root], source: sourceDirectory, target: targetDirectory, metadataOnly: true, expected: identityFrom(sourceStat)
  }), error => error.code === 'InvalidRequest');
  assert.equal((await fs.stat(targetDirectory)).mode & 0o7777, 0o700);
  rawSession.close();
  await rawSession.whenClosed();
});

test('Linux native files.copy metadataOnly rejects a stale target identity before changing target metadata', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 0);
  const sourceDirectory = path.join(f.root, 'source-directory');
  const targetDirectory = path.join(f.root, '.stage', 'existing-directory');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(targetDirectory);
  await fs.chmod(sourceDirectory, 0o751);
  await fs.chmod(targetDirectory, 0o700);
  const [sourceStat, staleTarget] = await Promise.all([
    fs.stat(sourceDirectory, { bigint: true }), fs.stat(targetDirectory, { bigint: true })
  ]);
  await fs.chmod(targetDirectory, 0o711);
  await fs.utimes(targetDirectory, new Date('1999-01-02T03:04:05.000Z'), new Date('1999-01-02T03:04:06.000Z'));
  const targetBeforeCopy = await fs.stat(targetDirectory, { bigint: true });
  assert.notDeepEqual(identityFrom(staleTarget), identityFrom(targetBeforeCopy));
  const rawSession = require(bindingPath).openSession();
  await assert.rejects(rawSession.invoke('files.copy', {
    roots: [f.root], source: sourceDirectory, target: targetDirectory, metadataOnly: true,
    expected: identityFrom(sourceStat), expectedTarget: identityFrom(staleTarget)
  }), error => {
    assert.equal(error.code, 'TargetIdentityChanged');
    assert.equal(error.outcome.status, 'unchanged');
    return true;
  });
  const targetAfter = await fs.stat(targetDirectory, { bigint: true });
  assert.equal(targetAfter.ino, targetBeforeCopy.ino);
  assert.equal(targetAfter.mode, targetBeforeCopy.mode);
  assert.equal(targetAfter.mtimeNs, targetBeforeCopy.mtimeNs);
  rawSession.close();
  await rawSession.whenClosed();
});

test('Linux native files.copy metadataOnly rejects source and target parent symlinks', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 0);
  const sourceDirectory = path.join(f.root, 'source-directory');
  const targetDirectory = path.join(f.root, '.stage', 'existing-directory');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(targetDirectory);
  const sourceStat = await fs.stat(sourceDirectory, { bigint: true });
  const targetStat = await fs.stat(targetDirectory, { bigint: true });
  const sourceParentLink = path.join(f.root, 'source-parent-link');
  const targetParentLink = path.join(f.root, 'target-parent-link');
  await fs.symlink(f.root, sourceParentLink, 'dir');
  await fs.symlink(path.dirname(targetDirectory), targetParentLink, 'dir');
  const rawSession = require(bindingPath).openSession();
  const common = { roots: [f.root], metadataOnly: true, expected: identityFrom(sourceStat), expectedTarget: identityFrom(targetStat) };
  await assert.rejects(rawSession.invoke('files.copy', {
    ...common, source: path.join(sourceParentLink, path.basename(sourceDirectory)), target: targetDirectory
  }), error => error.outcome.status === 'unchanged');
  await assert.rejects(rawSession.invoke('files.copy', {
    ...common, source: sourceDirectory, target: path.join(targetParentLink, path.basename(targetDirectory))
  }), error => error.outcome.status === 'unchanged');
  const targetAfter = await fs.stat(targetDirectory, { bigint: true });
  assert.equal(targetAfter.mode, targetStat.mode);
  assert.equal(targetAfter.mtimeNs, targetStat.mtimeNs);
  rawSession.close();
  await rawSession.whenClosed();
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
