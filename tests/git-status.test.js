const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { repository, changedRepository } = require('./support/git-fixture.cjs');
const { createGitStatusEngine } = require('../git-status-engine');
const { loadNativeApi } = require('../native-api');

function createEngine(t, overrides = {}) {
  const nativeApi = loadNativeApi(), session = nativeApi.openSession();
  const invokeStatus = (request, options) => session.invoke('git.status', request, options);
  const engine = createGitStatusEngine({
    nativeApi, session, ...overrides,
    ...(overrides.status ? { status: (request, options) => overrides.status(request, options, invokeStatus) } : {})
  });
  t.after(() => { engine.close(); nativeApi.shutdown(); });
  return engine;
}

test('real repository statuses and recursive folders are read without invoking Git or writing the index', async t => {
  const { dir } = await changedRepository(t);
  const digest = async () => crypto.createHash('sha256').update(await fsp.readFile(path.join(dir, '.git/index'))).digest('hex');
  const before = await digest();
  const engine = createEngine(t);
  const result = await engine.inspect(dir);
  assert.equal(result.branch, 'main'); assert.equal(result.ok, true);
  assert.equal(result.statuses['clean.txt'], 'clean');
  assert.equal(result.statuses['modified.txt'], 'modified');
  assert.equal(result.statuses['deleted.txt'], 'deleted');
  assert.equal(result.statuses['added.txt'], 'added');
  assert.equal(result.statuses['untracked.txt'], 'untracked');
  assert.equal(result.statuses.nested, 'modified');
  assert.equal(result.statuses.ignored, undefined);
  assert.equal(await digest(), before);
  assert.equal((await fsp.readdir(path.join(dir, '.git'))).includes('index.lock'), false);
  const branches = await engine.branches(dir);
  assert.deepEqual(branches.names, ['feature/one', 'main', 'second']);
  assert.equal(branches.count, 3); assert.equal(branches.otherCount, 2);
});

test('nested directories use repository-relative status and outside directories stay neutral', async t => {
  const { dir } = await changedRepository(t), engine = createEngine(t);
  const result = await engine.inspect(path.join(dir, 'nested'));
  assert.equal(result.branch, 'main'); assert.equal(result.statuses['deep.txt'], 'modified');
  assert.equal(result.statuses['clean.txt'], undefined);
  assert.equal((await engine.inspect(path.dirname(dir))).repository, false);
});

test('unborn branch has no local refs and detached HEAD does not invent a branch', async t => {
  const { dir, fs, git } = await repository(t), engine = createEngine(t);
  await git.checkout({ fs, dir, ref: await git.resolveRef({ fs, dir, ref: 'HEAD' }) });
  const result = await engine.inspect(dir); assert.equal(result.detached, true); assert.equal(result.branch, null); assert.match(result.head, /^[a-f0-9]{7,40}$/);
  assert.equal((await engine.branches(dir)).otherCount, 3);
  const empty = path.join(dir, 'new-repo'); await fsp.mkdir(empty);
  await git.init({ fs, dir: empty, defaultBranch: 'future' });
  await fsp.writeFile(path.join(empty, 'new.txt'), 'new');
  const unborn = await engine.inspect(empty);
  assert.equal(unborn.branch, 'future'); assert.equal(unborn.statuses['new.txt'], 'untracked');
  assert.equal((await engine.branches(empty)).count, 0);
});

test('merge conflicts take precedence over ordinary modifications in parent folders', async t => {
  const { dir, fs, git, write, commit } = await repository(t);
  await git.checkout({ fs, dir, ref: 'feature/one' });
  await write('nested/deep.txt', 'feature version\n'); await git.add({ fs, dir, filepath: 'nested/deep.txt' }); await commit('Feature');
  await git.checkout({ fs, dir, ref: 'main' });
  await write('nested/deep.txt', 'main version\n'); await git.add({ fs, dir, filepath: 'nested/deep.txt' }); await commit('Main');
  await assert.rejects(git.merge({ fs, dir, ours: 'main', theirs: 'feature/one', abortOnConflict: false, author: { name: 'Fixture', email: 'fixture@example.invalid' } }));
  const result = await createEngine(t).inspect(dir);
  assert.equal(result.statuses['nested/deep.txt'], 'conflict'); assert.equal(result.statuses.nested, 'conflict');
});

test('unsupported index is an explicit unavailable result rather than clean status', async t => {
  const { dir } = await repository(t);
  const indexPath = path.join(dir, '.git/index'), bytes = await fsp.readFile(indexPath);
  bytes.writeUInt32BE(4, 4); crypto.createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  await fsp.writeFile(indexPath, bytes);
  const result = await createEngine(t).inspect(dir);
  assert.equal(result.ok, false); assert.equal(result.statuses['clean.txt'], undefined); assert.ok(result.error);
});

test('path exclusions prune subtrees and ignored overlays are explicitly enabled', async t => {
  const { dir } = await changedRepository(t), engine = createEngine(t);
  const result = await engine.inspect(dir, { excludePaths: [path.join(dir, 'nested')], showIgnored: true });
  assert.equal(result.statuses.nested, undefined); assert.equal(result.statuses['nested/deep.txt'], undefined);
  assert.equal(result.statuses.ignored, 'ignored');
  assert.equal((await engine.inspect(dir, { includePaths: [path.join(dir, 'nested')] })).repository, false);
  const included = await engine.inspect(path.join(dir, 'nested'), { includePaths: [path.join(dir, 'nested')] });
  assert.equal(included.statuses['deep.txt'], 'modified');
});

test('staged and unstaged changes retain their status and packed local refs count once', async t => {
  const { dir, fs, git, write } = await repository(t);
  await write('clean.txt', 'staged\n'); await git.add({ fs, dir, filepath: 'clean.txt' }); await write('clean.txt', 'changed again\n');
  const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  await fsp.writeFile(path.join(dir, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/heads/packed\n${oid} refs/heads/main\n${oid} refs/remotes/origin/another\n`);
  const engine = createEngine(t);
  assert.equal((await engine.inspect(dir)).statuses['clean.txt'], 'modified');
  assert.equal((await engine.branches(dir)).count, 4);
});

test('overlapping panel directories reuse one status calculation until invalidated', async t => {
  const { dir } = await changedRepository(t); let calculations = 0;
  const engine = createEngine(t, { status: (request, options, invoke) => { calculations++; return invoke(request, options); } });
  await engine.inspect(dir);
  assert.equal((await engine.inspect(path.join(dir, 'nested'))).statuses['deep.txt'], 'modified');
  assert.equal(calculations, 1);
  engine.invalidate(); await engine.inspect(path.join(dir, 'nested')); assert.equal(calculations, 2);
});

test('ignored files in a subdirectory remain visible after an ancestor cache hit', async t => {
  const { dir, write } = await repository(t); await write('nested/ignored.log', 'ignored');
  const engine = createEngine(t); await engine.inspect(dir, { showIgnored: true });
  assert.equal((await engine.inspect(path.join(dir, 'nested'), { showIgnored: true })).statuses['ignored.log'], 'ignored');
});

test('ignored entries in a scoped subdirectory retain their repository-relative filter path', async t => {
  const { dir, write } = await repository(t); await write('nested/ignored.log', 'ignored');
  const nativeApi = { openSession: () => ({ close() {} }) };
  const engine = createGitStatusEngine({
    nativeApi,
    info: async () => ({ repository: true, branch: 'main', head: 'abc1234' }),
    status: async () => ({
      repository: true, branch: 'main', head: 'abc1234', indexVersion: 3,
      entries: [{ path: 'nested/ignored.log', head: 0, workdir: 0, stage: 0, ignored: true }]
    })
  });
  t.after(() => engine.close());
  const nested = path.join(dir, 'nested');
  const result = await engine.inspect(nested, { showIgnored: true, includePaths: [nested] });
  assert.equal(result.statuses['ignored.log'], 'ignored');
});

test('sparse checkout is explicitly unavailable rather than reporting skipped files as deleted', async t => {
  const { dir, fs, git } = await repository(t);
  await git.setConfig({ fs, dir, path: 'core.sparseCheckout', value: true });
  const result = await createEngine(t).inspect(dir);
  assert.equal(result.ok, false); assert.match(result.error, /sparse/i); assert.deepEqual(result.statuses, {});
});

test('same-size changes immediately after index creation are not falsely clean', async t => {
  const { dir, write } = await repository(t), engine = createEngine(t);
  await engine.inspect(dir); await write('clean.txt', 'changed while away\n'); engine.invalidate();
  assert.equal((await engine.inspect(dir)).statuses['clean.txt'], 'modified');
});

test('explicitly disabled sparse checkout remains a supported normal repository', async t => {
  const { dir, fs, git } = await repository(t);
  for (const value of ['false', 'no', 'off', '0']) {
    await git.setConfig({ fs, dir, path: 'core.sparseCheckout', value });
    assert.equal((await createEngine(t).inspect(dir)).ok, true, value);
  }
});

test('invalidation during a running scan cannot repopulate the result cache with that scan', async t => {
  const { dir } = await repository(t); let calls = 0, engine;
  engine = createEngine(t, { status: async (request, options, invoke) => {
    calls++; const result = await invoke(request, options); if (calls === 1) engine.invalidate(); return result;
  } });
  await engine.inspect(dir); await engine.inspect(dir); assert.equal(calls, 2);
});

test('missing repository objects are errors rather than a non-repository result', async t => {
  const { dir, fs, git } = await repository(t);
  await git.writeRef({ fs, dir, ref: 'refs/heads/main', value: '0'.repeat(40), force: true });
  const result = await createEngine(t).inspect(dir);
  assert.equal(result.ok, false); assert.ok(result.error); assert.deepEqual(result.statuses, {});
});

test('parent outside repositories decorates immediate repository roots without claiming a branch', async t => {
  const os = require('node:os');
  const container = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-parent-'));
  t.after(() => fsp.rm(container, { recursive: true, force: true }));
  const fixture = await changedRepository(t);
  await fsp.rename(fixture.dir, path.join(container, 'changed'));
  const clean = await repository(t);
  await fsp.rename(clean.dir, path.join(container, 'clean'));
  await fsp.mkdir(path.join(container, 'ordinary'));
  const engine = createEngine(t);
  const result = await engine.inspect(container);
  assert.equal(result.repository, false);
  assert.equal(result.branch, undefined);
  assert.equal(result.statuses.changed, 'modified');
  assert.equal(result.statuses.clean, 'clean');
  assert.equal(result.statuses.ordinary, undefined);
  const excluded = await engine.inspect(container, { excludePaths: [path.join(container, 'changed')] });
  assert.equal(excluded.statuses.changed, undefined);
});

test('branch listing includes locally known remote branches without fetching', async t => {
  const { dir, fs, git } = await repository(t);
  await git.addRemote({ fs, dir, remote: 'origin', url: 'https://example.invalid/repo.git' });
  await git.writeRef({ fs, dir, ref: 'refs/remotes/origin/HEAD', value: 'refs/remotes/origin/remote-only', symbolic: true });
  const result = await createEngine(t).branches(dir);
  assert.deepEqual(result.remoteNames, ['origin/remote-only']);
  assert.equal(result.count, 3);
});

test('repository description reads HEAD without calculating file statuses', async t => {
  const { dir } = await repository(t);
  const engine = createEngine(t, { status: async () => { throw new Error('Status must stay deferred'); } });
  const result = await engine.describe(dir);
  assert.equal(result.branch, 'main'); assert.equal(result.repository, true); assert.deepEqual(result.statuses, {});
  assert.equal((await engine.describe(path.dirname(dir))).repository, false);
});

test('parent progress confirms only a child repository before its status calculation', async t => {
  const os = require('node:os'), container = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-child-progress-'));
  t.after(() => fsp.rm(container, { recursive: true, force: true }));
  const fixture = await repository(t), child = path.join(container, 'child');
  await fsp.rename(fixture.dir, child);
  await fsp.mkdir(path.join(container, 'ordinary'));
  const updates = []; let confirmedBeforeStatus = false;
  const engine = createEngine(t, { status: async (request, options, invoke) => {
    confirmedBeforeStatus = updates.some(update => update.ok && update.repository === false && update.loadingRepositories?.includes('child'));
    return invoke(request, options);
  } });
  const result = await engine.inspect(container, {}, update => updates.push(update));
  assert.equal(confirmedBeforeStatus, true);
  assert.ok(updates.every(update => !update.loadingRepositories?.includes('ordinary')));
  assert.equal(result.ok, true); assert.equal(result.statuses.child, 'clean');
  assert.ok(updates.some(update => update.statuses.child === 'clean' && !update.loadingRepositories?.length));
});

test('status entries stream in bounded batches from one matrix query', async t => {
  const { dir } = await repository(t); let queries = 0; const batches = [];
  const engine = createEngine(t, { status: async (request, options, invoke) => {
    queries++;
    const result = await invoke(request, options);
    return { ...result, entries: Array.from({ length: 150 }, (_, i) => ({ path: `file-${i}.txt`, head: 0, workdir: 2, stage: 0 })) };
  } });
  const result = await engine.inspect(dir, {}, update => batches.push(update));
  assert.equal(queries, 1);
  assert.ok(batches.length >= 3);
  assert.ok(batches.every(update => update.loading && Object.keys(update.statuses).length <= 64));
  assert.equal(Object.keys(Object.assign({}, ...batches.map(update => update.statuses))).length, 150);
  assert.equal(Object.keys(result.statuses).length, 150);
});
