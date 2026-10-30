const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { repository, changedRepository } = require('./support/git-fixture.cjs');
const { createGitStatusEngine } = require('../git-status-engine');

test('real repository statuses and recursive folders are read without invoking Git or writing the index', async t => {
  const { dir } = await changedRepository(t);
  const digest = async () => crypto.createHash('sha256').update(await fsp.readFile(path.join(dir, '.git/index'))).digest('hex');
  const before = await digest();
  const engine = createGitStatusEngine();
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
  const { dir } = await changedRepository(t), engine = createGitStatusEngine();
  const result = await engine.inspect(path.join(dir, 'nested'));
  assert.equal(result.branch, 'main'); assert.equal(result.statuses['deep.txt'], 'modified');
  assert.equal(result.statuses['clean.txt'], undefined);
  assert.equal((await engine.inspect(path.dirname(dir))).repository, false);
});

test('unborn branch has no local refs and detached HEAD does not invent a branch', async t => {
  const { dir, fs, git } = await repository(t), engine = createGitStatusEngine();
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
  const result = await createGitStatusEngine().inspect(dir);
  assert.equal(result.statuses['nested/deep.txt'], 'conflict'); assert.equal(result.statuses.nested, 'conflict');
});

test('unsupported index is an explicit unavailable result rather than clean status', async t => {
  const { dir } = await repository(t);
  const indexPath = path.join(dir, '.git/index'), bytes = await fsp.readFile(indexPath);
  bytes.writeUInt32BE(4, 4); crypto.createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  await fsp.writeFile(indexPath, bytes);
  const result = await createGitStatusEngine().inspect(dir);
  assert.equal(result.ok, false); assert.equal(result.statuses['clean.txt'], undefined); assert.ok(result.error);
});

test('path exclusions prune subtrees and ignored overlays are explicitly enabled', async t => {
  const { dir } = await changedRepository(t), engine = createGitStatusEngine();
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
  const engine = createGitStatusEngine();
  assert.equal((await engine.inspect(dir)).statuses['clean.txt'], 'modified');
  assert.equal((await engine.branches(dir)).count, 4);
});

test('overlapping panel directories reuse one status calculation until invalidated', async t => {
  const { dir, git } = await changedRepository(t); let calculations = 0;
  const engine = createGitStatusEngine({ git: { ...git, statusMatrix: async options => { calculations++; return git.statusMatrix(options); } } });
  await engine.inspect(dir);
  assert.equal((await engine.inspect(path.join(dir, 'nested'))).statuses['deep.txt'], 'modified');
  assert.equal(calculations, 1);
  engine.invalidate(); await engine.inspect(path.join(dir, 'nested')); assert.equal(calculations, 2);
});

test('ignored files in a subdirectory remain visible after an ancestor cache hit', async t => {
  const { dir, write } = await repository(t); await write('nested/ignored.log', 'ignored');
  const engine = createGitStatusEngine(); await engine.inspect(dir, { showIgnored: true });
  assert.equal((await engine.inspect(path.join(dir, 'nested'), { showIgnored: true })).statuses['ignored.log'], 'ignored');
});

test('sparse checkout is explicitly unavailable rather than reporting skipped files as deleted', async t => {
  const { dir, fs, git } = await repository(t);
  await git.setConfig({ fs, dir, path: 'core.sparseCheckout', value: true });
  const result = await createGitStatusEngine().inspect(dir);
  assert.equal(result.ok, false); assert.match(result.error, /sparse/i); assert.deepEqual(result.statuses, {});
});

test('same-size changes immediately after index creation are not falsely clean', async t => {
  const { dir, write } = await repository(t), engine = createGitStatusEngine();
  await engine.inspect(dir); await write('clean.txt', 'changed while away\n'); engine.invalidate();
  assert.equal((await engine.inspect(dir)).statuses['clean.txt'], 'modified');
});

test('explicitly disabled sparse checkout remains a supported normal repository', async t => {
  const { dir, fs, git } = await repository(t);
  for (const value of ['false', 'no', 'off', '0']) {
    await git.setConfig({ fs, dir, path: 'core.sparseCheckout', value });
    assert.equal((await createGitStatusEngine().inspect(dir)).ok, true, value);
  }
});

test('invalidation during a running scan cannot repopulate the result cache with that scan', async t => {
  const { dir, git } = await repository(t); let calls = 0, engine;
  engine = createGitStatusEngine({ git: { ...git, statusMatrix: async options => {
    calls++; const result = await git.statusMatrix(options); if (calls === 1) engine.invalidate(); return result;
  } } });
  await engine.inspect(dir); await engine.inspect(dir); assert.equal(calls, 2);
});

test('missing repository objects are errors rather than a non-repository result', async t => {
  const { dir, fs, git } = await repository(t);
  await git.writeRef({ fs, dir, ref: 'refs/heads/main', value: '0'.repeat(40), force: true });
  const result = await createGitStatusEngine().inspect(dir);
  assert.equal(result.ok, false); assert.ok(result.error); assert.deepEqual(result.statuses, {});
});
