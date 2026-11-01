const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Progress = require('./media/commander-progress');
const { loadNativeApi } = require('./native-api');
const { allowedGitPath } = require('./git-status-paths');

const priority = { untracked: 1, ignored: 0, clean: 2, added: 3, deleted: 4, modified: 5, conflict: 6 };
function reportActivity(onProgress, phase, target) {
  onProgress?.(Progress.event({ phase, path: target, ok: true, loading: true, incremental: true, statuses: {}, overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.unknown('items', 0, 'native-operation') }));
}
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
  async function locate(directory, onDirectory) {
    let dir = path.resolve(directory);
    for (;;) {
      onDirectory?.(path.join(dir, '.git'));
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
  async function repositories(directory, settings = {}, onProgress) {
    const roots = [];
    reportActivity(onProgress, 'git-discover', directory);
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const child = path.join(directory, entry.name);
      if (!allowedGitPath(child, settings)) continue;
      reportActivity(onProgress, 'git-locate', path.join(child, '.git'));
      try { await fsp.stat(path.join(child, '.git')); roots.push(child); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    return roots;
  }
  async function describe(directory, settings = {}, onProgress) {
    if (!allowedGitPath(directory, settings)) return { ok: true, repository: false, statuses: {} };
    try {
      const options = await locate(directory, target => reportActivity(onProgress, 'git-locate', target));
      reportActivity(onProgress, 'git-read-head', options.dir);
      return { ok: true, repository: true, root: options.dir, gitdir: options.gitdir, ...await identity(options), statuses: {} };
    } catch (error) {
      return { ok: error.code === 'NotFoundError', repository: false, statuses: {}, ...(error.code !== 'NotFoundError' ? { error: error.message } : {}) };
    }
  }
  async function dirtySummary(directory, settings) {
    const summary = await runStatus({ directory, scope: '.', summary: true, recursive: settings.recursive !== false, includeScopes: relativeScopes(directory, settings.includePaths, true), excludeScopes: relativeScopes(directory, settings.excludePaths, false) }, { signal: services.signal });
    if (!summary.repository) throw new Error('Git repository metadata could not be read.');
    if (!summary.summary || typeof summary.dirty !== 'boolean') throw new Error('The native Git dirty-summary contract is unavailable.');
    if (summary.sparseCheckout || summary.skipWorktree) throw new Error('Sparse checkout is not supported');
    if (![2, 3].includes(summary.indexVersion)) throw new Error('Git index version is not supported');
    return { ok: true, dirty: summary.dirty, dirtyPath: summary.dirtyPath };
  }
  async function inspect(directory, settings = {}, onProgress) {
    if (!allowedGitPath(directory, settings)) return { ok: true, repository: false, statuses: {} };
    let completedWork = 0;
    const publish = onProgress;
    onProgress = publish ? update => {
      const progress = Progress.read(update);
      publish(Progress.event({ ...progress, overall: Progress.unknown('items', completedWork, progress.phase === 'git-read-worktree' ? 'native-operation' : 'enumerating') }));
    } : undefined;
    const started = revision;
    let repositoryFound = false;
    try {
      const options = await locate(directory, target => reportActivity(onProgress, 'git-locate', target));
      repositoryFound = true;
      const absolute = path.resolve(directory), settingsKey = JSON.stringify(settings);
      for (const saved of inspections.values()) {
        const relative = path.relative(saved.directory, absolute).replaceAll('\\', '/');
        if (saved.result.root !== options.dir || saved.settingsKey !== settingsKey || Date.now() - saved.time > 30000 || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || relative && (settings.recursive === false || settings.showIgnored)) continue;
        const prefix = relative ? relative + '/' : '';
        reportActivity(onProgress, 'git-cache', directory);
        return { ...saved.result, statuses: Object.fromEntries(Object.entries(saved.result.statuses).filter(([name]) => name.startsWith(prefix)).map(([name, status]) => [name.slice(prefix.length), status])) };
      }
      const relative = path.relative(options.dir, directory).replaceAll('\\', '/');
      const prefix = relative ? relative + '/' : '';
      const scope = relative || '.';
      const statuses = Object.create(null);
      let pendingStatuses = Object.create(null), batchTime = Date.now(), processedRows = 0, currentPath = directory, nativeReportedAt = 0;
      let nativeTotal = 0, nativeCompleted = 0, nativePaths = [], nativePath = directory;
      function reportNative(final = false) {
        if (!onProgress) return;
        if (final) { completedWork += nativeTotal - nativeCompleted; nativeCompleted = nativeTotal; }
        const paths = nativePaths; nativePaths = [];
        onProgress(Progress.event({ phase: 'git-read-worktree', path: nativePath, ok: true, loading: true, incremental: true, statuses: {},
          nativeChecks: { paths, total: nativeTotal, completed: nativeCompleted }, overall: Progress.unknown('items', completedWork, 'native-operation'), current: Progress.unknown('items', nativeCompleted, 'native-operation') }));
      }
      async function flushStatuses() {
        if (!onProgress) return;
        onProgress(Progress.event({ phase: 'git-map-status', path: currentPath, ok: true, repository: true, ...info, loading: true, incremental: true, statuses: pendingStatuses, overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.known('items', processedRows, rows.length) }));
        pendingStatuses = Object.create(null); batchTime = Date.now();
        await new Promise(resolve => setImmediate(resolve));
      }
      async function reportStatus(name, status) {
        if (!onProgress || name.includes('/')) return;
        pendingStatuses[name] = status;
        if (Object.keys(pendingStatuses).length >= 64 || Date.now() - batchTime >= 40) await flushStatuses();
      }
      reportActivity(onProgress, 'git-read-worktree', directory);
      const nativeResult = await runStatus({
        directory: options.dir,
        scope,
        recursive: settings.recursive !== false,
        showIgnored: settings.showIgnored === true,
        includeScopes: relativeScopes(options.dir, settings.includePaths, true),
        excludeScopes: relativeScopes(options.dir, settings.excludePaths, false)
      }, { signal: services.signal, onProgress: onProgress ? update => {
        nativeTotal++;
        const completed = nativeTotal - 1;
        completedWork += completed - nativeCompleted; nativeCompleted = completed;
        nativePath = path.resolve(options.dir, update.path); nativePaths.push(nativePath);
        const now = Date.now();
        if (nativeReportedAt === 0 || nativePaths.length >= 512 || now - nativeReportedAt >= 50) {
          nativeReportedAt = now;
          reportNative();
        }
      } : undefined });
      reportNative(true);
      if (!nativeResult.repository) throw Object.assign(new Error('Git repository metadata could not be read.'), { code: 'InvalidRepository' });
      if (nativeResult.sparseCheckout || nativeResult.skipWorktree) throw new Error('Sparse checkout is not supported');
      if (![2, 3].includes(nativeResult.indexVersion)) throw new Error('Git index version is not supported');
      const info = { branch: nativeResult.branch || null, head: nativeResult.head || null, detached: Boolean(nativeResult.detached), unborn: Boolean(nativeResult.unborn) };
      const rows = nativeResult.entries.map(entry => [entry.path, entry.head, entry.workdir, entry.stage, entry.conflicted, entry.ignored]);
      onProgress?.(Progress.event({ phase: 'git-map-status', path: directory, ok: true, repository: true, ...info, loading: true, incremental: true, statuses: {}, overall: Progress.unknown('items', completedWork, 'enumerating'), current: Progress.known('items', 0, rows.length) }));
      function add(name, status) {
        if (priority[status] >= (priority[statuses[name]] ?? -1)) statuses[name] = status;
      }
      for (const row of rows) {
        completedWork++;
        processedRows++;
        currentPath = path.join(options.dir, row[0]);
        if (row[5]) {
          if (!settings.showIgnored) continue;
          const name = row[0].slice(prefix.length).replace(/\/$/, '');
          if (!row[0].startsWith(prefix) || !allowedGitPath(path.join(directory, name), settings)) continue;
          if (settings.recursive === false && name.includes('/')) continue;
          add(name, 'ignored');
          await reportStatus(name, statuses[name]);
          const segments = name.split('/'); segments.pop();
          while (segments.length) {
            add(segments.join('/'), 'ignored'); segments.pop();
          }
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
        const statuses = {}, repositoryErrors = Object.create(null);
        try {
          const children = await repositories(directory, settings, onProgress); let checked = 0;
          const reportCheck = (active, result, paths) => onProgress?.(Progress.event({ phase: 'git-dirty-check', path: active || directory, ok: true, repository: false, loading: true, incremental: true, loadingRepositories: active && !result ? [path.basename(active)] : [], statuses: { ...statuses }, repositoryErrors: { ...repositoryErrors },
            repositoryChecks: { ...(paths ? { paths } : {}), total: children.length, completed: checked, active }, ...(result ? { repositoryResult: { path: active, ok: result.ok, error: result.error } } : {}), overall: Progress.unknown('requests', checked, 'enumerating'), current: Progress.known('requests', checked, children.length) }));
          reportCheck(null, null, children);
          for (const child of children) {
            const name = path.basename(child);
            reportCheck(child, null);
            let result;
            try {
              result = await dirtySummary(child, settings);
            } catch (error) { result = { ok: false, error: error.message }; }
            checked++;
            if (!result.ok) {
              repositoryErrors[name] = result.error || 'Git status unavailable';
              reportCheck(child, result);
              continue;
            }
            statuses[name] = result.dirty ? 'modified' : 'clean';
            reportCheck(child, result);
          }
          return { ok: true, repository: false, statuses, ...(Object.keys(repositoryErrors).length ? { repositoryErrors } : {}) };
        } catch (failure) { return { ok: false, repository: false, statuses: {}, error: failure.message }; }
      }
      return { ok: missing, repository: false, repositoryDetected: repositoryFound, statuses: {}, ...(!missing ? { error: error.message } : {}) };
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
