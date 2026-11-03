const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createNativeApi } = require('../native-api');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.resolve(__dirname, '../native/binding.node');
function git(root, ...args) { return execFileSync('git', ['-c', `core.hooksPath=${path.join(root, '.hooks')}`, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config') } }).trim(); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-index-native-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(root, 'file.txt'), 'original\n'); await fs.writeFile(path.join(root, 'other.txt'), 'other\n');
  git(root, 'add', '--', '.'); git(root, 'commit', '-m', 'Initial fixture');
  const api = createNativeApi(require(binary)), session = api.openSession(); t.after(() => api.shutdown());
  async function prepare(target = 'file.txt') { return { repositoryRoot: root, target: path.join(root, target), expectedHead: git(root, 'rev-parse', 'HEAD'), expectedReference: git(root, 'symbolic-ref', 'HEAD'), expectedIndex: crypto.createHash('sha256').update(await fs.readFile(path.join(root, '.git/index'))).digest('hex'), expectedIno: (await fs.stat(path.join(root, target), { bigint: true })).ino.toString() }; }
  return { root, api, session, prepare };
}
test('native untrack removes one index entry and preserves local bytes and unrelated staged entries', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); await fs.writeFile(path.join(app.root, 'file.txt'), 'local modifications\n');
  await fs.writeFile(path.join(app.root, 'other.txt'), 'staged other\n'); git(app.root, 'add', '--', 'other.txt');
  const other = git(app.root, 'ls-files', '--stage', '--', 'other.txt');
  const gitFiles = (await fs.readdir(path.join(app.root, '.git'))).sort();
  const result = await app.session.invoke('git.untrack', await app.prepare());
  assert.equal(result.status, 'committed'); assert.equal(result.removed, true);
  assert.equal(await fs.readFile(path.join(app.root, 'file.txt'), 'utf8'), 'local modifications\n');
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), ''); assert.equal(git(app.root, 'ls-files', '--stage', '--', 'other.txt'), other);
  await assert.rejects(fs.stat(path.join(app.root, '.git/index.lock')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(app.root, '.git'))).sort(), gitFiles);
});
test('native untrack refuses stale HEAD and index snapshots without changing the index', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), request = await app.prepare();
  await fs.writeFile(path.join(app.root, 'other.txt'), 'changed\n'); git(app.root, 'add', '--', 'other.txt');
  const before = await fs.readFile(path.join(app.root, '.git/index'));
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'StaleIndex' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before);
  const newer = await app.prepare(); git(app.root, 'commit', '-m', 'New HEAD');
  await assert.rejects(app.session.invoke('git.untrack', { ...await app.prepare(), expectedHead: newer.expectedHead }), { code: 'StaleHead' });
});
test('native untrack preserves staged-only content by refusing force and accepts additions retained locally', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); await fs.writeFile(path.join(app.root, 'file.txt'), 'staged only\n'); git(app.root, 'add', '--', 'file.txt'); await fs.writeFile(path.join(app.root, 'file.txt'), 'different local\n');
  const before = await fs.readFile(path.join(app.root, '.git/index'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'StagedChanges' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before);
  await fs.writeFile(path.join(app.root, 'added.txt'), 'new staged file\n'); git(app.root, 'add', '--', 'added.txt');
  assert.equal((await app.session.invoke('git.untrack', await app.prepare('added.txt'))).removed, true);
  assert.equal(await fs.readFile(path.join(app.root, 'added.txt'), 'utf8'), 'new staged file\n');
});
test('native untrack respects foreign index locks and rejects folders, untracked files and replaced file identities', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), request = await app.prepare(); await fs.writeFile(path.join(app.root, '.git/index.lock'), 'FOREIGN');
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'IndexLocked' }); assert.equal(await fs.readFile(path.join(app.root, '.git/index.lock'), 'utf8'), 'FOREIGN');
  await fs.unlink(path.join(app.root, '.git/index.lock'));
  await fs.rename(path.join(app.root, 'file.txt'), path.join(app.root, 'moved.txt')); await fs.writeFile(path.join(app.root, 'file.txt'), 'replacement');
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'StaleFile' });
  await fs.writeFile(path.join(app.root, 'untracked.txt'), 'untracked'); await assert.rejects(app.session.invoke('git.untrack', await app.prepare('untracked.txt')), { code: 'NotTracked' });
  await fs.mkdir(path.join(app.root, 'folder'));
  await assert.rejects(app.session.invoke('git.untrack', { ...await app.prepare(), target: path.join(app.root, 'folder') }), { code: 'UnsafePath' });
});
test('native untrack cancels before publication and releases its locks', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), request = await app.prepare(), controller = new AbortController(); controller.abort();
  const before = await fs.readFile(path.join(app.root, '.git/index'));
  await assert.rejects(async () => app.session.invoke('git.untrack', request, { signal: controller.signal }), { code: 'Cancelled' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before);
});

test('native untrack rejects a branch switch even when the new branch points to the same commit', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), request = await app.prepare(); git(app.root, 'checkout', '-b', 'same-head');
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'StaleHead' });
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), 'file.txt');
});

test('native untrack rejects symbolic branch aliases instead of leaving the terminal HEAD reference unlocked', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); git(app.root, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main'); git(app.root, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
  const request = { ...await app.prepare(), expectedReference: 'refs/heads/alias' }, before = await fs.readFile(path.join(app.root, '.git/index'));
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'UnsupportedRepository' }); assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before);
});

test('native untrack accepts differently cased Windows repository prefixes while preserving the indexed filename', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), request = await app.prepare(); request.repositoryRoot = request.repositoryRoot.toLowerCase();
  assert.equal((await app.session.invoke('git.untrack', request)).status, 'committed'); assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), '');
});

test('native untrack resolves a case-only local filename change through repository index capabilities', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); await fs.rename(path.join(app.root, 'file.txt'), path.join(app.root, 'FILE.TXT'));
  const request = await app.prepare('FILE.TXT'); assert.equal((await app.session.invoke('git.untrack', request)).status, 'committed');
  assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), ''); assert.equal(await fs.readFile(path.join(app.root, 'FILE.TXT'), 'utf8'), 'original\n');
});

test('native untrack refuses case-colliding index entries imported from a case-sensitive filesystem', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), blob = git(app.root, 'rev-parse', 'HEAD:file.txt');
  git(app.root, 'update-index', '--add', '--cacheinfo', `100644,${blob},FILE.TXT`);
  assert.equal(git(app.root, 'ls-files').split('\n').filter(name => name.toLowerCase() === 'file.txt').length, 2);
  const before = await fs.readFile(path.join(app.root, '.git/index'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'UnsupportedIndex' }); assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before);
});

test('native whenClosed waits for pending index work and complete lock cleanup', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), raw = require(binary).openSession(); let completed = false;
  const pending = raw.invoke('git.untrack', await app.prepare()).then(() => { completed = true; }, () => { completed = true; });
  raw.close();
  try { await raw.whenClosed(); assert.equal(completed, true); await assert.rejects(fs.stat(path.join(app.root, '.git/index.lock')), { code: 'ENOENT' }); }
  finally { await pending; }
});

test('native untrack refuses conflict stages and leaves every conflict blob intact', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); git(app.root, 'checkout', '-b', 'side');
  await fs.writeFile(path.join(app.root, 'file.txt'), 'side\n'); git(app.root, 'commit', '-am', 'Side'); git(app.root, 'checkout', 'main');
  await fs.writeFile(path.join(app.root, 'file.txt'), 'main\n'); git(app.root, 'commit', '-am', 'Main');
  assert.throws(() => git(app.root, 'merge', 'side'));
  const before = await fs.readFile(path.join(app.root, '.git/index')), content = await fs.readFile(path.join(app.root, 'file.txt'));
  await assert.rejects(app.session.invoke('git.untrack', await app.prepare()), { code: 'ConflictedIndex' });
  assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before); assert.deepEqual(await fs.readFile(path.join(app.root, 'file.txt')), content);
});

test('Git index provider captures an unforgeable one-use ticket and completes through the native API', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), provider = require('../git-index').createGitIndexProvider({ nativeApi: app.api }); t.after(() => provider.dispose());
  const ticket = await provider.prepare({ repositoryRoot: app.root, target: path.join(app.root, 'file.txt') });
  assert.equal(Object.isFrozen(ticket), true);
  await assert.rejects(provider.untrack({ ...ticket }), { code: 'InvalidRequest' });
  assert.equal((await provider.untrack(ticket)).status, 'committed');
  await assert.rejects(provider.untrack(ticket), { code: 'InvalidRequest' });
});

test('native untrack handles an unborn branch without changing local file content', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); git(app.root, 'checkout', '--orphan', 'unborn');
  const provider = require('../git-index').createGitIndexProvider({ nativeApi: app.api }); t.after(() => provider.dispose());
  const target = path.join(app.root, 'file.txt'), before = await fs.readFile(target);
  const ticket = await provider.prepare({ repositoryRoot: app.root, target }); assert.equal(ticket.expectedHead, '');
  assert.equal((await provider.untrack(ticket)).status, 'committed'); assert.equal(git(app.root, 'ls-files', '--', 'file.txt'), ''); assert.deepEqual(await fs.readFile(target), before);
});

test('native untrack rejects split indexes without rewriting their backing files', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t); git(app.root, 'update-index', '--split-index'); const request = await app.prepare();
  const before = await fs.readFile(path.join(app.root, '.git/index'));
  await assert.rejects(app.session.invoke('git.untrack', request), { code: 'UnsupportedIndex' }); assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before);
});

test('native untrack accepts Unicode names and gives an in-flight cancellation a definite publication outcome', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t), name = 'datei-\u00e4-\u6587.txt'; await fs.writeFile(path.join(app.root, name), 'unicode\n'); git(app.root, 'add', '--', name);
  const native = require(binary).openSession(); t.after(() => native.close()); const before = await fs.readFile(path.join(app.root, '.git/index'));
  const pending = native.invoke('git.untrack', await app.prepare(name)), accepted = pending.cancel();
  if (accepted) { await assert.rejects(pending, { code: 'Cancelled' }); assert.deepEqual(await fs.readFile(path.join(app.root, '.git/index')), before); }
  else assert.equal((await pending).status, 'committed');
  if (accepted) assert.equal((await app.session.invoke('git.untrack', await app.prepare(name))).status, 'committed');
  assert.equal(git(app.root, 'ls-files', '--', name), ''); assert.equal(await fs.readFile(path.join(app.root, name), 'utf8'), 'unicode\n');
});
