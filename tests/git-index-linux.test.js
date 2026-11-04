const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createNativeApi } = require('../native-api');
const { createGitIndexProvider } = require('../git-index');
const { createGitFileActions } = require('../git-file-actions');

const binary = process.env.NATIVE_BINDING_TEST_PATH || path.resolve(__dirname, '../native/binding.node');

function git(root, ...args) {
  return execFileSync('git', ['-c', `core.hooksPath=${path.join(root, '.hooks')}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config') }
  }).trim();
}

async function descriptorCount() {
  return (await fs.readdir('/proc/self/fd')).length;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-index-linux-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(root, 'file.txt'), 'original\n');
  await fs.writeFile(path.join(root, 'other.txt'), 'other\n');
  git(root, 'add', '--', '.');
  git(root, 'commit', '-m', 'Initial fixture');
  const api = createNativeApi(require(binary));
  const session = api.openSession();
  t.after(() => api.shutdown());

  async function prepare(name = 'file.txt') {
    const stat = await fs.stat(path.join(root, name), { bigint: true });
    let expectedHead;
    try { expectedHead = git(root, 'rev-parse', '--verify', '--quiet', 'HEAD'); }
    catch (error) { if (error.status !== 1) throw error; expectedHead = ''; }
    return {
      repositoryRoot: root,
      target: path.join(root, name),
      expectedHead,
      expectedReference: git(root, 'symbolic-ref', 'HEAD'),
      expectedIndex: crypto.createHash('sha256').update(await fs.readFile(path.join(root, '.git', 'index'))).digest('hex'),
      expectedDev: stat.dev.toString(),
      expectedIno: stat.ino.toString()
    };
  }

  return { root, session, prepare };
}

test('Linux native untrack removes only the selected index entry and preserves local file bytes', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  await fs.writeFile(path.join(app.root, 'file.txt'), 'local modifications\n');
  await fs.writeFile(path.join(app.root, 'other.txt'), 'staged other\n');
  git(app.root, 'add', '--', 'other.txt');
  const other = git(app.root, 'ls-files', '--stage', '--', 'other.txt');
  const result = await app.session.invoke('git.untrack', await app.prepare());
  assert.equal(result.status, 'committed');
  assert.equal(result.removed, true);
  assert.equal(await fs.readFile(path.join(app.root, 'file.txt'), 'utf8'), 'local modifications\n');
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), '');
  assert.equal(git(app.root, 'ls-files', '--stage', '--', 'other.txt'), other);
  await assert.rejects(fs.stat(path.join(app.root, '.git', 'index.lock')), { code: 'ENOENT' });
});

test('Linux keep-local and ignore actions both route through the native index provider', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  const provider = createGitIndexProvider({ nativeApi: app.api });
  const actions = createGitFileActions({ index: provider });
  t.after(() => actions.dispose());
  const local = path.join(app.root, 'file.txt');
  const original = await fs.readFile(local);
  await actions.execute(await actions.prepare({ repositoryRoot: app.root, target: local }));
  assert.deepEqual(await fs.readFile(local), original);
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), '');

  const ignored = path.join(app.root, 'other.txt');
  const ignoredBytes = await fs.readFile(ignored);
  const prepared = await actions.prepare({ repositoryRoot: app.root, target: ignored, ignore: true });
  assert.equal(typeof prepared.index.expectedDev, 'string');
  await actions.execute(prepared);
  assert.deepEqual(await fs.readFile(ignored), ignoredBytes);
  assert.equal(git(app.root, 'ls-files', '--', 'other.txt'), '');
  assert.match(await fs.readFile(path.join(app.root, '.gitignore'), 'utf8'), /\/other\.txt/);
});

test('Linux native untrack rejects stale file and index identities without changing the index', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  const staleFile = await app.prepare();
  await fs.rename(path.join(app.root, 'file.txt'), path.join(app.root, 'moved.txt'));
  await fs.writeFile(path.join(app.root, 'file.txt'), 'replacement\n');
  const before = await fs.readFile(path.join(app.root, '.git', 'index'));
  await assert.rejects(app.session.invoke('git.untrack', staleFile), { code: 'StaleFile' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), before);

  const staleIndex = await app.prepare('moved.txt');
  await fs.writeFile(path.join(app.root, 'other.txt'), 'staged change\n');
  git(app.root, 'add', '--', 'other.txt');
  const changed = await fs.readFile(path.join(app.root, '.git', 'index'));
  await assert.rejects(app.session.invoke('git.untrack', staleIndex), { code: 'StaleIndex' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), changed);
});

test('Linux native untrack refuses foreign index locks and staged-only content', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  const request = await app.prepare();
  const lock = path.join(app.root, '.git', 'index.lock');
  await fs.writeFile(lock, 'FOREIGN');
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'IndexLocked' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'FOREIGN');
  await fs.unlink(lock);

  await fs.writeFile(path.join(app.root, 'file.txt'), 'staged-only\n');
  git(app.root, 'add', '--', 'file.txt');
  await fs.writeFile(path.join(app.root, 'file.txt'), 'different local\n');
  const before = await fs.readFile(path.join(app.root, '.git', 'index'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'StagedChanges' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), before);
  assert.equal(await fs.readFile(path.join(app.root, 'file.txt'), 'utf8'), 'different local\n');
});

test('Linux native untrack accepts staged additions and unborn branches without changing local content', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  git(app.root, 'checkout', '--orphan', 'unborn');
  const before = await fs.readFile(path.join(app.root, 'file.txt'));
  const request = await app.prepare();
  assert.equal(request.expectedHead, '');
  const result = await app.session.invoke('git.untrack', request);
  assert.equal(result.status, 'committed');
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), '');
  assert.deepEqual(await fs.readFile(path.join(app.root, 'file.txt')), before);
});

test('Linux native untrack uses repository clean filters when validating a staged addition', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  await fs.writeFile(path.join(app.root, '.gitattributes'), '*.txt text eol=crlf\n');
  await fs.writeFile(path.join(app.root, 'filtered.txt'), 'line one\r\nline two\r\n');
  git(app.root, 'add', '--', '.gitattributes', 'filtered.txt');
  const before = await fs.readFile(path.join(app.root, 'filtered.txt'));
  assert.deepEqual(before, Buffer.from('line one\r\nline two\r\n'));
  assert.equal((await app.session.invoke('git.untrack', await app.prepare('filtered.txt'))).status, 'committed');
  assert.deepEqual(await fs.readFile(path.join(app.root, 'filtered.txt')), before);
  assert.equal(git(app.root, 'ls-files', '--', 'filtered.txt'), '');
});

test('Linux native untrack refuses merge conflicts and split indexes without changing index data', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  git(app.root, 'checkout', '-b', 'side');
  await fs.writeFile(path.join(app.root, 'file.txt'), 'side\n');
  git(app.root, 'commit', '-am', 'Side');
  git(app.root, 'checkout', 'main');
  await fs.writeFile(path.join(app.root, 'file.txt'), 'main\n');
  git(app.root, 'commit', '-am', 'Main');
  assert.throws(() => git(app.root, 'merge', 'side'));
  const conflicted = await fs.readFile(path.join(app.root, '.git', 'index'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'ConflictedIndex' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), conflicted);
  git(app.root, 'merge', '--abort');

  git(app.root, 'update-index', '--split-index');
  const split = await fs.readFile(path.join(app.root, '.git', 'index'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'UnsupportedIndex' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), split);

  git(app.root, 'update-index', '--no-split-index');
  git(app.root, 'update-index', '--skip-worktree', 'file.txt');
  const sparse = await fs.readFile(path.join(app.root, '.git', 'index'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'UnsupportedIndex' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), sparse);
});

test('Linux native untrack cancellation and session close settle only after the index lock is released', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  const raw = require(binary).openSession();
  const before = await fs.readFile(path.join(app.root, '.git', 'index'));
  const pending = raw.invoke('git.untrack', await app.prepare());
  const accepted = pending.cancel();
  if (accepted) {
    await assert.rejects(pending, { code: 'Cancelled' });
    assert.deepEqual(await fs.readFile(path.join(app.root, '.git', 'index')), before);
  } else {
    const result = await pending;
    assert.equal(result.status, 'committed');
  }
  raw.close();
  await raw.whenClosed();
  await assert.rejects(fs.stat(path.join(app.root, '.git', 'index.lock')), { code: 'ENOENT' });

  const closingFixture = await fixture(t);
  const closingSession = require(binary).openSession();
  const closingBefore = await fs.readFile(path.join(closingFixture.root, '.git', 'index'));
  const closingPending = closingSession.invoke('git.untrack', await closingFixture.prepare());
  const closingOutcome = closingPending.then(value => ({ value }), error => ({ error }));
  closingSession.close();
  await closingSession.whenClosed();
  const settled = await closingOutcome;
  if (settled.error) assert.equal(settled.error.code, 'Cancelled');
  else assert.equal(settled.value.status, 'committed');
  assert.deepEqual(await fs.readFile(path.join(closingFixture.root, '.git', 'index')), closingBefore);
  await assert.rejects(fs.stat(path.join(closingFixture.root, '.git', 'index.lock')), { code: 'ENOENT' });
});

test('Linux native untrack rejects cancellation after commit without rolling back the atomic index publication', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  const raw = require(binary).openSession();
  const request = await app.prepare();
  const indexPath = path.join(app.root, '.git', 'index');
  const before = await fs.readFile(indexPath);
  const pending = raw.invoke('git.untrack', request);
  const result = await pending;
  assert.equal(result.status, 'committed');
  assert.equal(pending.cancel(), false);
  assert.notDeepEqual(await fs.readFile(indexPath), before);
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), '');
  await assert.rejects(fs.stat(path.join(app.root, '.git', 'index.lock')), { code: 'ENOENT' });
  raw.close();
  await raw.whenClosed();
});

test('Linux native untrack releases index, temporary and hash descriptors after repeated atomicity rejections', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  git(app.root, 'update-index', '--split-index');
  const request = await app.prepare();
  const indexPath = path.join(app.root, '.git', 'index');
  const original = await fs.readFile(indexPath);
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'UnsupportedIndex' });
  assert.deepEqual(await fs.readFile(indexPath), original);
  await assert.rejects(fs.stat(path.join(app.root, '.git', 'index.lock')), { code: 'ENOENT' });
  const baseline = await descriptorCount();
  for (let attempt = 0; attempt < 12; attempt++) {
    await assert.rejects(app.session.invoke('git.untrack', request), { code: 'UnsupportedIndex' });
    assert.deepEqual(await fs.readFile(indexPath), original);
    await assert.rejects(fs.stat(path.join(app.root, '.git', 'index.lock')), { code: 'ENOENT' });
    assert.equal(await descriptorCount(), baseline);
  }
});

test('Linux native untrack closes a non-regular index descriptor when rejecting an exchanged index path', { skip: process.platform !== 'linux' }, async t => {
  const app = await fixture(t);
  const indexPath = path.join(app.root, '.git', 'index');
  const retainedPath = path.join(app.root, '.git', 'index.original');
  const request = await app.prepare();
  await fs.rename(indexPath, retainedPath);
  await fs.mkdir(indexPath);
  const before = await descriptorCount();
  try {
    await assert.rejects(app.session.invoke('git.untrack', request), { code: 'UnsafePath' });
    assert.equal(await descriptorCount(), before);
    await assert.rejects(fs.stat(path.join(app.root, '.git', 'index.lock')), { code: 'ENOENT' });
  } finally {
    await fs.rm(indexPath, { recursive: true, force: true });
    await fs.rename(retainedPath, indexPath);
  }
});
