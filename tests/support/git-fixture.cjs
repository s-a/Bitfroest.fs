const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const git = require('isomorphic-git');

async function repository(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-status-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const write = async (name, content) => { await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fsp.writeFile(path.join(dir, name), content); };
  const commit = message => git.commit({ fs, dir, message, author: { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1700000000, timezoneOffset: 0 } });
  await git.init({ fs, dir, defaultBranch: 'main' });
  for (const name of ['clean.txt', 'modified.txt', 'deleted.txt', 'nested/deep.txt']) await write(name, `original ${name}\n`);
  await write('.gitignore', 'ignored/\n*.log\n');
  await git.add({ fs, dir, filepath: '.' });
  await commit('Initial fixture');
  await git.branch({ fs, dir, ref: 'feature/one' });
  await git.branch({ fs, dir, ref: 'second' });
  await git.writeRef({ fs, dir, ref: 'refs/remotes/origin/remote-only', value: await git.resolveRef({ fs, dir, ref: 'HEAD' }) });
  return { dir, write, commit, git, fs };
}

async function changedRepository(t) {
  const fixture = await repository(t);
  const { dir, write } = fixture;
  await write('modified.txt', 'changed\n');
  await write('nested/deep.txt', 'changed nested\n');
  await fsp.unlink(path.join(dir, 'deleted.txt'));
  await write('added.txt', 'staged\n'); await git.add({ fs, dir, filepath: 'added.txt' });
  await write('untracked.txt', 'new\n'); await write('ignored/big.log', 'ignored\n');
  return fixture;
}

module.exports = { repository, changedRepository };
