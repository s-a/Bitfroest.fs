const fs = require('node:fs/promises');
const path = require('node:path');
const { createQuickDiff } = require('./quick-diff');
const { createListerProvider } = require('./lister-provider');
const { loadNativeApi } = require('./native-api');
const { getFilesystemIcons } = require('./filesystem-icons');

function createQuickDiffHost({ vscode, panel, validateDirectory, t }) {
  const messages = {
    'Quick Diff: no repository.': 'Quick Diff: Kein Repository gefunden.',
    'Quick Diff: Git extension unavailable.': 'Quick Diff: Die Git-Erweiterung ist nicht verfügbar.',
    'Quick Diff: size limit exceeded.': 'Quick Diff: Größenlimit überschritten.',
    'X-Ray size limit exceeded.': 'Quick Diff: Größenlimit überschritten.',
    'X-Ray: binary content.': 'Quick Diff: Binärinhalt kann nicht verglichen werden.',
    'X-Ray: Datei geändert. Vorschau erneut aktivieren.': 'Quick Diff: Datei geändert. Vorschau erneut laden.',
    'Quick Diff: HEAD changed.': 'Quick Diff: HEAD hat sich geändert. Vorschau erneut laden.',
    'Quick Diff: unsupported repository.': 'Quick Diff: Repositoryformat wird nicht unterstützt.',
    'Quick Diff: invalid HEAD content.': 'Quick Diff: Ungültiger Dateistand aus HEAD.'
  };
  const errorText = error => t(messages[error.message] || error.message);
  const jobs = new Map(), views = new Map(), subscriptions = [];
  let closed = false, api, timer, watcher, repositorySubscription;
  const send = value => { if (!closed) return panel.webview.postMessage(value); };
  const lister = createListerProvider({ validate: target => quick.contains(target) });
  const quick = createQuickDiff({ lister, native: loadNativeApi().openSession(), getRepository: async directory => {
    if (typeof directory !== 'string') throw new Error('Quick Diff: invalid directory.');
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('Quick Diff: Git extension unavailable.');
    const exports = extension.isActive ? extension.exports : await extension.activate();
    api = exports.getAPI(1);
    const repository = api.getRepository(vscode.Uri.file(directory)) || await api.openRepository(vscode.Uri.file(directory));
    return repository;
  } });
  const changed = uri => { if (uri?.fsPath?.replaceAll('\\', '/').split('/').includes('.git')) return; clearTimeout(timer); timer = setTimeout(() => { if (!closed) void send({ type: 'quick-diff-refresh' }); }, 200); };
  function reset() {
    clearTimeout(timer); watcher?.dispose(); watcher = null; repositorySubscription?.dispose(); repositorySubscription = null;
    for (const job of jobs.values()) { job.controller.abort(); job.render?.(false); }
    views.clear(); quick.clear();
  }
  async function handle(message) {
    if (!message?.type?.startsWith('quick-diff-')) return false;
    if (message.type === 'quick-diff-icons') {
      try {
        const listing = quick.listing(message.listId);
        if (!listing || !Array.isArray(message.paths) || message.paths.length > 100) return true;
        const requests = message.paths.map(name => { const { entry } = quick.selection(message.listId, name); return { key: name, path: path.join(listing.root, name), name: path.basename(name), type: 'file', exists: entry.status !== 'Deleted' }; });
        const icons = await getFilesystemIcons(requests);
        if (quick.listing(message.listId) === listing) await send({ type: 'quick-diff-icons-result', listId: message.listId, generation: message.generation, icons });
      } catch { /* Icon failures do not change comparison data. */ }
      return true;
    }
    if (message.type === 'quick-diff-release') { quick.release(message.listId); if (!quick.size()) { watcher?.dispose(); watcher = null; repositorySubscription?.dispose(); repositorySubscription = null; } return true; }
    if (message.type === 'quick-diff-rendered') { jobs.get(message.requestId)?.render?.(message.ok === true); return true; }
    if (message.type === 'quick-diff-cancel') { const job = jobs.get(message.requestId); job?.controller.abort(); job?.render?.(false); views.delete(message.requestId); return true; }
    if (['quick-diff-copy', 'quick-diff-open'].includes(message.type)) {
      const view = views.get(message.requestId);
      if (!view || closed) return true;
      try {
        const selection = quick.selection(view.listId, view.path);
        if (message.type === 'quick-diff-copy') {
          if (typeof message.text !== 'string' || ![view.original, view.modified].some(text => text.includes(message.text))) throw new Error('Invalid Quick Diff selection.');
          await vscode.env.clipboard.writeText(message.text);
        } else {
          const target = vscode.Uri.file(path.join(selection.root, view.path));
          if (selection.entry.status !== 'Deleted') {
            const stat = await fs.lstat(target.fsPath);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid Quick Diff path.');
            const relative = path.relative(await fs.realpath(selection.root), await fs.realpath(target.fsPath));
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid Quick Diff path.');
          }
          const right = selection.entry.status === 'Deleted' ? vscode.Uri.parse('bitfroest-quick-diff-empty:/deleted') : target;
          await vscode.commands.executeCommand('vscode.diff', api.toGitUri(target, selection.commit), right, `${selection.entry.name} (${selection.commit.slice(0, 8)}) ↔ ${selection.entry.name}`, { preview: false });
        }
      } catch (error) { await send({ type: 'quick-diff-action-error', error: errorText(error) }); }
      return true;
    }
    if (!['quick-diff-list', 'quick-diff-read'].includes(message.type) || !/^quick-diff-[a-f0-9]{16}-\d{1,15}$/.test(message.requestId) || !Number.isSafeInteger(message.generation)) return true;
    const job = { controller: new AbortController(), published: false }; jobs.set(message.requestId, job);
    const options = { signal: job.controller.signal, requestId: message.requestId, onStatus: progress => { void send({ type: 'quick-diff-progress', requestId: message.requestId, progress }); } };
    try {
      let result;
      if (message.type === 'quick-diff-list') {
        if (typeof message.directory !== 'string' || !validateDirectory(message.directory)) throw new Error('Quick Diff: invalid directory.');
        result = await quick.list(message.directory, message.mode, options);
        if (job.controller.signal.aborted || closed) { quick.release(result.id); return true; }
        const selection = quick.listing(result.id);
        watcher?.dispose(); repositorySubscription?.dispose();
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(result.root, '**/*'));
        watcher.onDidCreate(changed); watcher.onDidChange(changed); watcher.onDidDelete(changed);
        repositorySubscription = selection.repository.state.onDidChange(changed);
      } else {
        const limit = vscode.workspace.getConfiguration('bitfroest').get('files.quickDiffMaxFileSizeMiB', 5);
        result = await quick.read(message.listId, message.path, { ...options, maxBytes: (Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 5) * 1048576,
          render: async content => {
            if (closed || job.controller.signal.aborted) throw Object.assign(new Error('Quick Diff cancelled.'), { name: 'AbortError' });
            let complete; const rendered = new Promise(resolve => { complete = resolve; });
            job.render = complete; job.published = true;
            await send({ type: 'quick-diff-result', requestId: message.requestId, generation: message.generation, ok: true, result: content });
            const ok = await rendered; job.render = null;
            if (!ok) throw new Error('Quick Diff could not be rendered.');
          }
        });
        if (!result.reason && !job.controller.signal.aborted && !closed) views.set(message.requestId, { ...result, listId: message.listId, path: message.path });
      }
      if (!job.controller.signal.aborted && !job.published) await send({ type: 'quick-diff-result', requestId: message.requestId, generation: message.generation, selectedPath: message.selectedPath, ok: true, result });
    } catch (error) {
      if (!job.controller.signal.aborted) await send({ type: 'quick-diff-result', requestId: message.requestId, generation: message.generation, ok: false, error: errorText(error) });
    } finally { jobs.delete(message.requestId); await send({ type: 'quick-diff-finished', requestId: message.requestId }); }
    return true;
  }
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('bitfroest-quick-diff-empty', { provideTextDocumentContent: () => '' }));
  return { handle, reset, dispose() { if (closed) return; closed = true; reset(); subscriptions.forEach(s => s.dispose()); quick.dispose(); void lister.dispose(); } };
}
module.exports = { createQuickDiffHost };
