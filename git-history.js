const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Progress = require('./media/bitfroest-progress');

const validHash = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
function createGitHistory(vscode, context) {
  const sessions = new Set();
  const empty = vscode.workspace.registerTextDocumentContentProvider('bitfroest-history-empty', { provideTextDocumentContent: () => '' });
  function open({ repository, api, target, folder, language }) {
    const english = !String(language).startsWith('de');
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('bitfroestGitHistory', `Git History · ${path.basename(target) || target}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    sessions.add(panel);
    let closed = false, ready = false, generation = 0, selection = 0, selected = null, files = [], commits = new Map(), offset = 0, hasMore = false, loading = false, revision;
    const tasks = new Set(); let taskId = 0;
    const send = value => { if (!closed) return panel.webview.postMessage(value); };
    const text = (de, en) => english ? en : de;
    const serialize = commit => ({ hash: commit.hash, parents: commit.parents.filter(validHash), message: String(commit.message || ''),
      author: String(commit.authorName || ''), email: String(commit.authorEmail || ''), date: commit.authorDate?.toISOString?.() || null });
    const root = repository.rootUri.fsPath;
    const relative = value => {
      const implementation = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
      const result = implementation.relative(root, value).replaceAll('\\', '/');
      if (result === '..' || result.startsWith('../') || implementation.isAbsolute(result)) throw new Error(text('Git-Pfad außerhalb des Repositorys.', 'Git path is outside the repository.'));
      return result;
    };
    relative(target);
    async function run(phase, version, work, publication, current = () => true) {
      const id = `git-history-${++taskId}`;
      const plan = Progress.statusPlan({ id, startedAt: performance.now(), steps: [phase], mode: 'work' });
      tasks.add(plan); plan.start(phase);
      const [queryStep, publishStep] = plan.append(phase, publication ? ['query', 'publication'] : ['query']);
      plan.start(queryStep);
      plan.update(queryStep, Progress.event({ phase, overall: Progress.unknown('requests', 0, 'awaiting-confirmation'), current: Progress.unknown('requests', 0, 'awaiting-confirmation') }));
      const publish = () => { if (version === generation) return send({ type: 'history-activity', generation: version, progress: Progress.readStatus(plan.snapshot()) }); };
      await publish();
      try {
        const result = await work();
        if (closed || version !== generation || !current()) { if (plan.analyze().state === 'running') plan.terminate('cancelled'); return; }
        plan.complete(queryStep);
        if (publication) { plan.start(publishStep); await publication(result); plan.complete(publishStep); }
        plan.complete(phase);
        return result;
      } catch (error) {
        if (plan.analyze().state === 'running') plan.fail(phase, error.message || String(error));
        throw error;
      } finally { tasks.delete(plan); await publish(); }
    }
    async function load(reset) {
      if (closed || loading && !reset || !reset && !hasMore) return;
      if (reset) {
        generation++; selection = 0; selected = null; files = []; commits = new Map(); offset = 0;
        revision = repository.state.HEAD?.commit;
      }
      const version = generation, skip = offset; loading = true;
      try {
        await run('log', version, () => repository.log({ path: target, maxEntries: 101, skip, ...(validHash(revision) ? { refNames: [revision] } : {}) }), async page => {
          if (!Array.isArray(page) || page.some(c => !validHash(c.hash) || !Array.isArray(c.parents))) throw new Error(text('Ungültige Git-Historie.', 'Invalid Git history.'));
          hasMore = page.length > 100;
          const visible = page.slice(0, 100);
          for (const commit of visible) commits.set(commit.hash, commit);
          offset += visible.length;
          await send({ type: 'history-page', generation: version, reset, commits: visible.map(serialize), hasMore });
        });
      } catch (error) { if (version === generation) await send({ type: 'history-error', generation: version, area: 'log', message: error.message }); }
      finally { if (version === generation) loading = false; }
    }
    async function select(message) {
      const commit = commits.get(message.hash);
      if (!commit || !Number.isSafeInteger(message.selection) || message.selection <= selection) return;
      selection = message.selection; selected = commit; files = [];
      const version = generation, chosen = selection;
      try {
        const emptyTree = crypto.createHash(commit.hash.length === 64 ? 'sha256' : 'sha1').update('tree 0\0').digest('hex');
        const parent = commit.parents[0] || emptyTree;
        await run('changes', version, () => commit.parents.length && typeof repository.diffBetweenWithStats === 'function'
          ? repository.diffBetweenWithStats(parent, commit.hash) : repository.diffBetween(parent, commit.hash), async changes => {
          const records = changes.map(change => {
            const original = change.originalUri || change.uri, modified = change.renameUri || change.uri;
            return { change, parent, path: relative(modified.fsPath), originalPath: relative(original.fsPath) };
          });
          files = records;
          await send({ type: 'history-details', generation: version, selection: chosen, commit: serialize(commit), firstParent: commit.parents[0] || null,
            files: records.map(({ change, path: name, originalPath }, index) => ({ index, path: name, originalPath, status: change.status,
              insertions: Number.isSafeInteger(change.insertions) && change.insertions >= 0 ? change.insertions : null,
              deletions: Number.isSafeInteger(change.deletions) && change.deletions >= 0 ? change.deletions : null })) });
        }, () => chosen === selection);
      } catch (error) { if (version === generation && chosen === selection) await send({ type: 'history-error', generation: version, selection: chosen, area: 'changes', message: error.message }); }
    }
    async function diff(message) {
      if (!selected || message.hash !== selected.hash || message.selection !== selection || !Number.isSafeInteger(message.index) || !files[message.index]) return;
      const { change, parent } = files[message.index], commit = selected;
      const emptyUri = vscode.Uri.parse('bitfroest-history-empty:/empty');
      const added = change.status === 1 || !commit.parents.length, deleted = change.status === 2 || change.status === 6;
      const left = added ? emptyUri : api.toGitUri(change.originalUri || change.uri, parent);
      const right = deleted ? emptyUri : api.toGitUri(change.renameUri || change.uri, commit.hash);
      try { await run('diff', generation, () => vscode.commands.executeCommand('vscode.diff', left, right,
        `${files[message.index].path} · ${commit.hash.slice(0, 8)}`, { preview: false })); }
      catch (error) { await send({ type: 'history-error', generation, area: 'diff', message: error.message }); }
    }
    panel.onDidDispose(() => {
      closed = true; generation++;
      for (const plan of tasks) if (plan.analyze().state === 'running') plan.terminate('cancelled');
      sessions.delete(panel); files = []; commits.clear();
    });
    panel.webview.onDidReceiveMessage(async message => {
      if (closed || !message) return;
      if (message.type === 'history-ready') {
        if (ready) return; ready = true;
        await send({ type: 'history-init', english, target, folder, branch: repository.state.HEAD?.name || '',
          notice: text('Pfadhistorie · Dateiliste des gesamten Commits · Merges gegen ersten Elterncommit', 'Path history · All files of the selected commit · Merges compared with first parent') });
        await load(true); return;
      }
      if (!ready) return;
      if (message.type === 'history-refresh') { await load(true); return; }
      if (message.generation !== generation) return;
      if (message.type === 'history-more') await load(false);
      if (message.type === 'history-select') await select(message);
      if (message.type === 'history-diff') await diff(message);
    });
    const nonce = crypto.randomBytes(18).toString('base64');
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'git-history.html').fsPath, 'utf8');
    html = html.replace('<!--POLICY-->', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">`);
    for (const resource of ['git-history.css', 'git-history-model.js', 'git-history.js']) html = html.replaceAll(`"${resource}"`, `"${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, resource))}"`);
    panel.webview.html = html.replaceAll('<script ', `<script nonce="${nonce}" `);
    return panel;
  }
  return { open, dispose() { for (const panel of [...sessions]) panel.dispose(); empty.dispose(); } };
}
module.exports = { createGitHistory };
