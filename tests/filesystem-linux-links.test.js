const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');

const linuxOnly = { skip: process.platform !== 'linux' };

test('Linux explicit navigation can reload a permitted root without authorizing its parent', linuxOnly, async t => {
  const { left, provider } = await setup(t);
  const before = await provider.load();
  const resolved = await provider.resolveNavigation(left);
  assert.equal(resolved.path, left);
  const after = await provider.prepare(before, { directories: [left], navigation: true });
  assert.ok(Object.hasOwn(after.folders, left));
  await assert.rejects(provider.resolveNavigation(path.dirname(left)), /Root|root|außerhalb/i);
});

test('Linux listings preserve symlink entries without traversing link targets', linuxOnly, async t => {
  const { root, outside, provider } = await setup(t);
  await fs.mkdir(`${root}/real`);
  await fs.writeFile(`${root}/real/inside.txt`, 'inside');
  await fs.symlink('real', `${root}/relative-dir`);
  await fs.symlink(`${outside}/missing.txt`, `${root}/dangling`);

  const state = await provider.load({ recursive: true });

  assert.equal(row(state, root, 'relative-dir').type, 'link');
  assert.equal(row(state, root, 'dangling').type, 'link');
  assert.equal(Object.hasOwn(state.folders, `${root}/relative-dir`), false);
  assert.equal(Object.hasOwn(state.folders, `${root}/dangling`), false);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('Linux persisted navigation rejects link aliases while explicit navigation allows a final link', linuxOnly, async t => {
  const { left, provider } = await setup(t);
  await fs.mkdir(`${left}/actual-directory`);
  await fs.symlink('actual-directory', `${left}/directory-link`);

  assert.equal(provider.canNavigate(`${left}/directory-link`), false);
  assert.equal(provider.canNavigate(`${left}/directory-link`, true), true);
  const resolved = await provider.resolveNavigation(`${left}/directory-link`);
  assert.equal(resolved.path, `${left}/actual-directory`);
  assert.equal(resolved.kind, 'directory');
  assert.ok(resolved.identities.target.ino);
  assert.ok(resolved.identities.link.linkText);
});

test('Linux copies relative, dangling and outside-root symlinks as link objects', linuxOnly, async t => {
  const { left, right, outside, provider } = await setup(t);
  await fs.mkdir(`${left}/target-dir`);
  await fs.writeFile(`${left}/target.txt`, 'target data');
  await fs.writeFile(`${outside}/private.txt`, 'outside data');
  await fs.symlink('target.txt', `${left}/relative-link`);
  await fs.symlink('missing.txt', `${left}/dangling-link`);
  await fs.symlink(`${outside}/private.txt`, `${left}/outside-link`);
  const before = await provider.load();
  const links = ['relative-link', 'dangling-link', 'outside-link'].map(name => row(before, left, name));
  await provider.apply(before, undefined, { transfer: { mode: 'copy', sourcePath: left, targetPath: right, sourceSide: 0, ids: links.map(link => link.id),
    changes: links.map(link => ({ kind: 'put', source: link.fsSource, target: right + '/' + link.name })) } });

  assert.equal(await fs.lstat(`${right}/relative-link`).then(stat => stat.isSymbolicLink()), true);
  assert.equal(await fs.readlink(`${right}/relative-link`), 'target.txt');
  assert.equal(await fs.readlink(`${right}/dangling-link`), 'missing.txt');
  assert.equal(await fs.readlink(`${right}/outside-link`), `${outside}/private.txt`);
  assert.equal(await fs.readFile(`${outside}/private.txt`, 'utf8'), 'outside data');
  assert.equal(await fs.readFile(`${left}/target.txt`, 'utf8'), 'target data');
});

test('Linux moves and renames symlinks without changing their target text', linuxOnly, async t => {
  const { left, right, outside, provider } = await setup(t);
  await fs.writeFile(`${outside}/private.txt`, 'outside data');
  await fs.symlink('../outside/private.txt', `${left}/move-link`);
  await fs.symlink('missing-relative-target', `${left}/rename-link`);
  let before = await provider.load();
  const moving = row(before, left, 'move-link');
  await provider.apply(before, undefined, { transfer: { mode: 'move', sourcePath: left, targetPath: right, sourceSide: 0, ids: [moving.id],
    changes: [{ kind: 'put', source: moving.fsSource, target: right + '/move-link' }] } });

  await assert.rejects(fs.lstat(`${left}/move-link`), { code: 'ENOENT' });
  assert.equal(await fs.readlink(`${right}/move-link`), '../outside/private.txt');
  assert.equal(await fs.readFile(`${outside}/private.txt`, 'utf8'), 'outside data');

  before = await provider.load();
  const after = structuredClone(before);
  const renaming = row(before, left, 'rename-link');
  after.folders[left] = after.folders[left].map(item => item.id === renaming.id ? { ...item, name: 'renamed-link' } : item);
  await provider.apply(before, after);
  await assert.rejects(fs.lstat(`${left}/rename-link`), { code: 'ENOENT' });
  assert.equal(await fs.readlink(`${left}/renamed-link`), 'missing-relative-target');
});

test('Linux deletion unlinks a symlink and leaves its outside target intact', linuxOnly, async t => {
  const { left, outside, provider } = await setup(t);
  const target = `${outside}/private.txt`;
  await fs.writeFile(target, 'keep this data');
  await fs.symlink(target, `${left}/external-link`);
  const before = await provider.load();
  const after = structuredClone(before);
  after.folders[left] = after.folders[left].filter(item => item.name !== 'external-link');

  await provider.apply(before, after);

  await assert.rejects(fs.lstat(`${left}/external-link`), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep this data');
});

test('Linux regular-file publication can rename its verified stage when hard links fail', linuxOnly, async t => {
  const { left, right } = await setup(t);
  const source = `${left}/source.txt`;
  await fs.writeFile(source, 'publish this file');
  let stagedIdentity;
  const provider = createProvider({
    roots: [left, right],
    fs: { ...fs, link: async () => { throw Object.assign(new Error('hard links are unavailable'), { code: 'EPERM' }); } },
    renameNoReplace: async request => {
      assert.equal(path.dirname(request.target), right);
      assert.ok(path.basename(path.dirname(request.source)).startsWith('.bitfroest-copy-'));
      const staged = await fs.lstat(request.source, { bigint: true });
      assert.deepEqual(request.expected, { dev: String(staged.dev), ino: String(staged.ino) });
      stagedIdentity = { dev: String(staged.dev), ino: String(staged.ino) };
      await assert.rejects(fs.lstat(request.target), { code: 'ENOENT' });
      await fs.rename(request.source, request.target);
    }
  });
  const before = await provider.load();
  const after = structuredClone(before);
  after.folders[right].push({ ...row(before, left, 'source.txt'), id: 'copy-without-hardlinks' });

  await provider.apply(before, after);

  assert.equal(await fs.readFile(`${right}/source.txt`, 'utf8'), 'publish this file');
  const published = await fs.lstat(`${right}/source.txt`, { bigint: true });
  assert.deepEqual({ dev: String(published.dev), ino: String(published.ino) }, stagedIdentity);
  assert.deepEqual(await fs.readdir(right), ['source.txt']);
});

test('Linux explicit navigation returns the canonical directory and rejects symlink targets outside permitted roots', linuxOnly, async t => {
  const { left, outside, provider } = await setup(t);
  await fs.mkdir(`${left}/internal-dir`);
  await fs.writeFile(`${left}/internal-dir/visible.txt`, 'visible');
  await fs.mkdir(`${outside}/external-dir`);
  await fs.writeFile(`${outside}/external-dir/secret.txt`, 'private');
  await fs.symlink('internal-dir', `${left}/internal-link`);
  await fs.symlink(`${outside}/external-dir`, `${left}/external-link`);
  const before = await provider.load();

  const navigated = await provider.prepare(before, { directories: [`${left}/internal-link`], recursive: false, navigation: true });

  assert.ok(navigated.folders[`${left}/internal-dir`].some(item => item.name === 'visible.txt'));
  assert.equal(Object.hasOwn(navigated.folders, `${left}/internal-link`), false);
  await assert.rejects(provider.prepare(navigated, { directories: [`${left}/external-link`], recursive: false, navigation: true }), /root|outside|link|reparse|Verknüpfung/i);
  assert.equal(await fs.readFile(`${outside}/external-dir/secret.txt`, 'utf8'), 'private');
});

async function setup(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-linux-links-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = `${parent}/left`, right = `${parent}/right`, outside = `${parent}/outside`;
  await Promise.all([fs.mkdir(root), fs.mkdir(right), fs.mkdir(outside)]);
  return { root, left: root, right, outside, provider: createProvider({ roots: [root, right] }) };
}

function row(state, directory, name) {
  const found = state.folders[directory]?.find(item => item.name === name);
  assert.ok(found, `missing entry ${directory}/${name}`);
  return found;
}
