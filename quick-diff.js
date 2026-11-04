const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Progress = require('./media/commander-progress');
const { createGitStatusEngine } = require('./git-status-engine');

const aborted = () => Object.assign(new Error('Quick Diff cancelled.'), { name: 'AbortError' });
function createQuickDiff({ getRepository, lister, native, io = fs, locate, platform = process.platform }) {
  const listings = new Map(), initialized = new Set();
  const locateRepository = locate || createGitStatusEngine({ session: native }).locate;
  const paths = value => /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix;
  function inside(root, target) {
    const relative = paths(root).relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${paths(root).sep}`) && !paths(root).isAbsolute(relative);
  }
  async function operation(options, work) {
    const plan = Progress.statusPlan({ id: options.requestId || `quick-diff-${crypto.randomUUID()}`, startedAt: performance.now(), steps: ['operation'], mode: 'work' });
    const check = () => { if (options.signal?.aborted) throw aborted(); };
    const publish = () => options.onStatus?.(plan.snapshot());
    plan.start('operation'); publish();
    async function step(name, action) {
      check(); const [id] = plan.append('operation', [name]); plan.start(id); publish();
      const result = await action(id); check(); plan.complete(id); publish(); return result;
    }
    try { check(); const result = await work({ check, step, plan, publish }); plan.complete('operation'); publish(); return result; }
    catch (error) { plan.terminate(error.name === 'AbortError' ? 'cancelled' : 'error'); publish(); throw error; }
  }
  async function list(directory, mode, options = {}) {
    if (!['folder', 'repository'].includes(mode)) throw new Error('Invalid Quick Diff mode.');
    return operation(options, async ({ step, check, plan, publish }) => {
      let location;
      try { location = await step('repository-location', () => locateRepository(directory)); }
      catch (error) { if (error.code === 'NotFoundError') throw new Error('Quick Diff: no repository.', { cause: error }); throw error; }
      const repository = await step('repository', () => getRepository(location.dir));
      if (!repository) throw new Error('Quick Diff: no repository.');
      const root = repository.rootUri.fsPath, scope = mode === 'repository' ? root : directory;
      if (!inside(root, scope)) throw new Error('Invalid Quick Diff scope.');
      if (!initialized.has(root)) {
        if (typeof repository.status === 'function') await step('repository-status', () => repository.status());
        initialized.add(root);
      }
      const commit = repository.state.HEAD?.commit || null;
      const changes = commit ? await step('head-changes', () => repository.diffWith(commit)) : [];
      const relative = file => paths(root).relative(root, file).replaceAll('\\', '/');
      const changed = new Set();
      for (const change of changes) {
        for (const uri of [change.uri, change.originalUri, change.renameUri]) if (uri?.fsPath && inside(root, uri.fsPath)) changed.add(relative(uri.fsPath));
      }
      const result = await step('status', id => native.invoke('git.status', { directory: root, scope: relative(scope) || '.', recursive: true, showIgnored: false }, {
        signal: options.signal,
        onProgress: update => { check(); plan.update(id, Progress.event({ phase: 'quick-diff-status', path: update.path, overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.unknown('items', 0, 'native-operation') })); publish(); }
      }));
      if (!result.repository || result.sparseCheckout || result.skipWorktree) throw new Error('Quick Diff: unsupported repository.');
      if ((result.head || null) !== commit) throw new Error('Quick Diff: HEAD changed.');
      const entries = await step('entries', async () => {
        const rows = [], seen = new Set();
        for (const entry of result.entries || []) {
          check();
          if (entry.ignored) continue;
          const name = entry.path?.replace(/\/$/, '');
          if (!name || seen.has(name) || name.split('/').includes('.git')) continue;
          const target = paths(root).resolve(root, name);
          if (!inside(root, target) || !inside(scope, target)) continue;
          if (!entry.ignored && entry.head && !changed.has(name) && !entry.conflicted) continue;
          let stat;
          try {
            stat = await io.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const resolved = await io.realpath(target);
            if (!inside(root, resolved)) continue;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!stat && !entry.head) continue;
          seen.add(name);
          const display = platform === 'win32' ? name.replaceAll('/', '\\') : name;
          rows.push({ path: name, name: name.includes('/') ? display : `${platform === 'win32' ? '.\\' : './'}${display}`, size: stat?.size || 0, modifiedAt: Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : null,
            gitStatus: entry.conflicted ? 'conflict' : !stat ? 'deleted' : !entry.head ? entry.stage ? 'added' : 'untracked' : 'modified',
            status: entry.conflicted ? 'Conflict' : entry.ignored ? 'Ignored' : !stat ? 'Deleted' : !entry.head ? 'Added' : 'Modified', hasHead: Boolean(commit && entry.head) });
        }
        const priority = { Modified: 0, Added: 1, Deleted: 2, Conflict: 3 };
        return rows.sort((a, b) => (priority[a.status] ?? 4) - (priority[b.status] ?? 4) || (b.modifiedAt ?? -Infinity) - (a.modifiedAt ?? -Infinity) || a.name.localeCompare(b.name));
      });
      const id = crypto.randomUUID(); listings.set(id, { repository, root, scope, commit, entries: new Map(entries.map(e => [e.path, e])) });
      return { id, root, scope, commit, entries };
    });
  }
  async function read(id, filename, options = {}) {
    const listing = listings.get(id), entry = listing?.entries.get(filename);
    if (!entry) throw new Error('Invalid Quick Diff selection.');
    return operation(options, async ({ step, check, plan, publish }) => {
      const finish = async result => { if (options.render) await step('render', () => options.render(result)); return result; };
      const maxBytes = options.maxBytes ?? 5242880;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid Quick Diff limit.');
      let original = '';
      if (entry.hasHead) {
        const details = await step('head-size', () => listing.repository.getObjectDetails(listing.commit, filename));
        if (!Number.isSafeInteger(details.size) || details.size > maxBytes || details.size < 0) throw new Error('Quick Diff: size limit exceeded.');
        const bytes = await step('head-read', () => listing.repository.buffer(listing.commit, filename));
        if (!Buffer.isBuffer(bytes) || bytes.length !== details.size || bytes.length > maxBytes) throw new Error('Quick Diff: invalid HEAD content.');
        original = (await step('head-decode', () => lister.decodeText(bytes))).text;
      }
      let modified = '';
      if (entry.status !== 'Deleted') {
        const target = paths(listing.root).resolve(listing.root, filename);
        if (!inside(listing.root, await io.realpath(target))) throw new Error('Invalid Quick Diff path.');
        const [parent] = plan.append('operation', ['current']); plan.start(parent); publish();
        const ids = new Map();
        const result = await lister.fullText(target, { maxBytes, expectedSize: entry.size, signal: options.signal,
          onStep: (name, state) => {
            if (!ids.has(name)) { const slash = name.lastIndexOf('/'), owner = slash < 0 ? parent : ids.get(name.slice(0, slash)); ids.set(name, plan.append(owner || parent, [slash < 0 ? name : name.slice(slash + 1)])[0]); }
            state === 'start' ? plan.start(ids.get(name)) : plan.complete(ids.get(name)); publish();
          },
          onProgress: progress => { const id = ids.get('read'); if (id) { plan.update(id, progress); publish(); } }
        });
        check(); modified = result.text; plan.complete(parent); publish();
      }
      return finish({ original, modified, commit: listing.commit, name: entry.name, path: filename, ghost: entry.status === 'Deleted' ? 'deleted' : !entry.hasHead ? 'added' : null });
    });
  }
  return { list, read, contains(target) { return [...listings.values()].some(listing => [...listing.entries.keys()].some(name => paths(listing.root).resolve(listing.root, name) === target)); }, size: () => listings.size, clear() { listings.clear(); initialized.clear(); }, listing: id => listings.get(id), selection(id, filename) { const listing = listings.get(id); if (!listing?.entries.has(filename)) throw new Error('Invalid Quick Diff selection.'); return { ...listing, entry: listing.entries.get(filename) }; }, release: id => listings.delete(id), dispose() { listings.clear(); initialized.clear(); native.close(); } };
}
module.exports = { createQuickDiff };
