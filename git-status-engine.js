const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const defaultGit = require('isomorphic-git');
const { GitIndexManager } = require('isomorphic-git/managers');
const { FileSystem } = require('isomorphic-git/models');
const { allowedGitPath } = require('./git-status-paths');

const priority = { untracked: 1, ignored: 0, clean: 2, added: 3, deleted: 4, modified: 5, conflict: 6 };
function statusOf([, head, workdir, stage]) {
  if (head === 1 && workdir === 1 && stage === 1) return 'clean';
  if (!head && !stage) return 'untracked';
  if (!workdir || head && !stage) return 'deleted';
  if (!head) return 'added';
  return 'modified';
}

function createGitStatusEngine(services = {}) {
  const git = services.git || defaultGit;
  const caches = new Map(), inspections = new Map();
  let revision = 0;
  function cacheFor(root) {
    if (!caches.has(root)) caches.set(root, {});
    const cache = caches.get(root);
    caches.delete(root); caches.set(root, cache);
    while (caches.size > 8) caches.delete(caches.keys().next().value);
    return cache;
  }
  async function locate(directory) {
    let dir = path.resolve(directory);
    for (;;) {
      try { await fsp.stat(path.join(dir, '.git')); break; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      const parent = path.dirname(dir);
      if (parent === dir) { const error = new Error('No repository'); error.code = 'NotFoundError'; throw error; }
      dir = parent;
    }
    let gitdir = path.join(dir, '.git');
    if ((await fsp.stat(gitdir)).isFile()) {
      const text = await fsp.readFile(gitdir, 'utf8');
      const match = /^gitdir: (.+)\s*$/m.exec(text);
      if (!match) throw new Error('Invalid repository directory');
      gitdir = path.resolve(dir, match[1].trim());
    }
    return { dir, gitdir, fs, cache: cacheFor(dir) };
  }
  async function identity(options) {
    const branch = await git.currentBranch({ ...options, fullname: false }) || null;
    let head = null;
    try { head = await git.resolveRef({ ...options, ref: 'HEAD' }); }
    catch (error) { if (error.code !== 'NotFoundError') throw error; }
    return { branch, head, detached: !branch && Boolean(head), unborn: Boolean(branch && !head) };
  }
  async function inspect(directory, settings = {}) {
    if (!allowedGitPath(directory, settings)) return { ok: true, repository: false, statuses: {} };
    const started = revision;
    let repositoryFound = false;
    try {
      const options = await locate(directory);
      repositoryFound = true;
      const absolute = path.resolve(directory), settingsKey = JSON.stringify(settings);
      for (const saved of inspections.values()) {
        const relative = path.relative(saved.directory, absolute).replaceAll('\\', '/');
        if (saved.result.root !== options.dir || saved.settingsKey !== settingsKey || Date.now() - saved.time > 30000 || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || relative && (settings.recursive === false || settings.showIgnored)) continue;
        const prefix = relative ? relative + '/' : '';
        return { ...saved.result, statuses: Object.fromEntries(Object.entries(saved.result.statuses).filter(([name]) => name.startsWith(prefix)).map(([name, status]) => [name.slice(prefix.length), status])) };
      }
      const info = await identity(options);
      const index = await GitIndexManager.acquire({ ...options, fs: new FileSystem(fs) }, index => ({ conflicts: new Set(index.unmergedPaths), entries: new Map(index.entriesMap) }));
      const sparse = await git.getConfig({ ...options, path: 'core.sparseCheckout' });
      if (sparse != null && sparse !== false && !/^(false|no|off|0)$/i.test(String(sparse).trim()) || [...index.entries.values()].some(entry => entry.flags.skipWorktree)) throw new Error('Sparse checkout is not supported');
      const indexTime = await fsp.stat(path.join(options.gitdir, 'index')).then(stat => Math.floor(stat.mtimeMs / 1000), error => { if (error.code === 'ENOENT') return Infinity; throw error; });
      const autocrlf = await git.getConfig({ ...options, path: 'core.autocrlf' });
      const relative = path.relative(options.dir, directory).replaceAll('\\', '/');
      const prefix = relative ? relative + '/' : '';
      const scope = relative || '.';
      const statuses = Object.create(null);
      const rows = await git.statusMatrix({ ...options, filepaths: [scope], refresh: false,
        filter: name => {
          if (name === '.' || name === relative || prefix.startsWith(name + '/')) return true;
          if (!allowedGitPath(path.join(options.dir, name), settings)) return false;
          return settings.recursive !== false || !name.startsWith(prefix) || !name.slice(prefix.length).includes('/');
        } });
      function add(name, status) {
        if (priority[status] >= (priority[statuses[name]] ?? -1)) statuses[name] = status;
      }
      for (const row of rows) {
        if (!row[0].startsWith(prefix)) continue;
        const name = row[0].slice(prefix.length);
        let status = index.conflicts.has(row[0]) ? 'conflict' : statusOf(row);
        const staged = index.entries.get(row[0]);
        if (status === 'clean' && staged?.mtimeSeconds >= indexTime) {
          const filename = path.join(options.dir, row[0]);
          const content = (staged.mode & 0o170000) === 0o120000 ? Buffer.from(await fsp.readlink(filename)) : await new FileSystem(fs).read(filename, { autocrlf });
          if ((await git.hashBlob({ object: content })).oid !== staged.oid) status = 'modified';
        }
        add(name, status);
        const segments = name.split('/'); segments.pop();
        while (segments.length) {
          const aggregate = ['added', 'deleted'].includes(status) || status === 'untracked' && settings.untrackedAsModified ? 'modified' : status;
          add(segments.join('/'), aggregate); segments.pop();
        }
      }
      if (settings.showIgnored) {
        for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
          const name = entry.name;
          if (name === '.git' || statuses[name]) continue;
          if (!allowedGitPath(path.join(directory, name), settings)) continue;
          if (await git.isIgnored({ ...options, filepath: prefix + name + (entry.isDirectory() ? '/' : '') })) statuses[name] = 'ignored';
        }
      }
      const result = { ok: true, repository: true, root: options.dir, gitdir: options.gitdir, ...info, statuses };
      if (started === revision) inspections.set(JSON.stringify([absolute, settingsKey]), { directory: absolute, settingsKey, time: Date.now(), result });
      while (inspections.size > 16) inspections.delete(inspections.keys().next().value);
      return result;
    } catch (error) {
      const missing = !repositoryFound && error.code === 'NotFoundError';
      return { ok: missing, repository: false, statuses: {}, ...(!missing ? { error: error.message } : {}) };
    }
  }
  async function branches(directory, settings = {}) {
    if (!allowedGitPath(directory, settings)) return { ok: false, error: 'Excluded repository' };
    try {
      const options = await locate(directory), info = await identity(options);
      const names = await git.listBranches(options);
      return { ok: true, ...info, names, count: names.length, otherCount: names.length - (names.includes(info.branch) ? 1 : 0) };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  return { inspect, branches, locate, invalidate() { revision++; caches.clear(); inspections.clear(); } };
}

module.exports = { createGitStatusEngine };
