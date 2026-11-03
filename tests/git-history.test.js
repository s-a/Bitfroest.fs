const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createGitHistory } = require('../git-history');
const { graphRows } = require('../media/git-history-model');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const hash = n => n.toString(16).padStart(40, '0');
const commit = (n, parents = [hash(n - 1)]) => ({ hash: hash(n), parents, message: `Subject ${n}\n\nDetails <script>literal</script>`, authorName: 'Author', authorEmail: 'a@example.test', authorDate: new Date('2026-01-01T12:00:00Z') });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t, overrides = {}) {
  const panels = [], calls = [], documents = new Map();
  const uri = fsPath => ({ fsPath, scheme: 'file', toString() { return this.fsPath; } });
  const repository = { rootUri: uri('/repo'), state: { HEAD: { commit: hash(200), name: 'main' } },
    log: async options => { calls.push(['log', options]); return [commit(2), commit(1, [])]; },
    diffBetweenWithStats: async (...args) => { calls.push(['changes', ...args]); return [{ uri: uri('/repo/a.txt'), originalUri: uri('/repo/a.txt'), status: 0, insertions: 2, deletions: 1 }]; },
    diffBetween: async (...args) => { calls.push(['root', ...args]); return [{ uri: uri('/repo/first.txt'), originalUri: uri('/repo/first.txt'), status: 1 }]; }, ...overrides };
  const vscode = { Uri: { file: uri, parse: value => ({ scheme: 'bitfroest-history-empty', toString: () => value }), joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) }, ViewColumn: { Active: -1 },
    commands: { executeCommand: async (...args) => { calls.push(['command', ...args]); } },
    workspace: { registerTextDocumentContentProvider: (scheme, provider) => { documents.set(scheme, provider); return { dispose() { documents.delete(scheme); } }; } },
    window: { createWebviewPanel(type, title, column, options) {
      const panel = { type, title, options, messages: [], webview: { cspSource: 'test-resource:', asWebviewUri: value => value.toString(), postMessage: async value => panel.messages.push(value), onDidReceiveMessage: callback => { panel.receive = callback; } },
        onDidDispose: callback => { panel.close = callback; }, dispose() { panel.close(); } }; panels.push(panel); return panel;
    } } };
  const history = createGitHistory(vscode, { extensionUri: uri(path.resolve(__dirname, '..')) }); t.after(() => history.dispose());
  const api = { toGitUri: (value, ref) => ({ ...value, scheme: 'git', ref }) };
  const open = (target = '/repo/a.txt', folder = false, language = 'en') => history.open({ repository, api, target, folder, language });
  return { open, panels, calls, repository, api, documents };
}
test('history panel captures the path, waits for readiness and queries a pinned page without opening a file', async t => {
  const app = fixture(t); app.open(); const panel = app.panels[0];
  assert.equal(panel.type, 'bitfroestGitHistory'); assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/); assert.equal(app.calls.length, 0);
  await panel.receive({ type: 'history-ready' });
  assert.equal(app.calls[0][0], 'log'); assert.equal(app.calls[0][1].path, '/repo/a.txt');
  assert.deepEqual(app.calls[0][1].refNames, [hash(200)]); assert.equal(app.calls[0][1].maxEntries, 101);
  assert.equal(panel.messages.find(m => m.type === 'history-page').commits.length, 2);
  assert.equal(app.calls.some(c => c[0] === 'command'), false);
  await panel.receive({ type: 'history-ready' }); assert.equal(app.calls.filter(c => c[0] === 'log').length, 1);
});
test('pagination retains scope and starting revision and does not impose a total history limit', async t => {
  const pages = [];
  const app = fixture(t, { log: async options => { pages.push(options); return Array.from({ length: options.skip ? 2 : 101 }, (_, i) => commit(300 - options.skip - i)); } });
  app.open('/repo/folder', true); const panel = app.panels[0]; await panel.receive({ type: 'history-ready' });
  app.repository.state.HEAD.commit = hash(999);
  await panel.receive({ type: 'history-more', generation: 1 });
  assert.equal(pages[1].skip, 100); assert.equal(pages[1].path, '/repo/folder'); assert.deepEqual(pages[1].refNames, [hash(200)]);
  const messages = panel.messages.filter(m => m.type === 'history-page'); assert.equal(messages[0].hasMore, true); assert.equal(messages[1].hasMore, false);
});
test('commit selection loads all changed files and rejects unlisted revisions and forged diff requests', async t => {
  const app = fixture(t); app.open('/repo/folder', true); const panel = app.panels[0]; await panel.receive({ type: 'history-ready' });
  await panel.receive({ type: 'history-select', hash: hash(2), selection: 1, generation: 1 });
  const details = panel.messages.find(m => m.type === 'history-details'); assert.equal(details.commit.hash, hash(2)); assert.equal(details.files[0].path, 'a.txt');
  await panel.receive({ type: 'history-diff', hash: hash(2), index: 0, selection: 1, generation: 1 });
  const call = app.calls.find(c => c[0] === 'command'); assert.equal(call[1], 'vscode.diff'); assert.equal(call[2].ref, hash(1)); assert.equal(call[3].ref, hash(2));
  const count = app.calls.length;
  await panel.receive({ type: 'history-select', hash: hash(999), selection: 2, generation: 1 });
  await panel.receive({ type: 'history-diff', hash: hash(2), index: 100, selection: 1, generation: 1 });
  assert.equal(app.calls.length, count);
});
test('late commit responses cannot replace a newer selection or publish after disposal', async t => {
  const old = deferred(); let reads = 0;
  const app = fixture(t, { diffBetweenWithStats: async () => { reads++; return old.promise; } });
  app.open(); const panel = app.panels[0]; await panel.receive({ type: 'history-ready' });
  const pending = panel.receive({ type: 'history-select', hash: hash(2), selection: 1, generation: 1 });
  await panel.receive({ type: 'history-select', hash: hash(1), selection: 2, generation: 1 });
  old.resolve([]); await pending;
  assert.equal(reads, 1); assert.deepEqual(panel.messages.filter(m => m.type === 'history-details').map(m => m.commit.hash), [hash(1)]);
  panel.dispose(); const count = panel.messages.length; await panel.receive({ type: 'history-more', generation: 1 }); assert.equal(panel.messages.length, count);
});

test('refresh discards an older page and query failures finish the planner with a visible error', async t => {
  const old = deferred(); let reads = 0;
  const app = fixture(t, { log: async () => { reads++; if (reads === 1) return old.promise; if (reads === 3) throw new Error('Repository unavailable'); return [commit(3)]; } });
  app.open(); const panel = app.panels[0]; const pending = panel.receive({ type: 'history-ready' });
  await new Promise(resolve => setImmediate(resolve));
  await panel.receive({ type: 'history-refresh' }); old.resolve([commit(2)]); await pending;
  assert.deepEqual(panel.messages.filter(m => m.type === 'history-page').flatMap(m => m.commits.map(c => c.hash)), [hash(3)]);
  await panel.receive({ type: 'history-refresh' });
  assert.equal(panel.messages.find(m => m.type === 'history-error').message, 'Repository unavailable');
  const plans = panel.messages.filter(m => m.type === 'history-activity' && m.generation === 3);
  assert.equal(plans.at(-1).progress.plan.state, 'error');
});
test('root commits use the empty tree and additions, deletions and renames open correct committed sides', async t => {
  for (const status of [1, 2, 3]) {
    const uri = fsPath => ({ fsPath, scheme: 'file' });
    const change = { status, uri: uri('/repo/new.txt'), originalUri: uri('/repo/old.txt'), renameUri: status === 3 ? uri('/repo/new.txt') : undefined };
    const app = fixture(t, { diffBetween: async () => [change], diffBetweenWithStats: async () => [change] }); app.open();
    const panel = app.panels[0]; await panel.receive({ type: 'history-ready' });
    await panel.receive({ type: 'history-select', hash: hash(status === 1 ? 1 : 2), selection: 1, generation: 1 });
    await panel.receive({ type: 'history-diff', hash: hash(status === 1 ? 1 : 2), index: 0, selection: 1, generation: 1 });
    const call = app.calls.find(c => c[0] === 'command'); assert.ok(call);
    if (status === 1) assert.equal(call[2].scheme, 'bitfroest-history-empty');
    if (status === 2) assert.equal(call[3].scheme, 'bitfroest-history-empty');
    if (status === 3) { assert.equal(call[2].fsPath, '/repo/old.txt'); assert.equal(call[3].fsPath, '/repo/new.txt'); }
  }
});
test('graph preserves merge parents and does not invent links between unrelated filtered commits', () => {
  const rows = graphRows([commit(9, [hash(7), hash(8)]), commit(8, [hash(6)]), commit(7, [hash(6)]), commit(6, [])]);
  assert.equal(rows[0].parents.length, 2); assert.equal(rows[3].hash, hash(6));
  const filtered = graphRows([commit(9, [hash(8)]), commit(3, [])]);
  assert.notEqual(filtered[0].parents[0].hash, filtered[1].hash);
  assert.equal(filtered[0].incoming, false);
  assert.equal(filtered[0].edges[0].external, true);
  assert.equal(filtered[1].lane, 0);
});

test('the computed empty tree compares a real initial commit without creating tree objects', async t => {
  const os = require('node:os'), fsp = require('node:fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-history-root-')); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config') } }).trim();
  git('init', '-q'); await fsp.writeFile(path.join(root, 'first.txt'), 'FIRST'); git('add', '--', 'first.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'First');
  const empty = crypto.createHash('sha1').update('tree 0\0').digest('hex');
  assert.equal(git('diff', '--name-status', empty, 'HEAD'), 'A\tfirst.txt');
});
test('actual history HTML selects commits safely with keyboard, resizes panes and opens files with Enter', async t => {
  const app = fixture(t); app.open('/repo', true, 'de'); const panel = app.panels[0]; await panel.receive({ type: 'history-ready' });
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' }); t.after(() => dom.window.close()); const messages = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: m => messages.push(m) });
  for (const file of ['git-history-model.js', 'git-history.js']) new vm.Script(fs.readFileSync(path.join(__dirname, '../media', file), 'utf8')).runInContext(dom.getInternalVMContext());
  const send = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  for (const data of panel.messages) send(data);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('[data-commit]').length, 2); assert.equal(doc.querySelectorAll('input, select, footer button').length, 0);
  const selection = messages.find(m => m.type === 'history-select'); assert.ok(selection); await panel.receive(selection);
  send(panel.messages.filter(m => m.type === 'history-details').at(-1));
  assert.match(doc.querySelector('#message').textContent, /<script>literal<\/script>/); assert.equal(doc.querySelector('#message script'), null);
  const row = doc.querySelector('[data-file]'); row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(row.getAttribute('aria-selected'), 'true');
  row.focus(); row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(messages.at(-1).type, 'history-diff');
  const separator = doc.querySelector('[role="separator"]'); const before = separator.getAttribute('aria-valuenow');
  separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); assert.notEqual(separator.getAttribute('aria-valuenow'), before);
  const first = doc.querySelector('[data-commit]'); first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); assert.equal(messages.at(-1).hash, hash(1));
});
