const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuickDiff } = require('../quick-diff');
const fixture = (platform = 'linux') => {
  const repository = { rootUri: { fsPath: '/repo' }, state: { HEAD: { commit: 'a'.repeat(40) } },
    diffWith: async () => [{ uri: { fsPath: '/repo/src/a.sql' }, originalUri: { fsPath: '/repo/src/a.sql' } }],
    getObjectDetails: async () => ({ size: 9 }), buffer: async () => Buffer.from('select 1;') };
  const native = { invoke: async () => ({ repository: true, head: 'a'.repeat(40), entries: [
    { path: 'src/a.sql', head: 1, workdir: 2 }, { path: 'src/restored.sql', head: 1, workdir: 2 },
    { path: 'src/new.sql', head: 0, workdir: 2 }, { path: 'src/out/file.log', ignored: true },
    { path: 'other/b.sql', head: 0, workdir: 2 }] }), close() {} };
  const io = { realpath: async p => p, lstat: async p => { if (p.endsWith('/.git')) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return { size: 9, isFile: () => true, isSymbolicLink: () => false }; } };
  const lister = { fullText: async () => ({ text: 'select 2;', bytes: 9 }), decodeText: async b => ({ text: b.toString() }) };
  return { repository, native, io, lister, provider: createQuickDiff({ getRepository: async () => repository, native, io, lister, locate: async () => ({ dir: '/repo' }), platform }) };
};
test('Quick Diff lists recursive scope and true HEAD differences while excluding ignored files', async () => {
  const { provider } = fixture();
  const result = await provider.list('/repo/src', 'folder');
  assert.deepEqual(result.entries.map(e => [e.name, e.status]), [['src/a.sql', 'Modified'], ['src/new.sql', 'Added']]);
  const repository = await provider.list('/repo/src', 'repository');
  assert.ok(repository.entries.some(entry => entry.name === 'src/a.sql'));
});

test('Quick Diff waits for repository initialization on the first activation', async () => {
  const { provider, repository } = fixture();
  repository.state.HEAD = undefined;
  repository.status = async () => { repository.state.HEAD = { commit: 'a'.repeat(40) }; };
  const list = await provider.list('/repo/src', 'folder');
  assert.ok(list.entries.some(entry => entry.name === 'src/a.sql'));
});

test('Quick Diff sorts Modified before Added and uses newest modification times within each status', async () => {
  const { provider, io } = fixture(), stat = io.lstat;
  io.lstat = async target => ({ ...await stat(target), mtimeMs: target.endsWith('new.sql') ? 3000 : target.endsWith('a.sql') ? 1000 : undefined });
  const result = await provider.list('/repo/src', 'folder');
  assert.deepEqual(result.entries.map(entry => [entry.path, entry.modifiedAt]), [['src/a.sql', 1000], ['src/new.sql', 3000]]);
});

test('Quick Diff explicitly shows root-relative paths in both modes, including root files', async () => {
  const { provider, native } = fixture();
  native.invoke = async () => ({ repository: true, head: 'a'.repeat(40), entries: [{ path: 'untracked.txt', head: 0, workdir: 2 }, { path: 'src/nested/query.sql', head: 0, workdir: 2 }] });
  for (const mode of ['folder', 'repository']) {
    const result = await provider.list('/repo', mode);
    assert.equal(result.entries.find(entry => entry.path === 'untracked.txt').name, './untracked.txt');
    assert.equal(result.entries.find(entry => entry.path === 'src/nested/query.sql').name, 'src/nested/query.sql');
  }
});

test('Quick Diff uses Windows separators and an explicit dot for files at the root', async () => {
  const { provider, native } = fixture('win32');
  native.invoke = async () => ({ repository: true, head: 'a'.repeat(40), entries: [{ path: 'untracked.txt', head: 0, workdir: 2 }, { path: 'src/nested/query.sql', head: 0, workdir: 2 }] });
  for (const mode of ['folder', 'repository']) {
    const result = await provider.list('/repo', mode);
    assert.equal(result.entries.find(entry => entry.path === 'untracked.txt').name, '.\\untracked.txt');
    assert.equal(result.entries.find(entry => entry.path === 'src/nested/query.sql').name, 'src\\nested\\query.sql');
  }
});
test('Quick Diff pins HEAD, loads both sides and rejects paths outside its list', async () => {
  const { provider, repository } = fixture();
  const list = await provider.list('/repo/src', 'folder');
  repository.state.HEAD.commit = 'b'.repeat(40);
  let ref; repository.buffer = async r => { ref = r; return Buffer.from('select 1;'); };
  const diff = await provider.read(list.id, 'src/a.sql');
  assert.equal(ref, 'a'.repeat(40)); assert.equal(diff.original, 'select 1;'); assert.equal(diff.modified, 'select 2;');
  await assert.rejects(provider.read(list.id, '../secret'), /selection/i);
  assert.equal((await provider.read(list.id, 'src/new.sql')).reason, 'no-head');
});
test('Quick Diff enforces the HEAD limit before allocating content and honors cancellation', async () => {
  const { provider, repository } = fixture();
  const list = await provider.list('/repo/src', 'folder');
  repository.getObjectDetails = async () => ({ size: 5242881 });
  repository.buffer = () => { throw new Error('must not read'); };
  await assert.rejects(provider.read(list.id, 'src/a.sql'), /limit/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.list('/repo/src', 'folder', { signal: controller.signal }), { name: 'AbortError' });
});

test('Quick Diff keeps an uncancellable Git call pending until it returns and rejects its stale result', async () => {
  const { provider, repository } = fixture(), list = await provider.list('/repo/src', 'folder');
  let release, started;
  const entering = new Promise(resolve => { started = resolve; });
  repository.buffer = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const controller = new AbortController(), snapshots = []; let ended = false;
  const reading = provider.read(list.id, 'src/a.sql', { signal: controller.signal, onStatus: value => snapshots.push(value) }).finally(() => { ended = true; });
  await entering; controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, false);
  release(Buffer.from('select 1;'));
  await assert.rejects(reading, { name: 'AbortError' });
  assert.ok(snapshots.length > 0);
});

test('Quick Diff handles unborn HEAD and rejects changed-size HEAD buffers', async () => {
  const { provider, repository, native } = fixture();
  const list = await provider.list('/repo/src', 'folder');
  repository.buffer = async () => Buffer.alloc(10);
  await assert.rejects(provider.read(list.id, 'src/a.sql'), /invalid HEAD content/);
  repository.state.HEAD = undefined; repository.diffWith = () => { throw new Error('No HEAD'); };
  native.invoke = async () => ({ repository: true, head: null, entries: [{ path: 'src/new.sql', head: 0, workdir: 2 }] });
  const unborn = await provider.list('/repo/src', 'folder');
  assert.equal(unborn.entries[0].status, 'Added');
  assert.equal((await provider.read(unborn.id, 'src/new.sql')).reason, 'no-head');
});

test('Quick Diff reads native recursive status and real text versions without changing the index', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), execFileSync = require('node:child_process').execFileSync;
  const { loadNativeApi } = require('../native-api'), { createListerProvider } = require('../lister-provider');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quick-diff-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${path.join(directory, '.git/no-hooks')}`, ...args], { cwd: directory, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, '.git/empty-global-config') } });
  git('init', '-q');
  await fs.mkdir(path.join(directory, 'src')); await fs.mkdir(path.join(directory, 'out'));
  await fs.writeFile(path.join(directory, '.gitignore'), 'out/\n');
  await fs.writeFile(path.join(directory, 'src/a.sql'), 'select 1;');
  await fs.writeFile(path.join(directory, 'gone.txt'), 'removed');
  for (const filepath of ['.gitignore', 'src/a.sql', 'gone.txt']) git('add', '--', filepath);
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'Initial');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  await fs.writeFile(path.join(directory, 'src/a.sql'), 'select 2;');
  await fs.writeFile(path.join(directory, 'src/new.sql'), 'new');
  await fs.writeFile(path.join(directory, 'out/build.log'), 'ignored');
  await fs.mkdir(path.join(directory, 'out/nested')); git('init', '-q', path.join(directory, 'out/nested'));
  await fs.writeFile(path.join(directory, 'out/nested/secret.txt'), 'nested repository');
  await fs.unlink(path.join(directory, 'gone.txt'));
  const before = await fs.readFile(path.join(directory, '.git/index'));
  const repository = { rootUri: { fsPath: directory }, state: { HEAD: { commit } },
    diffWith: async () => ['src/a.sql', 'gone.txt'].map(name => ({ uri: { fsPath: path.join(directory, name) } })),
    getObjectDetails: async (oid, filepath) => ({ size: git('show', `${oid}:${filepath}`).length }),
    buffer: async (oid, filepath) => git('show', `${oid}:${filepath}`) };
  const lister = createListerProvider({ validate: target => target.startsWith(directory + path.sep) });
  const provider = createQuickDiff({ getRepository: async target => { assert.equal(target, directory); return repository; }, native: loadNativeApi().openSession(), lister });
  t.after(async () => { provider.dispose(); await lister.dispose(); });
  const statuses = [];
  const list = await provider.list(directory, 'repository', { onStatus: snapshot => statuses.push(snapshot) });
  const scoped = await provider.list(path.join(directory, 'src'), 'folder');
  assert.deepEqual(scoped.entries.map(entry => entry.path).sort(), ['src/a.sql', 'src/new.sql']);
  assert.deepEqual(list.entries.map(e => [e.path, e.status]).sort((a,b)=>a[0].localeCompare(b[0])), [['gone.txt', 'Deleted'], ['src/a.sql', 'Modified'], ['src/new.sql', 'Added']]);
  const read = await provider.read(list.id, 'src/a.sql', { onStatus: snapshot => statuses.push(snapshot) });
  assert.equal(read.original, 'select 1;'); assert.equal(read.modified, 'select 2;');
  assert.equal((await provider.read(list.id, 'gone.txt')).modified, '');
  await assert.rejects(provider.read(list.id, 'out/build.log'), /selection/i);
  assert.deepEqual(await fs.readFile(path.join(directory, '.git/index')), before);
  assert.ok(statuses.length > 10);
});
