const { execFileSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function run(dir, args, { allowFailure = false } = {}) {
  const hooks = path.join(dir, '.git', 'no-hooks');
  try {
    return execFileSync('git', ['-C', dir, '-c', `core.hooksPath=${hooks}`, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(dir, '.git', 'empty-global-config'),
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '1700000000 +0000',
        GIT_COMMITTER_DATE: '1700000000 +0000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    if (allowFailure) return error;
    throw error;
  }
}

function createGitFixture(dir) {
  return {
    async init({ dir: target = dir, defaultBranch = 'main' }) { await fsp.mkdir(target, { recursive: true }); run(target, ['init', '--quiet', '--initial-branch', defaultBranch]); },
    async add({ filepath }) { run(dir, ['add', '--', filepath]); },
    async commit(message) { return run(dir, ['commit', '--quiet', '-m', message]); },
    async branch({ ref }) { run(dir, ['branch', ref]); },
    async checkout({ ref, detached = false }) { run(dir, ['checkout', '--quiet', ...(detached ? ['--detach'] : []), ref]); },
    async resolveRef({ ref }) { return run(dir, ['rev-parse', ref]); },
    async writeRef({ ref, value, symbolic = false, force = false }) {
      if (symbolic) run(dir, ['symbolic-ref', ...(force ? ['--delete'] : []), ref, value]);
      else if (force) {
        const refPath = path.join(dir, '.git', ...ref.split('/'));
        await fsp.mkdir(path.dirname(refPath), { recursive: true });
        await fsp.writeFile(refPath, `${value}\n`);
      }
      else run(dir, ['update-ref', ref, value]);
    },
    async merge({ theirs }) {
      const error = run(dir, ['merge', '--no-commit', '--no-ff', theirs], { allowFailure: true });
      if (error instanceof Error) throw error;
    },
    async setConfig({ path: key, value }) { run(dir, ['config', '--local', key, String(value)]); },
    async addRemote({ remote, url }) { run(dir, ['remote', 'add', remote, url]); }
  };
}

async function repository(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-status-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const write = async (name, content) => {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), content);
  };
  const git = createGitFixture(dir);
  await git.init({ defaultBranch: 'main' });
  for (const name of ['clean.txt', 'modified.txt', 'deleted.txt', 'nested/deep.txt']) await write(name, `original ${name}\n`);
  await write('.gitignore', 'ignored/\n*.log\n');
  await git.add({ filepath: '.' });
  await git.commit('Initial fixture');
  await git.branch({ ref: 'feature/one' });
  await git.branch({ ref: 'second' });
  await git.writeRef({ ref: 'refs/remotes/origin/remote-only', value: await git.resolveRef({ ref: 'HEAD' }) });
  return { dir, write, commit: message => git.commit(message), git, fs: undefined };
}

async function changedRepository(t) {
  const fixture = await repository(t);
  const { dir, write, git } = fixture;
  await write('modified.txt', 'changed\n');
  await write('nested/deep.txt', 'changed nested\n');
  await fsp.unlink(path.join(dir, 'deleted.txt'));
  await write('added.txt', 'staged\n');
  await git.add({ filepath: 'added.txt' });
  await write('untracked.txt', 'new\n');
  await write('ignored/big.log', 'ignored\n');
  return fixture;
}

module.exports = { repository, changedRepository };
