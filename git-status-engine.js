const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadNativeApi } = require('./native-api');
const { allowedGitPath } = require('./git-status-paths');

const priority = { untracked: 1, ignored: 0, clean: 2, added: 3, deleted: 4, modified: 5, conflict: 6 };
function relativeScopes(root, values, includes) {
  const scopes = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value) continue;
    const target = path.resolve(value), relative = path.relative(root, target);
    const targetIsWithinRoot = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    if (includes) {
      const rootWithinTarget = path.relative(target, root);
      const targetContainsRoot = !path.isAbsolute(rootWithinTarget) && rootWithinTarget !== '..' && !rootWithinTarget.startsWith(`..${path.sep}`);
      if (targetContainsRoot) return [];
      if (targetIsWithinRoot && relative) scopes.push(relative.replaceAll('\\', '/'));
    } else if (targetIsWithinRoot && relative) scopes.push(relative.replaceAll('\\', '/'));
  }
  return [...new Set(scopes)];
}
function statusOf([, head, workdir, stage]) {
  if (head === 1 && workdir === 1 && stage === 1) return 'clean';
  if (!head && !stage) return 'untracked';
  if (!workdir || head && !stage) return 'deleted';
  if (!head) return 'added';
  return 'modified';
}

function createGitStatusEngine(services = {}) {
  const nativeApi = services.nativeApi || loadNativeApi();
  const session = services.session || nativeApi.openSession();
  const runInfo = services.info || (request => session.invoke('git.info', request));
  const runStatus = services.status || ((request, options) => session.invoke('git.status', request, options));
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
    const result = await runInfo({ directory: options.dir });
    if (!result.repository) throw Object.assign(new Error('No repository'), { code: 'NotFoundError' });
    return { branch: result.branch || null, head: result.head || null, detached: Boolean(result.detached), unborn: Boolean(result.unborn) };
  }
  async function repositories(directory, settings = {}) {
    const roots = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const child = path.join(directory, entry.name);
      if (!allowedGitPath(child, settings)) continue;
      try { await fsp.stat(path.join(child, '.git')); roots.push(child); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    return roots;
  }
  async function describe(directory, settings = {}) {
    if (!allowedGitPath(directory, settings)) return { ok: true, repository: false, statuses: {} };
    try {
      const options = await locate(directory);
      return { ok: true, repository: true, root: options.dir, gitdir: options.gitdir, ...await identity(options), statuses: {} };
    } catch (error) {
      return { ok: error.code === 'NotFoundError', repository: false, statuses: {}, ...(error.code !== 'NotFoundError' ? { error: error.message } : {}) };
    }
  }
  async function inspect(directory, settings = {}, onProgress) {
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
      const relative = path.relative(options.dir, directory).replaceAll('\\', '/');
      const prefix = relative ? relative + '/' : '';
      const scope = relative || '.';
      const statuses = Object.create(null);
      let pendingStatuses = Object.create(null), batchTime = Date.now();
      async function flushStatuses() {
        if (!onProgress || !Object.keys(pendingStatuses).length) return;
        onProgress({ ok: true, repository: true, ...info, loading: true, incremental: true, statuses: pendingStatuses });
        pendingStatuses = Object.create(null); batchTime = Date.now();
        await new Promise(resolve => setImmediate(resolve));
      }
      async function reportStatus(name, status) {
        if (!onProgress || name.includes('/')) return;
        pendingStatuses[name] = status;
        if (Object.keys(pendingStatuses).length >= 64 || Date.now() - batchTime >= 40) await flushStatuses();
      }
      const nativeResult = await runStatus({
        directory: options.dir,
        scope,
        recursive: settings.recursive !== false,
        showIgnored: settings.showIgnored === true,
        includeScopes: relativeScopes(options.dir, settings.includePaths, true),
        excludeScopes: relativeScopes(options.dir, settings.excludePaths, false)
      }, { signal: services.signal });
      if (!nativeResult.repository) throw Object.assign(new Error('No repository'), { code: 'NotFoundError' });
      if (nativeResult.sparseCheckout || nativeResult.skipWorktree) throw new Error('Sparse checkout is not supported');
      if (![2, 3].includes(nativeResult.indexVersion)) throw new Error('Git index version is not supported');
      const info = { branch: nativeResult.branch || null, head: nativeResult.head || null, detached: Boolean(nativeResult.detached), unborn: Boolean(nativeResult.unborn) };
      const rows = nativeResult.entries.map(entry => [entry.path, entry.head, entry.workdir, entry.stage, entry.conflicted, entry.ignored]);
      function add(name, status) {
        if (priority[status] >= (priority[statuses[name]] ?? -1)) statuses[name] = status;
      }
      for (const row of rows) {
        if (row[5]) {
          if (!settings.showIgnored) continue;
          const name = row[0].slice(prefix.length).replace(/\/$/, '');
          if (!row[0].startsWith(prefix) || name.includes('/') || !allowedGitPath(path.join(directory, name), settings)) continue;
          if (!statuses[name]) statuses[name] = 'ignored';
          await reportStatus(name, 'ignored');
          continue;
        }
        if (!row[0].startsWith(prefix)) continue;
        if (!allowedGitPath(path.join(options.dir, row[0]), settings)) continue;
        if (settings.recursive === false && row[0].slice(prefix.length).includes('/')) continue;
        const name = row[0].slice(prefix.length);
        let status = row[4] ? 'conflict' : statusOf(row);
        add(name, status);
        if (onProgress && !name.includes('/')) await reportStatus(name, status);
        const segments = name.split('/'); segments.pop();
        while (segments.length) {
          const aggregate = ['added', 'deleted'].includes(status) || status === 'untracked' && settings.untrackedAsModified ? 'modified' : status;
          add(segments.join('/'), aggregate); segments.pop();
        }
      }
      await flushStatuses();
      const result = { ok: true, repository: true, root: options.dir, gitdir: options.gitdir, ...info, statuses };
      if (started === revision) inspections.set(JSON.stringify([absolute, settingsKey]), { directory: absolute, settingsKey, time: Date.now(), result });
      while (inspections.size > 16) inspections.delete(inspections.keys().next().value);
      return result;
    } catch (error) {
      const missing = !repositoryFound && error.code === 'NotFoundError';
      if (missing) {
        const statuses = {};
        try {
          for (const child of await repositories(directory, settings)) {
            const name = path.basename(child);
            if (onProgress && (await describe(child, settings)).repository) {
              onProgress({ ok: true, repository: false, loading: true, loadingRepositories: [name], statuses: { ...statuses } });
            }
            const result = await inspect(child, settings);
            if (!result.ok) {
              onProgress?.({ ok: true, repository: false, loading: true, loadingRepositories: [], statuses: { ...statuses } });
              continue;
            }
            let status = 'clean';
            for (const value of Object.values(result.statuses)) {
              const aggregate = ['added', 'deleted'].includes(value) || value === 'untracked' && settings.untrackedAsModified ? 'modified' : value;
              if (priority[aggregate] > priority[status]) status = aggregate;
            }
            statuses[name] = status;
            onProgress?.({ ok: true, repository: false, loading: true, loadingRepositories: [], statuses: { ...statuses } });
          }
          return { ok: true, repository: false, statuses };
        } catch (failure) { return { ok: false, repository: false, statuses: {}, error: failure.message }; }
      }
      return { ok: missing, repository: false, statuses: {}, ...(!missing ? { error: error.message } : {}) };
    }
  }
  async function branches(directory, settings = {}) {
    if (!allowedGitPath(directory, settings)) return { ok: false, error: 'Excluded repository' };
    try {
      const options = await locate(directory), result = await runInfo({ directory: options.dir });
      if (!result.repository) throw Object.assign(new Error('No repository'), { code: 'NotFoundError' });
      return { ok: true, branch: result.branch || null, head: result.head || null, detached: Boolean(result.detached), unborn: Boolean(result.unborn), names: result.names, remoteNames: result.remoteNames, count: result.count, otherCount: result.otherCount };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  return { inspect, describe, branches, locate, repositories, close() { session.close(); if (services.nativeApi !== nativeApi) nativeApi.shutdown(); }, invalidate() { revision++; caches.clear(); inspections.clear(); } };
}

module.exports = { createGitStatusEngine };
