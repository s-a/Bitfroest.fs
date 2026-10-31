const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createNativeApi } = require('../native-api');

const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

function git(directory, ...args) {
  return execFileSync('git', ['-c', `core.hooksPath=${path.join(directory, '.hooks')}`, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-global-config') }
  }).trim();
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-git-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.hooks'));
  await fs.writeFile(path.join(directory, 'clean.txt'), 'clean\n');
  await fs.writeFile(path.join(directory, 'changed[1].txt'), 'before\n');
  await fs.writeFile(path.join(directory, '.gitignore'), 'ignored/\n');
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', '--local', 'user.name', 'Fixture');
  git(directory, 'config', '--local', 'user.email', 'fixture@example.invalid');
  git(directory, 'add', '--', '.');
  git(directory, 'commit', '-m', 'Initial fixture');
  git(directory, 'branch', 'feature/one');
  git(directory, 'branch', 'second');
  git(directory, 'remote', 'add', 'origin', 'https://example.invalid/repository.git');
  const head = git(directory, 'rev-parse', 'HEAD');
  git(directory, 'update-ref', 'refs/remotes/origin/remote-only', head);
  git(directory, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/remote-only');
  await fs.writeFile(path.join(directory, 'changed[1].txt'), 'after!\n');
  await fs.writeFile(path.join(directory, 'untracked.txt'), 'new\n');
  await fs.mkdir(path.join(directory, 'ignored'));
  await fs.writeFile(path.join(directory, 'ignored', 'file.log'), 'hidden\n');
  return directory;
}

test('native Git status reports repository identity and entries without writing the index', async t => {
  const directory = await fixture(t);
  const indexPath = path.join(directory, '.git', 'index');
  const before = await fs.readFile(indexPath);
  const api = createNativeApi(require(binary));
  const session = api.openSession();
  try {
    assert.equal(api.capabilities['git.status'].status, 'supported');
    const result = await session.invoke('git.status', { directory, scope: '.', recursive: true, showIgnored: true });
    assert.equal(result.repository, true);
    assert.equal(result.branch, 'main', JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    const entries = new Map(result.entries.map(entry => [entry.path.replaceAll('\\', '/'), entry]));
    assert.equal(entries.get('clean.txt').flags, 0);
    assert.ok(entries.get('changed[1].txt').flags > 0);
    assert.deepEqual([entries.get('changed[1].txt').head, entries.get('changed[1].txt').workdir, entries.get('changed[1].txt').stage], [1, 2, 1]);
    assert.deepEqual([entries.get('untracked.txt').head, entries.get('untracked.txt').workdir, entries.get('untracked.txt').stage], [0, 2, 0]);
    assert.equal(entries.get('untracked.txt').flags, 1);
    assert.equal(entries.get('untracked.txt').ignored, false);
    assert.equal(entries.get('ignored').ignored, true);
    assert.ok([...entries].some(([name, entry]) => name.startsWith('ignored/') && entry.ignored));
    assert.deepEqual(await fs.readFile(indexPath), before);
  } finally { api.shutdown(); }
});

test('native Git status rejects malformed repository-relative include and exclude scopes', async t => {
  const directory = await fixture(t);
  const bindingSession = require(binary).openSession();
  try {
    for (const request of [
      { includeScopes: 'nested' },
      { includeScopes: [1] },
      { includeScopes: ['../outside'] },
      { excludeScopes: ['/outside'] },
      ...(process.platform === 'win32' ? [{ excludeScopes: ['C:/outside'] }] : []),
      { excludeScopes: ['nested\\outside'] },
      { includeScopes: ['nested\0outside'] }
    ]) {
      let returned;
      let error;
      try { returned = bindingSession.invoke('git.status', { directory, scope: '.', recursive: true, ...request }); }
      catch (caught) { error = caught; }
      if (returned?.catch) returned.catch(() => {});
      assert.equal(error?.code, 'InvalidRequest');
    }
  } finally { bindingSession.close(); }
});

test('native Git status cancellation rejects detached and foreign receivers safely', async t => {
  const directory = await fixture(t);
  const bindingSession = require(binary).openSession();
  try {
    const pending = bindingSession.invoke('git.status', { directory, scope: '.', recursive: true });
    const cancel = pending.cancel;
    assert.equal(typeof cancel, 'function');
    assert.throws(() => cancel(), error => error.code === 'InvalidRequest');
    assert.throws(() => cancel.call(bindingSession), error => error.code === 'InvalidRequest');
    const result = await pending;
    assert.equal(result.repository, true);
  } finally { bindingSession.close(); }
});

test('native Git status prunes excluded and out-of-scope trees before diff callbacks', async t => {
  const directory = await fixture(t);
  for (const name of ['nested/keep.txt', 'nested/deleted.txt', 'nested/branch/deep.txt', 'nested/excluded/secret.txt', 'nested/RemovedDir/tracked.txt', 'nested/RemovedExcluded/tracked.txt', 'outside.txt']) {
    const filename = path.join(directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `baseline ${name}\n`);
  }
  git(directory, 'add', '--', 'nested', 'outside.txt');
  git(directory, 'commit', '-m', 'Add scoped files');
  git(directory, 'rm', '-f', '--', 'nested/deleted.txt');
  git(directory, 'rm', '-rf', '--', 'nested/RemovedDir');
  git(directory, 'rm', '-rf', '--', 'nested/RemovedExcluded');
  for (const name of ['nested/keep.txt', 'nested/branch/deep.txt', 'nested/excluded/secret.txt', 'outside.txt']) {
    await fs.writeFile(path.join(directory, name), `changed ${name}\n`);
  }
  const session = require(binary).openSession();
  const visited = [];
  try {
    const scope = value => process.platform === 'win32' ? value.toUpperCase() : value;
    const result = await session.invoke('git.status', {
      directory, scope: '.', recursive: true,
      includeScopes: [scope('nested')], excludeScopes: ['nested/excluded', 'nested/RemovedDir', 'nested/RemovedExcluded'].map(scope)
    }, event => visited.push(event.path.replaceAll('\\', '/')));
    const paths = result.entries.map(entry => entry.path.replaceAll('\\', '/'));
    assert.ok(paths.includes('nested/keep.txt'));
    assert.ok(paths.includes('nested/branch/deep.txt'));
    const deleted = result.entries.find(entry => entry.path.replaceAll('\\', '/') === 'nested/deleted.txt');
    assert.deepEqual([deleted.head, deleted.workdir, deleted.stage], [1, 1, 0]);
    assert.ok(!paths.includes('nested/RemovedDir/tracked.txt'));
    assert.ok(!paths.includes('nested/RemovedExcluded/tracked.txt'));
    assert.ok(!paths.includes('nested/excluded/secret.txt'));
    assert.ok(!paths.includes('outside.txt'));
    assert.ok(!visited.some(name => name.startsWith('nested/excluded/')));
    assert.ok(!visited.includes('outside.txt'));
  } finally { session.close(); }
});

test('recursive false prunes nested files before native diff callbacks', async t => {
  const directory = await fixture(t);
  const nested = path.join(directory, 'nested', 'deep.txt');
  await fs.mkdir(path.dirname(nested), { recursive: true });
  await fs.writeFile(nested, 'baseline\n');
  git(directory, 'add', '--', 'nested/deep.txt');
  git(directory, 'commit', '-m', 'Add nested file');
  await fs.writeFile(nested, 'changed\n');
  const session = require(binary).openSession(), visited = [];
  try {
    const result = await session.invoke('git.status', { directory, scope: '.', recursive: false }, event => visited.push(event.path.replaceAll('\\', '/')));
    assert.ok(!result.entries.some(entry => entry.path.replaceAll('\\', '/') === 'nested/deep.txt'));
    assert.ok(!visited.some(name => name.startsWith('nested/')));
  } finally { session.close(); }
});

test('native Git status reports configuration parse errors instead of defaulting', async t => {
  const directory = await fixture(t);
  git(directory, 'config', '--local', 'core.sparseCheckout', 'not-a-boolean');
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    await assert.rejects(session.invoke('git.status', { directory, scope: '.', recursive: true }), error => error.code === 'GitFailure');
  } finally { api.shutdown(); }
});

test('native Git status corrects same-size changes with an unchanged write timestamp', async t => {
  const directory = await fixture(t);
  git(directory, 'config', '--local', 'core.trustctime', 'false');
  const filename = path.join(directory, 'clean.txt');
  const original = await fs.stat(filename);
  await fs.writeFile(filename, 'dirty\n');
  await fs.utimes(filename, original.atime, original.mtime);
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    const result = await session.invoke('git.status', { directory, scope: '.', recursive: true });
    const entry = result.entries.find(value => value.path.replaceAll('\\', '/') === 'clean.txt');
    assert.deepEqual([entry.head, entry.workdir, entry.stage], [1, 2, 1]);
  } finally { api.shutdown(); }
});

test('native Git status applies core.autocrlf when checking a clean entry', async t => {
  const directory = await fixture(t);
  git(directory, 'config', '--local', 'core.autocrlf', 'true');
  const filename = path.join(directory, 'clean.txt');
  const original = await fs.stat(filename);
  await fs.writeFile(filename, 'clean\r\n');
  await fs.utimes(filename, original.atime, original.mtime);
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    const result = await session.invoke('git.status', { directory, scope: '.', recursive: true });
    const entry = result.entries.find(value => value.path.replaceAll('\\', '/') === 'clean.txt');
    assert.deepEqual([entry.head, entry.workdir, entry.stage], [1, 1, 1]);
  } finally { api.shutdown(); }
});

test('native Git status marks unmerged index paths as conflicts', async t => {
  const directory = await fixture(t);
  git(directory, 'checkout', '-b', 'conflict-side');
  await fs.writeFile(path.join(directory, 'changed[1].txt'), 'side version\n');
  git(directory, 'add', '--', 'changed[1].txt');
  git(directory, 'commit', '-m', 'Change on side');
  git(directory, 'checkout', 'main');
  await fs.writeFile(path.join(directory, 'changed[1].txt'), 'main version\n');
  git(directory, 'add', '--', 'changed[1].txt');
  git(directory, 'commit', '-m', 'Change on main');
  assert.throws(() => git(directory, 'merge', '--no-edit', 'conflict-side'), error => error.status === 1);
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    const result = await session.invoke('git.status', { directory, scope: '.', recursive: true });
    const conflict = result.entries.find(entry => entry.path.replaceAll('\\', '/') === 'changed[1].txt');
    assert.equal(conflict.conflicted, true);
  } finally { api.shutdown(); }
});

test('native Git status clears progress callback exceptions and rejects cleanly', async t => {
  const directory = await fixture(t);
  for (let index = 0; index < 200; index++) await fs.writeFile(path.join(directory, `progress-${index}.txt`), 'new\n');
  const session = require(binary).openSession();
  try {
    await assert.rejects(session.invoke('git.status', { directory, scope: '.', recursive: true }, () => { throw new Error('callback failed'); }), error => error.code === 'ProgressCallbackFailed');
  } finally { session.close(); }
});

test('native Git metadata lists local and configured remote refs without fetching', async t => {
  const directory = await fixture(t);
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    const result = await session.invoke('git.info', { directory });
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.names, ['feature/one', 'main', 'second']);
    assert.deepEqual(result.remoteNames, ['origin/remote-only']);
    assert.equal(result.count, 3);
    assert.equal(result.otherCount, 2);
    assert.deepEqual(result.entries, []);
  } finally { api.shutdown(); }
});

test('native Git status completions carry unique session-bound request identities', async t => {
  const directory = await fixture(t);
  for (let index = 0; index < 140; index++) await fs.writeFile(path.join(directory, `file-${index}.txt`), 'new\n');
  const api = createNativeApi(require(binary));
  const session = api.openSession();
  try {
    const request = { directory, scope: '.', recursive: true };
    const [first, second] = await Promise.all([session.invoke('git.status', request), session.invoke('git.status', request)]);
    assert.equal(first.repository, true);
    assert.equal(second.repository, true);
    assert.equal(first.generation, session.generation);
    assert.equal(second.generation, session.generation);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(first.entries.length, 144);
  } finally { api.shutdown(); }
});

test('Git status cancellation rejects the request before returning a partial result', async t => {
  const directory = await fixture(t);
  for (let index = 0; index < 3000; index++) await fs.writeFile(path.join(directory, `cancel-${index}.txt`), 'new\n');
  const api = createNativeApi(require(binary));
  const session = api.openSession(), controller = new AbortController();
  try {
    const pending = session.invoke('git.status', { directory, scope: '.', recursive: true }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(pending, error => error.code === 'Cancelled' && error.operation === 'git.status');
  } finally { api.shutdown(); }
});

test('worker termination interrupts a running native Git diff', async t => {
  const directory = await fixture(t);
  for (let index = 0; index < 12000; index++) await fs.writeFile(path.join(directory, `worker-${index}.txt`), 'new\n');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const binding = require(workerData.binding);
    const { createNativeApi } = require(workerData.api);
    const native = createNativeApi(binding), session = native.openSession();
    session.invoke('git.status', { directory: workerData.directory, scope: '.', recursive: true }, {
      onProgress: event => parentPort.postMessage({ type: 'scanning', path: event.path })
    })
      .then(() => parentPort.postMessage({ type: 'completed' }), error => parentPort.postMessage({ type: 'rejected', code: error.code, message: error.message }));
  `, { eval: true, workerData: { binding: binary, api: path.join(__dirname, '../native-api.js'), directory } });
  t.after(() => worker.terminate());
  const startupTimer = setTimeout(() => worker.terminate(), 10000);
  let scanning;
  try {
    scanning = await new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (message?.type === 'scanning') resolve(message);
        else if (message?.type === 'rejected') reject(new Error(`Status request failed before scan progress: ${message.code}: ${message.message}`));
        else if (message?.type === 'completed') reject(new Error('Status request completed before scan progress was observed.'));
      });
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Worker exited before scan progress was observed (${code}).`)));
    });
  } finally { clearTimeout(startupTimer); }
  assert.ok(scanning.path);
  await new Promise(resolve => setTimeout(resolve, 10));
  const started = performance.now();
  await worker.terminate();
  const elapsed = performance.now() - started;
  t.diagnostic(`Native diff termination after a scan progress event: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 2500);
});
