const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'extension.js');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('settings and shortcut commands share the existing configuration panel', async t => {
  const app = harness(t);
  await app.command('bitfroest.configureSettings');
  const settings = app.panels.at(-1);
  await settings.receive({ type: 'configuration-ready' });
  assert.equal(settings.messages.at(-1).section, 'settings');
  assert.ok(settings.messages.at(-1).settings.length > 0);
  await app.command('bitfroest.configureShortcuts');
  assert.equal(app.panels.length, 1);
  assert.equal(app.panels.at(-1), settings);
  assert.equal(settings.messages.at(-1).type, 'configuration-section');
  assert.equal(settings.messages.at(-1).section, 'shortcuts');
});

test('custom shortcut execution is validated against persisted binding, live focus and readiness', async t => {
  const { catalog } = require('../shortcut-settings');
  const copy = catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
  const app = harness(t, { configuration: { 'shortcuts.bindings': { [copy.id]: 'ctrl+shift+k' } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  panel.active = true;
  await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'inputFocus', list: true });
  const count = () => panel.messages.filter(message => message.type === 'action' && message.action === 'copy').length;
  const before = count();
  await panel.receive({ type: 'shortcut-execute', id: copy.id, key: 'ctrl+shift+k' }); assert.equal(count(), before + 1);
  assert.equal(app.contexts.get(`bitfroest.shortcutOverride.${copy.id}`), true);
  await panel.receive({ type: 'shortcut-execute', id: copy.id, key: 'f6' }); assert.equal(count(), before + 1);
  await panel.receive({ type: 'inputFocus', value: true });
  await panel.receive({ type: 'shortcut-execute', id: copy.id, key: 'ctrl+shift+k' }); assert.equal(count(), before + 1);
});

test('rapid external shortcut changes cannot leave obsolete host guards enabled', async t => {
  const { catalog } = require('../shortcut-settings');
  const copy = catalog.find(item => item.command === 'bitfroest.copy' && item.key === 'f5');
  const entered = deferred(), release = deferred(), configuration = {};
  const app = harness(t, { configuration, commandEffect: async (id, args) => {
    if (id === 'setContext' && args[0] === `bitfroest.shortcutOverride.${copy.id}` && args[1]) { entered.resolve(); await release.promise; }
  } });
  await app.command('bitfroest.openPrototype');
  configuration['shortcuts.bindings'] = { [copy.id]: 'ctrl+shift+k' };
  const first = app.configuration('bitfroest.shortcuts'); await entered.promise;
  configuration['shortcuts.bindings'] = {};
  const second = app.configuration('bitfroest.shortcuts'); release.resolve();
  await Promise.all([first, second]);
  assert.equal(app.contexts.get(`bitfroest.shortcutOverride.${copy.id}`), false);
  assert.deepEqual(app.panels[0].messages.filter(message => message.type === 'shortcut-settings').at(-1).bindings, {});
});

test('ignored badges are requested by default and retain the explicit setting to turn them off', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let observed;
  const configuration = {};
  const app = harness(t, { configuration, filesystemLoad: async () => initial,
    gitInspect: async (directories, settings) => { observed = settings.showIgnored; return Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, statuses: { 'a.txt': 'ignored' } }])); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  await panel.receive(view.messages.find(message => message.type === 'git-status'));
  assert.equal(observed, true);
  const result = panel.messages.filter(message => message.type === 'git-status-result').at(-1);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.ok(view.row('a.txt').querySelector('svg.bi-slash-circle-fill'));
  configuration['gitStatus.showIgnored'] = false;
  await app.configuration('bitfroest.gitStatus');
  await panel.receive({ ...view.messages.find(message => message.type === 'git-status'), requestId: 'ignored-off' });
  assert.equal(observed, false);
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties));
  assert.equal(properties['bitfroest.gitStatus.showIgnored'].default, true);
  panel.dispose();
});

test('Bootstrap overlay size reaches generated HTML and updates without clearing current Git status', async t => {
  const configuration = { 'gitStatus.iconSizePercent': 66 };
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { configuration, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*git-status-icons.js"/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.equal(JSON.parse(decodeURIComponent(view.document.body.dataset.fileSettings)).gitStatus.iconSizePercent, 66);
  configuration['gitStatus.iconSizePercent'] = 80;
  await app.configuration(['bitfroest.gitStatus', 'bitfroest.gitStatus.iconSizePercent']);
  assert.equal(panel.messages.filter(message => message.type === 'file-settings').at(-1).settings.gitStatus.iconSizePercent, 80);
  assert.equal(panel.messages.some(message => message.type === 'git-settings-changed'), false);
  panel.dispose();
});

test('host publishes the complete catalog defaults when no custom file colors are configured', async t => {
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const defaults = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties))['bitfroest.colors.rules'].default;
  const app = harness(t, { configurationDefaults: { 'colors.rules': defaults }, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const settings = JSON.parse(decodeURIComponent(view.document.body.dataset.fileSettings));
  assert.deepEqual(settings.colors.rules, defaults);
  assert.ok(settings.colors.rules['*.xlsx']);
  assert.equal(app.updateCalls.some(call => call.store === 'configuration'), false);
  panel.dispose();
});

test('file colors reach actual host HTML and native configuration changes reach the existing view', async t => {
  const configuration = { 'colors.fileTypes': true, 'colors.gitStatus': true, 'colors.rules': { '*.txt': '#ffffff' } };
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { configuration, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*commander-file-colors.js"/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const parsed = JSON.parse(decodeURIComponent(view.document.body.dataset.fileSettings));
  assert.deepEqual(parsed.colors.rules, { '*.txt': '#ffffff' });
  configuration['colors.fileTypes'] = false;
  await app.configuration('bitfroest.colors');
  assert.equal(panel.messages.filter(message => message.type === 'file-settings').at(-1).settings.colors.enabled, false);
  panel.dispose();
});

function clipboardFixture() {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null });
  return { version: 1, realFilesystem: true, snapshotId: 'clipboard', active: 0, panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', fsSource: 'C:/tmp/a.txt' }], 'C:/temp': [] } };
}

test('error details copy passes through actual host HTML to the public clipboard API', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /img-src [^;]+ data:;/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html, language: 'de' });
  view.action('mkdir');
  view.document.querySelector('#value').value = 'new';
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  const error = "EPERM: operation not permitted, lstat 'C:\\DumpStack.log.tmp'\nC:\\Recovery\\Ä.stage";
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: initial, error } }));
  const illustration = view.document.querySelector('.operation-error img');
  assert.ok(illustration);
  assert.match(illustration.src, /error-monkey\.png$/);
  assert.notEqual(illustration.getAttribute('src'), 'error-monkey.png', 'host resolves the packaged image URI');
  assert.equal(view.document.querySelector('.operation-error details').open, false);
  view.click(view.document.querySelector('[data-copy-error]'));
  const request = view.messages.find(message => message.type === 'selection-io');
  await panel.receive(request);
  assert.deepEqual(app.clipboardCalls.at(-1), { action: 'writeText', text: 'Dateioperation fehlgeschlagen\n\n' + error });
  const response = panel.messages.find(message => message.type === 'selection-io-result' && message.requestId === request.requestId);
  assert.equal(response.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
  assert.ok(view.document.querySelector('.operation-error-text').value.endsWith(error));
  assert.equal(view.document.querySelector('#status-message').textContent, 'Fehlerdetails kopiert.');
  panel.dispose();
});

test('selection text requests pass through the actual host HTML and public clipboard API', async t => {
  const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.action('copy-names');
  const request = view.messages.find(message => message.type === 'selection-io'); assert.ok(request);
  await panel.receive(request);
  assert.deepEqual(app.clipboardCalls.at(-1), { action: 'writeText', text: 'a.txt' });
  assert.ok(panel.messages.some(message => message.type === 'selection-io-result' && message.requestId === request.requestId && message.ok));
  const before = app.clipboardCalls.length;
  await panel.receive({ ...request, requestId: '../bad' });
  await panel.receive({ ...request, action: 'copy', text: {} });
  assert.equal(app.clipboardCalls.length, before);
  panel.dispose();
});

test('path clipboard resolves host path ranges from real HTML while preserving detail cells', async t => {
  const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let seen;
  const app = harness(t, { filesystemLoad: async () => initial, resolveUncPaths: async paths => { seen = paths; return ['\\\\files\\team\\a.txt']; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.action('copy-full-details'); const request = view.messages.find(message => message.type === 'selection-io');
  await panel.receive(request);
  assert.deepEqual(Array.from(seen), ['C:\\tmp\\a.txt']);
  assert.equal(app.clipboardCalls.at(-1).text, request.text.replace('C:\\tmp\\a.txt', '\\\\files\\team\\a.txt'));
  assert.ok(panel.messages.some(message => message.type === 'selection-io-result' && message.ok));
  panel.dispose();
});

test('panel disposal during UNC resolution prevents delayed clipboard writes', async t => {
  const initial = clipboardFixture(); let finish;
  const app = harness(t, { filesystemLoad: async () => initial, resolveUncPaths: () => new Promise(resolve => { finish = resolve; }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'selection-io', requestId: 'selection-42', action: 'copy', text: 'Z:\\a.txt', pathRanges: [{ start: 0, length: 8 }] });
  assert.equal(typeof finish, 'function'); panel.dispose(); finish(['\\\\files\\team\\a.txt']);
  await pending;
  assert.equal(app.clipboardCalls.length, 0);
});
test('native editor action reports a correlated completion only after the editor result', async t => {
  for (const fail of [false, true]) {
    const initial = clipboardFixture(); initial.panes[0].selected = ['a'];
    initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
    const app = harness(t, { filesystemLoad: async () => initial, ...(fail ? { documentError: 'Editor failed', showErrorMessage: () => new Promise(() => {}) } : {}) });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
    view.action('edit'); const request = view.messages.find(message => message.type === 'edit'); assert.ok(request);
    assert.match(request.requestId, /^ui-action-\d+$/);
    assert.equal(view.document.querySelector('#status-message').dataset.outcome, 'info');
    await panel.receive(request);
    const reply = panel.messages.find(message => message.type === 'ui-action-result' && message.requestId === request.requestId); assert.ok(reply);
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
    assert.equal(view.document.querySelector('#status-message').dataset.outcome, fail ? 'error' : 'success');
    panel.dispose();
  }
});

test('Git host uses generated HTML, deduplicates trusted directories and opens a branch list', async t => {
  let inspected, branchPath, disposed = 0;
  const initial = clipboardFixture(); initial.panes[1] = structuredClone(initial.panes[0]);
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: async directories => { inspected = directories; return { 'C:/tmp': { ok: true, repository: true, branch: 'main', statuses: { 'a.txt': 'modified' } } }; },
    gitBranches: async directory => { branchPath = directory; return { ok: true, names: ['feature/one', 'main', 'second'], remoteNames: ['origin/main'], count: 3, otherCount: 2, branch: 'main' }; }, gitDispose: () => disposed++ });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const request = view.messages.find(message => message.type === 'git-status'); assert.ok(request);
  await panel.receive(request); assert.deepEqual(inspected, ['C:/tmp']);
  const result = panel.messages.find(message => message.type === 'git-status-result'); assert.ok(result);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.equal(view.document.querySelector('[data-git-branch]').textContent, '(main)');
  view.click(view.document.querySelector('[data-git-branch]'));
  await panel.receive(view.messages.find(message => message.type === 'git-branches'));
  assert.equal(branchPath, 'C:/tmp');
  const pick = app.quickPicks.at(-1); assert.ok(pick);
  assert.deepEqual(Array.from(pick.items, item => item.label), ['main', 'feature/one', 'second', 'origin/main']);
  assert.equal(pick.items[0].description, 'Aktueller Branch');
  assert.equal(pick.items.at(-1).description, 'Remote-Branch');
  assert.equal(app.information.length, 0);
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp');
  await panel.receive({ type: 'git-status', requestId: 'invalid', snapshotId: initial.snapshotId, directories: ['C:/private'] });
  assert.deepEqual(inspected, ['C:/tmp']); panel.dispose(); assert.equal(disposed, 1);
});

test('Git host ignores status work completed after panel disposal', async t => {
  const work = deferred(); let started = false;
  const initial = clipboardFixture(), app = harness(t, { filesystemLoad: async () => initial, gitInspect: () => { started = true; return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'git-status', requestId: 'late', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  assert.equal(started, true); panel.dispose(); work.resolve({}); await pending;
  assert.equal(panel.messages.some(message => message.type === 'git-status-result'), false);
});

test('Git host never queues navigation behind a pending status calculation', async t => {
  const initial = clipboardFixture(), work = deferred();
  initial.folders['C:/tmp/next'] = [];
  const app = harness(t, { filesystemLoad: async () => initial, gitInspect: () => work.promise,
    filesystemPrepare: async before => ({ ...before, snapshotId: 'navigated' }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'git-status', requestId: 'slow', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  await panel.receive({ type: 'filesystem-navigate', path: 'C:/tmp/next', side: 0, state: initial });
  assert.equal(panel.messages.find(message => message.type === 'filesystem-result')?.resumeNavigation.path, 'C:/tmp/next');
  work.resolve({}); await pending;
  assert.equal(panel.messages.some(message => message.type === 'git-status-result'), false); panel.dispose();
});

test('Git host keeps the unchanged right status pending across left navigation without querying it again', async t => {
  const initial = clipboardFixture(), first = deferred(), second = deferred(), calls = [];
  initial.folders['C:/tmp/next'] = [];
  let initialProgress;
  const app = harness(t, { filesystemLoad: async () => initial,
    filesystemPrepare: async before => ({ ...before, snapshotId: 'navigated' }),
    gitInspect: (directories, _settings, _creation, onProgress) => {
      calls.push(directories);
      if (calls.length === 1) { initialProgress = onProgress; return first.promise; }
      return second.promise;
    }
  });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const initialRequest = panel.receive({ type: 'git-status', requestId: 'both', snapshotId: initial.snapshotId, directories: ['C:/tmp', 'C:/temp'] });
  await panel.receive({ type: 'filesystem-navigate', side: 0, path: 'C:/tmp/next', state: initial });
  const nextRequest = panel.receive({ type: 'git-status', requestId: 'left', snapshotId: 'navigated', directories: ['C:/tmp/next'], visibleDirectories: ['C:/tmp/next', 'C:/temp'] });
  initialProgress({ 'C:/temp': { ok: true, repository: true, branch: 'right', loading: true, statuses: {} }, 'C:/tmp': { ok: true, repository: true, branch: 'stale-left', statuses: {} } });
  const progress = panel.messages.filter(message => message.type === 'git-status-result' && message.partial).at(-1);
  assert.ok(progress);
  assert.deepEqual(Object.keys(progress.directories), ['C:/temp']);
  first.resolve({ 'C:/temp': { ok: true, repository: true, branch: 'right', statuses: {} }, 'C:/tmp': { ok: true, repository: true, branch: 'stale-left', statuses: {} } });
  await initialRequest;
  assert.deepEqual(calls, [['C:/tmp', 'C:/temp'], ['C:/tmp/next']]);
  const final = panel.messages.filter(message => message.type === 'git-status-result' && !message.partial && message.requestId === 'both').at(-1);
  assert.deepEqual(Object.keys(final.directories), ['C:/temp']);
  second.resolve({}); await nextRequest; panel.dispose();
});

test('Git host drops a late branch count after navigation with the same snapshot', async t => {
  const initial = clipboardFixture(), work = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, gitBranches: () => work.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'first', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  const pending = panel.receive({ type: 'git-branches', path: 'C:/tmp', snapshotId: initial.snapshotId });
  await panel.receive({ type: 'git-status', requestId: 'next', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  work.resolve({ ok: true, count: 3, otherCount: 2 }); await pending;
  assert.equal(app.information.length, 0); assert.equal(app.quickPicks.length, 0); panel.dispose();
});

test('Git host defers hidden-panel updates and refreshes when the panel becomes visible', async t => {
  const initial = clipboardFixture(); let inspected = 0, observer;
  const app = harness(t, { filesystemLoad: async () => initial, gitInspect: async (_directories, _settings, creation) => { inspected++; observer = creation; return {}; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'visible', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  assert.equal(observer.onChange, undefined, 'no filesystem change subscription is configured');
  panel.changeVisibility(false); await tick(); assert.equal(inspected, 1);
  panel.changeVisibility(true); await tick(); assert.equal(inspected, 2); panel.dispose();
});

test('Git host drops a late branch error after navigation', async t => {
  const initial = clipboardFixture(), work = deferred();
  const app = harness(t, { filesystemLoad: async () => initial, gitBranches: () => work.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'git-status', requestId: 'before', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  const pending = panel.receive({ type: 'git-branches', path: 'C:/tmp', snapshotId: initial.snapshotId });
  await panel.receive({ type: 'git-status', requestId: 'after', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  work.reject(new Error('Old repository unavailable')); await pending;
  assert.deepEqual(app.errors, []); panel.dispose();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, options = {}) {
  const commands = new Map(), calls = [], panels = [], errors = [], information = [], contexts = new Map();
  const textDocuments = [], textEditors = [], quickPicks = [], nativeCalls = [], updateCalls = [];
  const deleteCalls = [];
  const documentProviders = new Map();
  const clipboardCalls = [];
  const readonlyPaths = [];
  const trashCalls = [];
  const shellCalls = [], shellDisposals = [], openCalls = [];
  let providerOptions;
  const choices = [...(options.choices || [])];
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: options.platform || 'win32', configurable: true });
  const disposable = () => ({ dispose() {} });
  const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath.replace(/\\/g, '/')}` });
  function memento(name, initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
      values,
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) {
        updateCalls.push({ store: name, key, value });
        if (options.update) await options.update(name, key, value);
        values.set(key, value);
      }
    };
  }
  const context = {
    subscriptions: [], extensionUri: { ...uri(root), scheme: options.extensionScheme || 'file' }, extensionPath: root,
    extension: { extensionKind: options.extensionKind || 1 },
    globalStorageUri: uri(path.join(root, 'storage')),
    extensionMode: options.development ? 2 : 1,
    workspaceState: memento('workspace', options.workspaceState),
    globalState: memento('global', options.globalState)
  };
  let configurationListener, saveDocumentListener, closeDocumentListener;
  let status, serializer;
  const tabGroups = [], tabListeners = new Set(), groupListeners = new Set();
  const vscode = {
    env: { language: options.language || 'de', remoteName: options.remoteName, openExternal: async uri => { calls.push({ id: 'openExternal', args: [uri.toString()] }); return true; }, clipboard: { writeText: async text => { clipboardCalls.push({ action: 'writeText', text }); }, readText: async () => { clipboardCalls.push({ action: 'readText' }); if (options.readClipboardText) return options.readClipboardText(); return options.clipboardText || ''; } } },
    ExtensionKind: { UI: 1, Workspace: 2 },
    Uri: { parse: value => ({ toString: () => value }), file: uri, joinPath: (base, ...parts) => uri(path.resolve(base.fsPath, ...parts)) },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Right: 2 }, ViewColumn: { Active: -1, Beside: -2, One: 1 }, ExtensionMode: { Development: 2 },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return disposable(); },
      async executeCommand(id, ...args) {
        calls.push({ id, args });
        if (id === 'setContext') contexts.set(args[0], args[1]);
        if (options.commandError === id) throw new Error(`Command failed: ${id}`);
        if (options.commandEffect) await options.commandEffect(id, args, panels);
        if (commands.has(id)) return commands.get(id)(...args);
      }
    },
    workspace: {
      onDidSaveTextDocument(listener) { saveDocumentListener = listener; return disposable(); },
      onDidCloseTextDocument(listener) { closeDocumentListener = listener; return disposable(); },
      registerTextDocumentContentProvider(scheme, provider) { documentProviders.set(scheme, provider); return { dispose() { documentProviders.delete(scheme); } }; },
      fs: { delete: async (uri, deleteOptions) => { deleteCalls.push({ uri, options: deleteOptions }); if (options.deleteError) throw new Error(options.deleteError); } },
      getConfiguration: () => ({ get: key => {
        if (!options.configurationScopes?.[key]) return options.configuration?.[key] ?? options.configurationDefaults?.[key];
        const { globalValue, workspaceValue } = options.configurationScopes[key];
        return globalValue && workspaceValue && !Array.isArray(globalValue) ? { ...globalValue, ...workspaceValue } : workspaceValue ?? globalValue;
      }, inspect: key => options.configurationScopes?.[key] || ({ defaultValue: options.configurationDefaults?.[key], workspaceValue: options.configuration?.[key] }), async update(key, value, target) { options.configuration ||= {}; options.configuration[key] = value; if (options.configurationScopes) { options.configurationScopes[key] ||= {}; options.configurationScopes[key][target === 1 ? 'globalValue' : 'workspaceValue'] = value; } updateCalls.push({ store: 'configuration', key, value, target }); } }),
      workspaceFolders: options.noWorkspace ? undefined : [{ uri: { ...uri(path.join(root, 'workspace')), scheme: options.workspaceScheme || 'file' } }],
      onDidChangeConfiguration(listener) { configurationListener = listener; return disposable(); },
      async openTextDocument(definition) {
        const document = { ...definition, uri: definition.fsPath ? definition : uri(`/untitled-${textDocuments.length + 1}`) };
        textDocuments.push(document); if (options.documentError) throw new Error(options.documentError); return document;
      }
    },
    window: {
      tabGroups: {
        all: tabGroups,
        onDidChangeTabs(listener) { tabListeners.add(listener); return { dispose: () => tabListeners.delete(listener) }; },
        onDidChangeTabGroups(listener) { groupListeners.add(listener); return { dispose: () => groupListeners.delete(listener) }; }
      },
      registerWebviewPanelSerializer(viewType, value) {
        assert.equal(viewType, 'bitfroestPrototype'); serializer = value; return disposable();
      },
      createStatusBarItem(alignment, priority) {
        status = { alignment, priority, shown: false, text: '', show() { this.shown = true; }, ...disposable() };
        return status;
      },
      createWebviewPanel(viewType, title, column, panelOptions) {
        const disposeListeners = [];
        let viewListener, messageListener;
        const panel = {
          viewType, title, viewColumn: 3, column, panelOptions, visible: true, disposed: false, reveals: 0, messages: [],
          reveal() { this.reveals++; this.visible = true; viewListener?.(); },
          dispose() { if (!this.disposed) { this.disposed = true; this.visible = false; for (const listener of disposeListeners) listener(); } },
          onDidDispose(listener) { disposeListeners.push(listener); return disposable(); },
          onDidChangeViewState(listener) { viewListener = listener; return disposable(); },
          changeVisibility(value) { this.visible = value; viewListener?.(); },
          receive(message) { return messageListener(message); },
          webview: {
            cspSource: 'webview-resource:', html: '',
            asWebviewUri: value => ({ toString: () => `webview-resource:${value.fsPath}` }),
            onDidReceiveMessage(listener) { messageListener = listener; return disposable(); },
            async postMessage(message) { panel.messages.push(message); return true; }
          }
        };
        tabGroups.push({ viewColumn: panel.viewColumn, tabs: [{ input: { viewType } }] });
        panels.push(panel); return panel;
      },
      async showErrorMessage(message) { errors.push(message); if (options.showErrorMessage) return options.showErrorMessage(message); },
      async showWarningMessage(message) { errors.push(message); },
      async showInformationMessage(message) { information.push(message); },
      async showInputBox() { return options.inputResults?.shift(); },
      async showTextDocument(document, editorOptions) { textEditors.push({ document, options: editorOptions }); return {}; },
      async showQuickPick(items, pickOptions) {
        quickPicks.push({ items, options: pickOptions });
        const choice = choices.shift();
        return choice === undefined ? undefined : items.find(item => item.value === choice);
      }
    }
  };
  const native = titleToken => {
    nativeCalls.push({ operation: 'windows.maximize', titleToken });
    return new Promise((resolve, reject) => {
      const callback = error => error ? reject(error) : resolve({ maximized: true });
      if (options.native) options.native(callback);
      else callback(options.nativeError ? new Error(options.nativeError) : null);
    });
  };
  let themeCalls = 0;
  const icons = { roots: [uri(path.join(root, 'theme'))], associations: { base: { file: 'theme-icon-0' } }, css: () => '.theme-icon-0{color:red}' };
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === extensionPath) {
      if (request === 'vscode') return vscode;
      if (request === './open-terminal') return { openTerminal: async target => { if (options.terminalOpen) return options.terminalOpen(target); throw new Error('Terminal unavailable'); } };
      if (request === './license-information' && options.licenseOpenError) return { createLicenseInformation: () => ({ dispose() {}, async open() { throw new Error(options.licenseOpenError); } }) };
      if (request === './network-paths') return { resolveUncPaths: options.resolveUncPaths || (async paths => paths) };
      if (request === './lock-inspector') return { createLockInspector: () => ({ open: folder => options.lockInspectorOpen?.(folder), dispose() {} }) };
      if (request === './open-file') return { openAssociatedFile: async target => { openCalls.push(target); if (options.openError) throw new Error(options.openError); return { editor: Boolean(options.associatedEditor) }; } };
      if (request === './search-provider' && options.searchRoots) return { createSearchProvider: args => require('../search-provider').createSearchProvider({ ...args, roots: options.searchRoots }) };
      if (request === './icon-theme') return { loadIconTheme: async () => { themeCalls++; return options.theme ? options.theme(themeCalls, icons) : icons; } };
      if (request === './native-window') return { maximizeWindow: native };
      if (request === 'node:child_process') throw new Error('Window setup must use the native module.');
      if (request === './filesystem-icons') return { getFilesystemIcons: async requests => options.filesystemIcons ? options.filesystemIcons(requests) : {} };
      if (request === './git-status-provider' && !options.realGitProvider) return { createGitStatusProvider: creation => ({
        inspect: async (directories, settings, onProgress) => options.gitInspect ? options.gitInspect(directories, settings, creation, onProgress) : {},
        branches: async directory => options.gitBranches ? options.gitBranches(directory) : { ok: true, count: 0, otherCount: 0 },
        dispose() { options.gitDispose?.(); }
      }) };
      if (request === './open-trash') return { openTrash: async () => { trashCalls.push('open'); if (options.trashOpen) return options.trashOpen(); if (options.trashError) throw new Error(options.trashError); return { requested: true }; } };
      if (request === './native-shell-menu') return { createShellMenuProvider: configuration => ({
        async show(paths, settings) { shellCalls.push({ paths, settings, configuration }); return options.shellMenuShow ? options.shellMenuShow(paths, settings) : { ok: true, displayed: true, invoked: false, cancelled: true }; },
        dispose() { shellDisposals.push(true); }
      }) };
      if (request === './readonly-files') return { createReadonlyResources: () => ({ async createUri(original) { if (options.readonlyError) throw new Error(options.readonlyError); readonlyPaths.push(original); return { scheme: 'bitfroest-conflict', path: `/snapshot-${readonlyPaths.length}/${path.posix.basename(original)}`, toString() { return `bitfroest-conflict:${this.path}`; } }; }, dispose() {} }) };
      if (request === './clipboard-provider') return { createClipboardProvider: () => ({
        read: async () => { clipboardCalls.push({ action: 'read' }); return options.clipboardSelection || null; },
        write: async selection => { clipboardCalls.push({ action: 'write', selection }); if (options.clipboardError) throw new Error(options.clipboardError); return { ...selection, token: 'clip-1', source: 'system' }; },
        ack: async selection => { clipboardCalls.push({ action: 'ack', selection }); return true; }
      }) };
      if (request === './startup-paths') return { selectStartupRoots: preferred => options.startupRoots || preferred, existingDirectories: directories => directories.filter(value => !options.missingDirectories?.includes(value)) };
      if (request === './filesystem-provider') return { createProvider: creation => { providerOptions = creation; return ({
        load: async optionsForLoad => options.filesystemLoad ? options.filesystemLoad(optionsForLoad) : null,
        prepare: async (before, preparation) => options.filesystemPrepare ? options.filesystemPrepare(before, preparation) : before,
        measureFolder: async (before, directory, settings) => options.measureFolder(before, directory, settings),
        apply: async (before, after, operation) => options.filesystemApply ? options.filesystemApply(before, after, operation) : after,
        remove: async (before, request) => options.filesystemRemove ? options.filesystemRemove(before, request, providerOptions) : before,
        contains: target => options.containsPath ? options.containsPath(target) : /^C:\/(tmp|temp)(\/|$)/i.test(target)
      }); } };
    }
    return load.call(this, request, parent, isMain);
  };
  let extension;
  try {
    delete require.cache[extensionPath];
    extension = require(extensionPath);
  } finally { Module._load = load; }
  t.after(() => { Object.defineProperty(process, 'platform', originalPlatform); delete require.cache[extensionPath]; });
  extension.activate(context);
  return {
    context, commands, calls, panels, errors, information, contexts, textDocuments, textEditors, quickPicks, nativeCalls, updateCalls, deleteCalls, clipboardCalls, readonlyPaths, trashCalls, shellCalls, shellDisposals, openCalls, documentProviders,
    get status() { return status; },
    get serializer() { return serializer; },
    tabGroups,
    tabsChanged: () => { for (const listener of tabListeners) listener({}); },
    groupsChanged: () => { for (const listener of groupListeners) listener({}); },
    restoredPanel: () => vscode.window.createWebviewPanel('bitfroestPrototype', 'Restored', 3, {}),
    get providerOptions() { return providerOptions; },
    command: async (id, ...args) => { const result = await vscode.commands.executeCommand(id, ...args); if (id === 'bitfroest.openPrototype' && !options.manualReadiness && panels.at(-1) && !panels.at(-1).disposed) await panels.at(-1).receive({ type: 'app-ready' }); return result; },
    configuration: affects => configurationListener({ affectsConfiguration: key => Array.isArray(affects) ? affects.includes(key) : key === affects }),
    saveDocument: document => saveDocumentListener(document),
    closeDocument: document => closeDocumentListener(document)
  };
}

test('ZIP host opens metadata and copies selection through the generated host protocol', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'), target = path.join(root, 'out').replaceAll('\\', '/');
  fs.mkdirSync(target); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'hello' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'archive', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(result?.ok, true); assert.ok(result.resumeNavigation.path.startsWith('zip:'));
  const sourcePath = result.resumeNavigation.path;
  await panel.receive({ type: 'zip-copy', path: sourcePath, ids: [result.state.folders[sourcePath][0].id], target, operationId: 'zip-host-copy', state: result.state });
  assert.equal(panel.messages.filter(message => message.type === 'filesystem-result').at(-1).ok, true, JSON.stringify(panel.messages.at(-1)));
  assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'hello');
  assert.equal(panel.messages.filter(message => message.type === 'filesystem-result').at(-1).ok, true);
});

test('ZIP pack host confirms an existing normalized target through a native choice', async t => {
  for (const choice of ['update', 'cancel']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-existing-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'file.txt').replaceAll('\\', '/'), archive = path.join(root, 'result.zip').replaceAll('\\', '/');
    fs.writeFileSync(source, 'new'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'keep.txt': 'keep' }));
    const before = fs.readFileSync(archive), initial = clipboardFixture();
    initial.folders['C:/tmp'] = [{ id: 'file', name: 'file.txt', type: 'text', fsSource: source }];
    const app = harness(t, { choices: [choice], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['file'], archive: archive.slice(0, -4), operationId: 'zip-existing', state: initial });
    const pick = app.quickPicks.at(-1); assert.ok(pick);
    assert.equal(pick.options.title, 'Archiv bereits vorhanden');
    assert.equal(pick.options.placeHolder.replaceAll('\\', '/'), archive);
    assert.deepEqual(pick.items.map(item => item.value), ['update', 'cancel']);
    const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
    assert.equal(result.ok, true);
    if (choice === 'cancel') { assert.equal(result.cancelled, true); assert.deepEqual(fs.readFileSync(archive), before); }
    else {
      const z = require('@zip.js/zip.js'), reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive)));
      assert.deepEqual((await reader.getEntries()).map(entry => entry.filename).sort(), ['file.txt', 'keep.txt']); await reader.close();
    }
    assert.equal(fs.readFileSync(source, 'utf8'), 'new');
    assert.equal(fs.existsSync(archive.slice(0, -4)), false); panel.dispose();
  }
});

test('ZIP host bounds intermediate progress, forwards phase changes and flushes the latest file before completion', async t => {
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem;
  let report;
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), writeArchive: async (_state, _request, settings) => {
    report = settings.onProgress;
    for (const phase of ['packing', 'verifying']) for (let n = 0; n < 1000; n++) report({ phase, currentPath: `${n}.txt`, completedBytes: n, totalBytes: 2000 });
  } });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const initial = clipboardFixture();
  for (const pane of initial.panes) Object.assign(pane, { filter: '', sort: 'name' });
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.click(view.row('a.txt')); view.action('pack');
  view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = view.messages.find(message => message.type === 'zip-write'); assert.ok(request);
  await panel.receive(request);
  const messages = panel.messages.filter(message => message.type === 'filesystem-progress');
  assert.ok(messages.length <= 6, `unbounded ZIP progress messages: ${messages.length}`);
  assert.equal(messages[0].progress.phase, 'packing');
  assert.ok(messages.some(message => message.progress.phase === 'verifying' && message.progress.currentPath === '0.txt'));
  assert.equal(messages.at(-1).progress.currentPath, '999.txt');
  const refreshed = panel.messages.find(message => message.type === 'filesystem-result').refreshGitDirectories;
  assert.equal(refreshed?.length, 1);
  assert.ok(request.archive.startsWith(refreshed[0] + '/'));
  for (const message of messages) view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
  assert.equal(view.document.querySelector('#status-message').textContent, 'Archiv prüfen: 999.txt');
  const lastProgress = panel.messages.lastIndexOf(messages.at(-1));
  assert.ok(panel.messages.findIndex((message, index) => index > lastProgress && message.type === 'filesystem-result' && message.ok) > lastProgress, JSON.stringify(panel.messages.at(-1)));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.find(message => message.type === 'filesystem-result' && message.operationId === request.operationId) }));
  assert.equal(view.document.querySelector('#status-progress-area').classList.contains('is-idle'), true);
  const count = panel.messages.length; report({ phase: 'packing', currentPath: 'late.txt' });
  assert.equal(panel.messages.length, count);
});

test('read-only archive verification does not reread directory views', async t => {
  const zipFilesystem = require('../zip-filesystem'), original = zipFilesystem.createZipFilesystem;
  let verified = 0, loads = 0;
  zipFilesystem.createZipFilesystem = base => ({ ...original(base), testArchives: async () => { verified++; return []; } });
  t.after(() => { zipFilesystem.createZipFilesystem = original; });
  const initial = clipboardFixture(), app = harness(t, { filesystemLoad: async () => { loads++; return structuredClone(initial); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'zip-test', sourcePath: 'C:/tmp', ids: ['a'], operationId: 'read-only-archive-test', state: initial });
  assert.equal(verified, 1); assert.equal(loads, 1);
  assert.equal(panel.messages.at(-1).ok, true); panel.dispose();
});

test('ZIP write host requests a native password and confirmation without sending it to the webview', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-write-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'file.txt').replaceAll('\\', '/'), archive = path.join(root, 'created.zip').replaceAll('\\', '/'); fs.writeFileSync(source, 'secret');
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'file', name: 'file.txt', type: 'text', fsSource: source }];
  const app = harness(t, { filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value), inputResults: ['private-password', 'private-password'] });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['file'], archive, encryption: 'aes256', operationId: 'zip-write-host', state: initial });
  const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(result?.ok, true, JSON.stringify(result)); assert.equal(JSON.stringify(panel.messages).includes('private-password'), false);
  const z = require('@zip.js/zip.js'), reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive)));
  const entries = await reader.getEntries(); assert.equal(entries[0].encrypted, true);
  assert.equal(await entries[0].getData(new z.TextWriter(), { password: 'private-password', useWebWorkers: false }), 'secret'); await reader.close();
});

test('ZIP host distinguishes a committed archive from cancellation of its optional post-pack test', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-committed-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'), source = path.join(root, 'new.txt').replaceAll('\\', '/'); fs.writeFileSync(source, 'new');
  const z = require('@zip.js/zip.js'), writer = new z.ZipWriter(new z.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('secret.txt', new z.TextReader('secret'), { password: 'secret-password', encryptionStrength: 3 }); fs.writeFileSync(archive, await writer.close());
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'file', name: 'new.txt', type: 'text', fsSource: source }];
  const app = harness(t, { choices: ['update'], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'zip-write', action: 'pack', sourcePath: 'C:/tmp', ids: ['file'], archive, operationId: 'zip-post-test', state: initial });
  const result = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(result.cancelled, true); assert.equal(result.archiveCommitted, true); assert.match(result.notice, /ZIP wurde gespeichert/);
  const reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive))); assert.equal((await reader.getEntries()).length, 2); await reader.close();
});

test('ZIP browsing F3 materializes only the selected entry through the common provider', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-view-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'chosen.txt': 'chosen content', 'other.txt': 'other' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { choices: ['view'], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), ref = opened.state.folders[opened.resumeNavigation.path].find(row => row.name === 'chosen.txt');
  const request = { type: 'lister-open', path: ref.fsSource, side: 0, requestId: 'lister-1900' }; await panel.receive(request);
  assert.equal(panel.messages.at(-1).type, 'lister-result');
  assert.equal(panel.messages.at(-1).ok, true, JSON.stringify(panel.messages.at(-1)));
  assert.equal(app.quickPicks.length, 1);
  const result = panel.messages.at(-1); assert.equal(fs.existsSync(request.path), true);
  await panel.receive({ type: 'lister-close', id: result.id }); assert.equal(fs.existsSync(request.path), false);
  panel.dispose(); await tick();
});

test('ZIP browsing F4 uses native editor save and close events for confirmed repacking', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-edit-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'chosen.txt': 'original', 'other.txt': 'other' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { choices: ['repack', 'repack'], filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), reference = opened.state.folders[opened.resumeNavigation.path].find(row => row.name === 'chosen.txt');
  await panel.receive({ type: 'edit', path: reference.fsSource });
  assert.equal(app.textDocuments.length, 1); const document = app.textDocuments[0], target = document.uri.fsPath;
  assert.equal(fs.readFileSync(target, 'utf8'), 'original'); fs.writeFileSync(target, 'edited'); await app.saveDocument(document);
  const z = require('@zip.js/zip.js'), reader = new z.ZipReader(new z.Uint8ArrayReader(fs.readFileSync(archive)));
  const entries = await reader.getEntries(); assert.equal(await entries.find(entry => entry.filename === 'chosen.txt').getData(new z.TextWriter(), { useWebWorkers: false }), 'edited'); await reader.close();
  fs.writeFileSync(target, 'edited again'); await app.saveDocument(document);
  assert.equal(app.errors.length, 0);
  await app.closeDocument(document); assert.equal(fs.existsSync(target), false);
});

test('ZIP browsing F4 cleans the plaintext working copy when native editor opening fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-edit-fail-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'content' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { documentError: 'Editor failed', filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), reference = opened.state.folders[opened.resumeNavigation.path][0];
  await panel.receive({ type: 'edit', path: reference.fsSource });
  assert.equal(app.textDocuments.length, 1); assert.equal(fs.existsSync(app.textDocuments[0].uri.fsPath), false); assert.ok(app.errors.includes('Editor failed'));
});

test('ZIP explicit open honors a VS Code file association and retains editor writeback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-associated-editor-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'sample.zip').replaceAll('\\', '/'); fs.writeFileSync(archive, require('./support/search-archives.cjs').zip({ 'file.txt': 'content' }));
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: archive }];
  const app = harness(t, { associatedEditor: true, filesystemLoad: async () => structuredClone(initial), containsPath: value => value.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/') || /^C:\/(tmp|temp)$/.test(value) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0]; await panel.receive({ type: 'zip-open', path: archive, side: 0 });
  const opened = panel.messages.filter(message => message.type === 'filesystem-result').at(-1), reference = opened.state.folders[opened.resumeNavigation.path][0];
  await panel.receive({ type: 'zip-open-entry', path: reference.fsSource });
  assert.equal(app.textDocuments.length, 1); assert.equal(app.openCalls[0], app.textDocuments[0].uri.fsPath);
  await app.closeDocument(app.textDocuments[0]); assert.equal(fs.existsSync(app.openCalls[0]), false);
});

test('main menu settings in generated host HTML open the searchable settings dialog', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.click(view.document.querySelector('[data-menu-group="Konfigurieren"]'));
  view.click(view.document.querySelector('[data-menu-action="settings"]'));
  const request = view.messages.find(message => message.type === 'configure-settings');
  assert.ok(request);
  await panel.receive(request);
  const settings = app.panels.at(-1); assert.notEqual(settings, panel);
  await settings.receive({ type: 'configuration-ready' });
  assert.equal(settings.messages.at(-1).section, 'settings');
  assert.ok(settings.messages.at(-1).settings.some(item => item.key === 'bitfroest.shortcuts.bindings'));
  panel.dispose();
});

test('failed license opening reports the actual failure instead of a green command dispatch', async t => {
  const app = harness(t, { licenseOpenError: 'Credits unavailable' });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.action('licenses'); const request = view.messages.find(message => message.type === 'show-licenses');
  await panel.receive(request);
  const result = panel.messages.find(message => message.type === 'ui-action-result' && message.requestId === request.requestId); assert.ok(result);
  assert.equal(result.ok, false);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.equal(view.document.querySelector('#status-message').dataset.outcome, 'error');
});

test('licenses command and Help in generated host HTML open the same readonly credits', async t => {
  const app = harness(t);
  assert.ok(app.commands.has('bitfroest.licenses'));
  await app.command('bitfroest.licenses');
  const first = app.calls.find(call => call.id === 'markdown.showPreview');
  assert.match(first.args[0].toString(), /^bitfroest-licenses:\/de\/licenses\.md$/);
  const content = app.documentProviders.get('bitfroest-licenses').provideTextDocumentContent(first.args[0]);
  assert.match(content, /Stephan Ahlf/);
  assert.match(content, /Apache-2\.0/);
  assert.equal(app.panels.length, 0);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], calls = app.calls.length;
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  const help = [...view.document.querySelectorAll('[data-main-menu] > button')].at(-1);
  view.click(help); view.key('ArrowUp', {}, view.document.activeElement);
  assert.equal(view.document.activeElement.dataset.menuAction, 'licenses');
  view.key('Enter', {}, view.document.activeElement);
  const request = view.messages.find(message => message.type === 'show-licenses');
  assert.ok(request);
  await panel.receive(request);
  const preview = app.calls.slice(calls).filter(call => call.id === 'markdown.showPreview');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].args[0].toString(), first.args[0].toString());
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.equal(app.deleteCalls.length, 0);
  assert.deepEqual(app.errors, []);
});

test('license requests wait for host readiness and ignore caller-supplied document paths', async t => {
  const app = harness(t, { language: 'en', manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'show-licenses', path: 'file:///other-document.md' });
  assert.equal(app.calls.some(call => call.id === 'markdown.showPreview'), false);
  await panel.receive({ type: 'app-ready' });
  await panel.receive({ type: 'show-licenses', path: 'file:///other-document.md' });
  const uri = app.calls.find(call => call.id === 'markdown.showPreview').args[0];
  assert.equal(uri.toString(), 'bitfroest-licenses:/en/licenses.md');
  assert.match(app.documentProviders.get('bitfroest-licenses').provideTextDocumentContent(uri), /Licenses and acknowledgements/);
  assert.equal(app.textDocuments.length, 0);
  assert.deepEqual(app.errors, []);
});

test('native license preview failure opens a text fallback without creating a file manager', async t => {
  const app = harness(t, { commandError: 'markdown.showPreview' });
  await app.command('bitfroest.licenses');
  assert.equal(app.textDocuments.length, 1);
  assert.equal(app.textEditors.length, 1);
  assert.equal(app.textEditors[0].options.preview, false);
  assert.equal(app.panels.length, 0);
  assert.deepEqual(app.errors, []);
});

test('file search host uses isolated jobs, trusted results and generated HTML with CSP', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'found.txt').replaceAll('\\', '/'); fs.writeFileSync(file, 'needle');
  const initial = clipboardFixture(); initial.folders['C:/tmp'] = [];
  const app = harness(t, { filesystemLoad: async () => initial, containsPath: target => target === file || target === root.replaceAll('\\', '/') });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /nonce="[^"]+" src="[^"]*file-search-view.js"/);
  await app.command('bitfroest.search'); assert.equal(panel.messages.at(-1).action, 'search');
  await panel.receive({ type: 'inputFocus', dialog: true, search: true, value: true }); assert.equal(app.contexts.get('bitfroest.searchFocus'), true);
  await panel.receive({ type: 'search-preset-save', name: 'Text', settings: { searchIn: '>', name: '*.txt' } });
  assert.equal(app.context.globalState.get('searchPresets').Text.name, '*.txt');
  await panel.receive({ type: 'search-copy', searchId: 'missing', results: [{ fsSource: file }] });
  assert.equal(app.clipboardCalls.length, 0);
  panel.dispose(); assert.equal(app.contexts.get('bitfroest.searchFocus'), false);
});

test('file search persistence loads parents of deep results and serializes global template writes', async t => {
  const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'search-persistence-')).replaceAll('\\', '/'); t.after(() => fs.rmSync(resultRoot, { recursive: true, force: true }));
  const state = clipboardFixture(); state.panes[0].tabStates = [{ path: 'C:/tmp', searchResult: { paths: [resultRoot + '/a.txt'] } }];
  const loaded = [], gate = deferred(); let writes = 0;
  const app = harness(t, { containsPath: () => true, workspaceState: { fileManagerState: state }, filesystemLoad: async settings => { loaded.push(settings); return state; }, update: async (store, key) => { if (store === 'global' && key === 'searchPresets' && ++writes === 1) await gate.promise; } });
  await app.command('bitfroest.openPrototype'); assert.ok(loaded[0].directories.includes(resultRoot));
  const panel = app.panels[0];
  const first = panel.receive({ type: 'search-preset-save', name: 'One', settings: { name: '*.txt' } });
  const second = panel.receive({ type: 'search-preset-save', name: 'Two', settings: { name: '*.md' } });
  gate.resolve(); await Promise.all([first, second]); assert.deepEqual(Object.keys(app.context.globalState.get('searchPresets')).sort(), ['One', 'Two']);
});

test('file search integrates real nested files with host HTML, apply, result tabs and copy operations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-integration-')).replaceAll('\\', '/'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = root + '/left', right = root + '/right'; fs.mkdirSync(left); fs.mkdirSync(right); fs.mkdirSync(left + '/deep');
  fs.writeFileSync(left + '/one.txt', 'one'); fs.writeFileSync(left + '/deep/two.txt', 'two');
  const provider = require('../filesystem-provider').createProvider({ roots: [left, right] });
  const app = harness(t, { searchRoots: [left, right], containsPath: value => provider.contains(value), filesystemLoad: settings => provider.load(settings), filesystemPrepare: (before, settings) => provider.prepare(before, settings), filesystemApply: (before, after, operation) => provider.apply(before, after, operation) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.key('F7', { altKey: true }); view.document.querySelector('[data-file-search] [name=name]').value = '*.txt'; view.key('s', { altKey: true });
  await panel.receive(view.messages.find(m => m.type === 'search-start'));
  const complete = panel.messages.find(m => m.type === 'search-complete'); assert.equal(complete.results.length, 2);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: complete })); view.key('w', { altKey: true });
  await panel.receive(view.messages.find(m => m.type === 'search-apply'));
  const applied = panel.messages.find(m => m.type === 'search-applied'); assert.equal(applied.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: applied }));
  assert.equal(view.state().panes[0].tabs.length, 2); assert.ok(view.row('two.txt')); assert.ok(view.row('one.txt'));
  const resultTab = view.state().panes[0].tabStates[1].id;
  view.click(view.row('two.txt')); view.row('two.txt').dispatchEvent(new view.window.MouseEvent('dblclick', { bubbles: true }));
  await panel.receive(view.messages.filter(message => message.type === 'open').at(-1));
  view.window.dispatchEvent(new view.window.Event('blur')); view.window.dispatchEvent(new view.window.Event('focus'));
  const refresh = view.messages.filter(message => message.type === 'filesystem-refresh').at(-1); assert.ok(refresh);
  await panel.receive(refresh);
  const refreshed = panel.messages.filter(message => message.type === 'filesystem-result').at(-1); assert.equal(refreshed.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: refreshed }));
  assert.equal(view.state().panes[0].tabStates[1].id, resultTab); assert.equal(view.state().panes[0].tabStates[1].searchResult.id, complete.searchId); assert.ok(view.row('two.txt')); assert.ok(view.row('one.txt'));
  view.action('select-all'); view.action('copy'); view.document.querySelector('#modal-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  let processed = 0, replies = panel.messages.length;
  for (let count = 0; count < 100 && (!fs.existsSync(right + '/one.txt') || !fs.existsSync(right + '/two.txt')); count++) {
    while (processed < view.messages.length) { const message = view.messages[processed++]; if (['filesystem-apply', 'filesystem-prepare', 'state'].includes(message.type)) await panel.receive(message); }
    for (const message of panel.messages.slice(replies)) view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
    replies = panel.messages.length;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(right + '/one.txt'), JSON.stringify({ errors: app.errors, messages: panel.messages.filter(m => m.type.startsWith('filesystem')).map(m => ({ type: m.type, ok: m.ok, error: m.error })), sent: view.messages.slice(-8).map(m => m.type), dialog: view.document.querySelector('#modal-title').textContent }));
  assert.equal(fs.readFileSync(right + '/one.txt', 'utf8'), 'one'); assert.equal(fs.readFileSync(right + '/two.txt', 'utf8'), 'two');
  assert.equal(fs.readFileSync(left + '/deep/two.txt', 'utf8'), 'two'); panel.dispose();
});

test('file search preserves single-archive entries on apply and materializes only the selected entry for Lister', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-zip-')).replaceAll('\\', '/'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = root + '/left', right = root + '/right'; fs.mkdirSync(left); fs.mkdirSync(right);
  fs.writeFileSync(left + '/data.zip', require('./support/search-archives.cjs').zip({ 'inside.txt': 'hello needle' }));
  const provider = require('../filesystem-provider').createProvider({ roots: [left, right] });
  const app = harness(t, { searchRoots: [left, right], containsPath: value => provider.contains(value), filesystemLoad: settings => provider.load(settings), filesystemPrepare: (before, settings) => provider.prepare(before, settings) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0], id = 'search-1234567890abcdef-1';
  await panel.receive({ type: 'search-start', searchId: id, settings: { name: '*.txt', searchIn: left, archives: true } });
  const complete = panel.messages.find(m => m.type === 'search-complete'); assert.equal(complete.results[0].entry, 'inside.txt');
  await panel.receive({ type: 'search-apply', searchId: id }); const applied = panel.messages.find(m => m.type === 'search-applied');
  assert.equal(applied.results[0].entry, 'inside.txt');
  await panel.receive({ type: 'lister-open', requestId: 'lister-321', side: 0, path: complete.results[0].fsSource });
  const opened = panel.messages.find(m => m.requestId === 'lister-321'); assert.equal(opened.ok, true); assert.equal(opened.view.text, 'hello needle');
  await panel.receive({ type: 'lister-edit', requestId: 'lister-322', id: opened.id });
  assert.equal(app.textDocuments.length, 0); assert.match(panel.messages.find(message => message.requestId === 'lister-322').error, /Archivtreffer|archive/i);
  await panel.receive({ type: 'edit', path: complete.results[0].fsSource }); assert.equal(app.textDocuments.length, 0);
  fs.writeFileSync(left + '/data.zip', require('./support/search-archives.cjs').zip({ 'inside.txt': 'replacement content' }));
  await panel.receive({ type: 'lister-open', requestId: 'lister-323', side: 0, path: complete.results[0].fsSource });
  const stale = panel.messages.find(message => message.requestId === 'lister-323'); assert.equal(stale.ok, false); assert.match(stale.error, /geändert/);
  panel.dispose();
});

test('fixed settings reach generated host HTML and replace columns without losing legacy compatibility', async t => {
  const app = harness(t, { configuration: { 'columns.visible.path': true, 'columns.width.path': 320 } });
  await app.command('bitfroest.openPrototype');
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html });
  assert.ok(view.document.querySelector('th[data-column="path"]'));
  assert.equal(view.document.querySelector('col[data-col="path"]').width, '320');
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(item => item.properties));
  assert.equal(properties['bitfroest.columns.visible.path'].type, 'boolean');
  assert.doesNotMatch(manifest.contributes.menus['webview/context'].find(item => item.command === 'bitfroest.configureColumns').when, /bitfroest.ready/);
});

test('favorite settings initialize the real HTML, broadcast changes and open their native settings area', async t => {
  const app = harness(t, { configuration: { 'favorites.entries': { Work: 'C:/tmp' } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.click(view.document.querySelector('[data-favorites]'));
  assert.equal(view.document.querySelector('[data-favorite-entry]').textContent, 'Work');
  await panel.receive({ type: 'configure-favorites' });
  assert.equal(app.panels[1].viewType, 'bitfroestConfiguration');
  await app.panels[1].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[1].messages.at(-1).section, 'favorites');
  await app.configuration('bitfroest.favorites');
  assert.equal(panel.messages.at(-1).type, 'favorite-settings');
});

test('startup fallback roots reach the provider while saved tabs remain navigable', async t => {
  const home = os.homedir().replaceAll('\\', '/');
  const initial = clipboardFixture();
  let loaded;
  const app = harness(t, { startupRoots: [home], workspaceState: { fileManagerState: initial }, filesystemLoad: async settings => { loaded = settings; return initial; } });
  await app.command('bitfroest.openPrototype');
  assert.deepEqual(app.providerOptions.roots, [home]);
  assert.ok(loaded.directories.includes('C:/tmp'));
  assert.equal(app.panels.length, 1);
  assert.deepEqual(app.errors, []);
});

test('missing persisted tabs cannot prevent startup in the fallback directory', async t => {
  const initial = clipboardFixture();
  const app = harness(t, { startupRoots: ['C:/Users/example'], missingDirectories: ['C:/tmp'], workspaceState: { fileManagerState: initial }, filesystemLoad: async settings => {
    assert.equal(settings.directories.includes('C:/tmp'), false);
    return initial;
  } });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 1);
  assert.deepEqual(app.errors, []);
});

test('removing a missing earlier tab retains the active saved path and its tab state', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => Object.assign(pane, { filter: '', sort: 'name' }));
  const saved = structuredClone(initial);
  saved.panes[0] = { ...saved.panes[0], tabs: ['C:/missing', 'C:/tmp', 'C:/temp'], tab: 1, tabStates: [
    { id: 'missing', path: 'C:/missing' }, { id: 'active', path: 'C:/tmp', filter: 'saved filter' }, { id: 'other', path: 'C:/temp' }
  ] };
  const app = harness(t, { missingDirectories: ['C:/missing'], workspaceState: { fileManagerState: saved }, filesystemLoad: async () => initial });
  await app.command('bitfroest.openPrototype');
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html });
  const pane = view.state().panes[0];
  assert.equal(pane.tabs[pane.tab], 'C:/tmp');
  assert.equal(pane.tabStates[pane.tab].id, 'active');
  assert.equal(pane.tabStates[pane.tab].filter, 'saved filter');
});

test('configured favorite directories and opposite targets extend the provider without changing startup roots', t => {
  const configuration = { 'favorites.entries': { Work: 'C:/git' }, 'favorites.targets': { Work: 'A:/Media' } };
  const app = harness(t, { configuration });
  assert.deepEqual(app.providerOptions.roots, ['C:/tmp', 'C:/temp']);
  assert.deepEqual(app.providerOptions.additionalRoots(), ['C:/git', 'A:/Media']);
  configuration['favorites.entries'] = { Work: 'D:/Work' };
  assert.deepEqual(app.providerOptions.additionalRoots(), ['D:/Work', 'A:/Media']);
});

test('configuration editor saves trees and layout into the chosen scope and broadcasts the resulting panel state', async t => {
  const app = harness(t, { configurationScopes: {} });
  await app.command('bitfroest.openPrototype'); const main = app.panels[0];
  await app.command('bitfroest.configureFavorites'); const editor = app.panels[1];
  await editor.receive({ type: 'configuration-ready' });
  const initial = editor.messages.at(-1);
  initial.data.favorites = [{ id: 'root', type: 'group', parent: null, name: 'Projects' }, { id: 'work', type: 'favorite', parent: 'root', name: 'Work', path: 'C:/git', target: '' }];
  initial.data.columns.find(item => item.id === 'path').visible = true;
  await editor.receive({ type: 'configuration-save', scope: 'user', revision: initial.revision, data: initial.data });
  assert.ok(app.updateCalls.some(call => call.key === 'favorites.items' && call.target === 1));
  assert.ok(app.updateCalls.some(call => call.key === 'columns.layout' && call.target === 1));
  const favorites = main.messages.filter(item => item.type === 'favorite-settings').at(-1).settings;
  assert.equal(favorites.entries.work, 'C:/git'); assert.equal(favorites.groups.work, 'Projects');
  assert.equal(main.messages.filter(item => item.type === 'column-settings').at(-1).settings.sets[0].columns.find(item => item.id === 'path').visible, true);
});

test('cancelled favorite input returns through the real host refresh protocol without replacing lists', async t => {
  const initial = clipboardFixture();
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  let loads = 0;
  const app = harness(t, { inputResults: [undefined], manualReadiness: true, filesystemLoad: async () => ({ ...structuredClone(initial), snapshotId: `load-${++loads}` }) });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  const policy = view.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(policy, /script-src 'nonce-/);
  assert.doesNotMatch(policy, /unsafe-inline/);
  await panel.receive(view.messages.find(message => message.type === 'app-ready'));
  const lists = [...view.document.querySelectorAll('.list')];
  const row = view.row('a.txt');
  view.click(view.document.querySelector('[data-favorites]'));
  view.click(view.document.querySelector('[data-favorite-toggle]'));
  view.window.dispatchEvent(new view.window.Event('blur'));
  await panel.receive(view.messages.find(message => message.type === 'favorite-toggle'));
  assert.equal(app.updateCalls.length, 0);
  view.click(row);
  view.window.dispatchEvent(new view.window.Event('focus'));
  const request = view.messages.find(message => message.type === 'filesystem-refresh');
  assert.ok(request);
  await panel.receive(request);
  const response = panel.messages.filter(message => message.type === 'filesystem-result').at(-1);
  assert.equal(response.ok, true);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
  lists.forEach((list, side) => assert.equal(view.document.querySelectorAll('.list')[side], list));
  assert.equal(view.row('a.txt'), row);
  assert.equal(view.document.activeElement, lists[0]);
  assert.equal(view.document.querySelector('#panes').inert, false);
  assert.equal(view.state().snapshotId, response.state.snapshotId);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('favorite menu adds a named directory, cancels without writing and removes only matching entries', async t => {
  const app = harness(t, { inputResults: [undefined, 'Work'], configurationScopes: { 'favorites.entries': { globalValue: { Other: 'C:/temp' } } } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'favorite-toggle', path: 'C:/tmp' });
  assert.equal(app.updateCalls.filter(call => call.key === 'favorites.items').length, 0);
  await panel.receive({ type: 'favorite-toggle', path: 'C:/tmp' });
  const added = app.updateCalls.find(call => call.key === 'favorites.items');
  assert.deepEqual(added.value.map(item => [item.name, item.path]), [['Other', 'C:/temp'], ['Work', 'C:/tmp']]);
  assert.equal(added.target, 1);
  await panel.receive({ type: 'favorite-toggle', path: 'c:\\tmp\\' });
  assert.deepEqual(app.updateCalls.filter(call => call.key === 'favorites.items').at(-1).value.map(item => [item.name, item.path]), [['Other', 'C:/temp']]);
});

test('favorite writes preserve configuration scopes and removal uses the owning scope', async t => {
  const app = harness(t, { inputResults: ['New'], configurationScopes: {
    'favorites.entries': { globalValue: { Personal: 'C:/personal' }, workspaceValue: { Team: 'C:/team' } }
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'favorite-toggle', path: 'C:/new' });
  const added = app.updateCalls.find(call => call.key === 'favorites.items');
  assert.deepEqual(added.value.map(item => [item.name, item.path]), [['Personal', 'C:/personal'], ['New', 'C:/new']]);
  assert.equal(added.target, 1);
  await panel.receive({ type: 'favorite-toggle', path: 'C:/team' });
  const removed = app.updateCalls.filter(call => call.key === 'favorites.items').at(-1);
  assert.equal(removed.target, 2);
  assert.deepEqual(removed.value, []);
});

test('lister host protocol opens only known files, renders generated HTML, copies matches and closes on Escape', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lister-host-'));
  const original = path.join(directory, 'sample.txt').replace(/\\/g, '/');
  fs.writeFileSync(original, 'first\r\nneedle\r\nlast\r\n');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = clipboardFixture();
  for (const p of state.panes) Object.assign(p, { filter: '', sort: 'name', descending: false });
  state.folders['C:/tmp'][0] = { id: 'a', name: 'sample.txt', type: 'text', fsSource: original, size: fs.statSync(original).size };
  state.panes[0].cursor = 'a'; state.panes[0].selected = ['a'];
  const app = harness(t, { filesystemLoad: async () => state, containsPath: candidate => candidate.startsWith(directory.replace(/\\/g, '/') + '/') });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.key('F3');
  const request = view.messages.find(message => message.type === 'lister-open');
  await panel.receive(request);
  const opened = panel.messages.find(message => message.requestId === request.requestId);
  assert.equal(opened?.ok, true);
  assert.equal(opened.view.text, 'first\nneedle\nlast\n');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: opened }));
  assert.match(view.document.querySelector('[data-lister] textarea').value, /needle/);
  await panel.receive({ type: 'lister-search', requestId: 'lister-900', id: opened.id, settings: { text: 'needle', position: 0, encoding: 'utf-8' } });
  assert.deepEqual(panel.messages.at(-1).match, { start: 7, end: 13 });
  await panel.receive({ type: 'lister-copy', requestId: 'lister-901', id: opened.id, settings: { start: 7, end: 13, encoding: 'utf-8' } });
  assert.ok(app.clipboardCalls.some(call => call.action === 'writeText' && call.text === 'needle'));
  assert.equal(app.textDocuments.length, 0);
  assert.equal(app.calls.some(call => call.id === 'markdown.showPreview'), false);
  view.key('Escape');
  await panel.receive(view.messages.filter(message => message.type === 'lister-close').at(-1));
  await panel.receive({ type: 'lister-read', requestId: 'lister-902', id: opened.id, settings: {} });
  assert.equal(panel.messages.at(-1).ok, false);
  await panel.receive({ type: 'lister-open', requestId: 'lister-903', side: 0, path: `${original}.missing` });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.ok(view.document.activeElement.matches('.list'));
  fs.writeFileSync(path.join(directory, 'next.txt'), 'linked\nfile\n');
  await panel.receive({ type: 'lister-open', requestId: 'lister-904', side: 0, path: original });
  const reopened = panel.messages.at(-1);
  await panel.receive({ type: 'lister-link', requestId: 'lister-905', id: reopened.id, href: 'next.txt' });
  const linked = panel.messages.at(-1);
  assert.equal(linked.ok, true); assert.match(linked.view.text, /linked/);
  await panel.receive({ type: 'lister-edit', requestId: 'lister-9051', id: linked.id });
  assert.equal(app.textDocuments.at(-1)?.fsPath, linked.path);
  assert.deepEqual(app.textEditors.at(-1).options, { viewColumn: 1, preview: false });
  assert.equal(app.calls.some(call => call.id === 'openExternal'), false);
  await panel.receive({ type: 'lister-link', requestId: 'lister-906', id: linked.id, href: 'https://example.invalid/lister' });
  assert.ok(app.calls.some(call => call.id === 'openExternal' && call.args[0] === 'https://example.invalid/lister'));
  await panel.receive({ type: 'lister-link', requestId: 'lister-907', id: linked.id, href: 'javascript:alert(1)' });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.equal(app.calls.filter(call => call.id === 'openExternal').length, 1);
  panel.dispose();
});

test('activation registers a right-aligned toggle entry without opening a production window', t => {
  const app = harness(t);
  assert.equal(app.status.alignment, 2);
  assert.equal(app.status.priority, 101);
  assert.equal(app.status.shown, true);
  assert.equal(app.status.command, 'bitfroest.openPrototype');
  assert.equal(app.panels.length, 0);
  assert.ok(app.commands.has('bitfroest.chooseTabMode'));
});

test('clipboard path protocol validates one absolute reachable directory without writing files', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-shortcut-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'file.txt'), 'unchanged');
  const target = directory.replace(/\\/g, '/');
  const state = clipboardFixture();
  let value = ` "${target}" `;
  const app = harness(t, { clipboardText: value, readClipboardText: async () => value, filesystemLoad: async () => state, containsPath: candidate => candidate === target || candidate.startsWith(`${target}/`) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-path-read', requestId: 'path-1' });
  assert.equal(panel.messages.at(-1).ok, true); assert.equal(panel.messages.at(-1).path, target);
  assert.equal(panel.messages.at(-1).type, 'clipboard-result');
  value = `${target}/.`;
  await panel.receive({ type: 'clipboard-path-read', requestId: 'path-dot' });
  assert.equal(panel.messages.at(-1).path, target);
  for (value of ['', 'relative/path', `${target}\n${target}`, `${target}/missing`, `${target}/file.txt`, 'C:/elsewhere']) {
    await panel.receive({ type: 'clipboard-path-read', requestId: 'path-2' });
    assert.equal(panel.messages.at(-1).ok, false, value); assert.equal(panel.messages.at(-1).path, undefined);
  }
  assert.equal(fs.readFileSync(path.join(directory, 'file.txt'), 'utf8'), 'unchanged');
  assert.equal(app.clipboardCalls.every(call => call.action === 'readText'), true);
});

test('clipboard path command is exposed with a shortcut confined to the file manager list', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  assert.ok(manifest.contributes.commands.find(command => command.command === 'bitfroest.path-clipboard'));
  const binding = manifest.contributes.keybindings.find(binding => binding.command === 'bitfroest.path-clipboard');
  assert.equal(binding.key, 'ctrl+shift+l');
  for (const guard of ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.listFocus', '!bitfroest.textInput']) assert.ok(binding.when.includes(guard));
  await app.command('bitfroest.path-clipboard');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'action', action: 'path-clipboard' });
});

test('clipboard path protocol ignores stale panels and reports clipboard failures', async t => {
  const waiting = deferred();
  const app = harness(t, { readClipboardText: () => waiting.promise, filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = panel.receive({ type: 'clipboard-path-read', requestId: 'path-1' });
  panel.dispose(); waiting.resolve('C:/tmp'); await request;
  assert.equal(panel.messages.some(message => message.requestId === 'path-1'), false);
  await app.command('bitfroest.openPrototype'); const next = app.panels[1];
  await next.receive({ type: 'clipboard-path-read', requestId: 'bad\nrequest' });
  assert.equal(app.clipboardCalls.length, 1);
  const failed = harness(t, { readClipboardText: async () => { throw new Error('clipboard unavailable'); } });
  await failed.command('bitfroest.openPrototype');
  await failed.panels[0].receive({ type: 'clipboard-path-read', requestId: 'path-error' });
  assert.equal(failed.panels[0].messages.at(-1).ok, false);
  assert.match(failed.panels[0].messages.at(-1).error, /clipboard unavailable/);
});

test('generated host HTML isolates shortcuts and completes checked clipboard navigation after host acknowledgement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = directory.replace(/\\/g, '/'), state = clipboardFixture();
  state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => state, clipboardText: destination, containsPath: () => true,
    filesystemPrepare: async () => ({ ...state, folders: { ...state.folders, [destination]: [] } }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  const escaped = []; view.window.addEventListener('keydown', event => escaped.push(event.key));
  view.key('n', { ctrlKey: true, shiftKey: true }); view.key('k', { ctrlKey: true });
  assert.deepEqual(escaped, []);
  view.key('l', { ctrlKey: true, shiftKey: true });
  await panel.receive(view.messages.find(message => message.type === 'clipboard-path-read'));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.at(-1) }));
  assert.equal(view.state().panes[0].tabs[0], 'C:/tmp');
  const navigation = view.messages.find(message => message.type === 'filesystem-navigate');
  assert.equal(navigation.path, destination);
  await panel.receive(navigation);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: panel.messages.at(-1) }));
  assert.equal(view.state().panes[0].tabs[0], destination);
  assert.equal(view.document.activeElement.className, 'list');
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('folder sizing host protocol returns read-only metadata and rejects stale or unknown targets', async t => {
  const state = clipboardFixture(); state.folders['C:/tmp'].push({ id: 'docs', name: 'docs', type: 'folder' });
  const calls = [];
  const app = harness(t, { filesystemLoad: async () => state, measureFolder: async (...args) => { calls.push(args); return 27; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = { type: 'folder-size', operationId: 'size-1', snapshotId: state.snapshotId, path: 'C:/tmp/docs' };
  await panel.receive(request);
  assert.equal(calls.length, 1); assert.equal(calls[0][1], request.path);
  assert.equal(panel.messages.at(-1).type, 'folder-size-result');
  assert.equal(panel.messages.at(-1).size, 27); assert.equal(panel.messages.at(-1).ok, true);
  for (const extra of [{ snapshotId: 'stale' }, { path: 'C:/tmp/missing' }, { path: 'C:/tmp/a.txt' }, { path: 'C:/elsewhere/docs' }]) {
    await panel.receive({ ...request, ...extra }); assert.equal(panel.messages.at(-1).ok, false);
  }
  assert.equal(calls.length, 1);
  assert.equal(state.folders['C:/tmp'][1].size, undefined);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('folder sizing cancellation and panel disposal abort work without waiting on a notification', async t => {
  const state = clipboardFixture(); state.folders['C:/tmp'].push({ id: 'docs', name: 'docs', type: 'folder' });
  let signal;
  const app = harness(t, { filesystemLoad: async () => state, measureFolder: async (_before, _directory, settings) => {
    signal = settings.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const request = { type: 'folder-size', operationId: 'size-1', snapshotId: state.snapshotId, path: 'C:/tmp/docs' };
  const pending = panel.receive(request); await tick(); assert.ok(signal);
  await panel.receive({ type: 'filesystem-cancel', operationId: request.operationId }); await pending;
  assert.equal(signal.aborted, true); assert.equal(panel.messages.at(-1).cancelled, true);
  const next = panel.receive({ ...request, operationId: 'size-2' }); await tick();
  panel.dispose(); await next; assert.equal(signal.aborted, true); assert.deepEqual(app.errors, []);
});

test('folder sizing settings use the native resource configuration and reach the generated host HTML', async t => {
  const app = harness(t, { configuration: { 'files.countFolderSizeOnSpace': false } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const encoded = /data-file-settings="([^"]+)"/.exec(panel.webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).countFolderSizeOnSpace, false);
  await app.configuration('bitfroest.files');
  assert.equal(panel.messages.at(-1).settings.countFolderSizeOnSpace, false);
  const setting = Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties))['bitfroest.files.countFolderSizeOnSpace'];
  assert.equal(setting.scope, 'resource'); assert.equal(setting.default, true);
});

test('generated webview HTML authorizes and resolves every startup script including numbered module names', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(app.panels[0].webview.html); t.after(() => dom.window.close());
  const document = dom.window.document;
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce);
  const scripts = [...document.querySelectorAll('script[src]')];
  const template = new JSDOM(fs.readFileSync(path.join(root, 'media/index.html'), 'utf8')); t.after(() => template.window.close());
  const templateScripts = [...template.window.document.querySelectorAll('script[src]')].map(script => script.getAttribute('src'));
  assert.equal(scripts.length, templateScripts.length);
  for (const [index, script] of scripts.entries()) {
    assert.equal(script.getAttribute('nonce'), nonce, `${templateScripts[index]} must be authorized by the actual startup CSP`);
    assert.equal(script.getAttribute('src'), `webview-resource:${path.join(root, 'media', templateScripts[index])}`, `${templateScripts[index]} must use a webview resource URI`);
    assert.equal(fs.existsSync(path.join(root, 'media', templateScripts[index])), true, 'the referenced startup asset exists');
  }
});

test('declared text select-all command delegates to the native action without selecting files', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false });
  const before = app.panels[0].messages.length;
  await app.command('bitfroest.select-all-text');
  assert.equal(app.calls.filter(call => call.id === 'editor.action.selectAll').length, 1);
  assert.equal(app.panels[0].messages.length, before);
  const command = manifest.contributes.commands.find(item => item.command === 'bitfroest.select-all-text');
  assert.ok(command);
  for (const language of ['', '.de']) assert.ok(require(`../package.nls${language}.json`)[command.title.slice(1, -1)]);
  app.panels[0].dispose();
});

test('fresh and restored views authorize existing stylesheets inside their resource roots', async t => {
  for (const restoring of [false, true]) {
    const app = harness(t);
    let panel;
    if (restoring) {
      panel = app.restoredPanel();
      await app.serializer.deserializeWebviewPanel(panel, null);
    } else {
      await app.command('bitfroest.openPrototype'); panel = app.panels[0];
    }
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(panel.webview.html); t.after(() => dom.window.close());
    const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    const stylePolicy = /(?:^|;)\s*style-src ([^;]+)/.exec(policy)?.[1];
    assert.ok(stylePolicy?.split(/\s+/).includes(panel.webview.cspSource));
    const options = restoring ? panel.webview.options : panel.panelOptions;
    assert.equal(options.enableScripts, true);
    const mediaRoot = path.join(root, 'media');
    assert.ok(options.localResourceRoots.some(uri => uri.fsPath === mediaRoot));
    const links = [...dom.window.document.querySelectorAll('link[rel="stylesheet"]')];
    assert.equal(links.length, 3);
    for (const name of ['workbench-vendor.css', 'app.css', 'file-search.css']) {
      assert.ok(links.some(link => link.getAttribute('href') === `webview-resource:${path.join(mediaRoot, name)}`));
      assert.ok(fs.statSync(path.join(mediaRoot, name)).size > 0);
    }
    panel.dispose();
  }
});

test('uninitialized or failed panels cannot run file commands or accept file messages', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  await app.command('bitfroest.delete'); await panel.receive({ type: 'inputFocus', list: true });
  assert.equal(panel.messages.length, 0); assert.notEqual(app.contexts.get('bitfroest.listFocus'), true);
  await panel.receive({ type: 'app-ready' });
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  await app.command('bitfroest.delete'); assert.equal(panel.messages.at(-1).action, 'delete');
  await panel.receive({ type: 'app-startup-error' }); const count = panel.messages.length;
  assert.equal(app.contexts.get('bitfroest.ready'), false);
  await app.command('bitfroest.copy'); await panel.receive({ type: 'choose-drop-action', requestId: 'right-drop-1' });
  assert.equal(panel.messages.length, count); assert.equal(app.quickPicks.length, 0);
  await panel.receive({ type: 'app-ready' }); assert.equal(app.contexts.get('bitfroest.ready'), false);
  panel.dispose(); await app.command('bitfroest.openPrototype');
  await panel.receive({ type: 'app-ready' }); assert.equal(app.contexts.get('bitfroest.ready'), false);
  await app.panels[1].receive({ type: 'app-ready' }); assert.equal(app.contexts.get('bitfroest.ready'), true);
  app.panels[1].dispose(); assert.equal(app.contexts.get('bitfroest.ready'), false);
});

test('native webview file menus require a rendered ready application', () => {
  for (const item of manifest.contributes.menus['webview/context']) {
    if (item.command === 'bitfroest.select-all-text') assert.match(item.when, /webviewSection == textInput/);
    else if (item.command === 'bitfroest.configureColumns') assert.match(item.when, /webviewSection == columns/);
    else assert.match(item.when, /bitfroest\.ready/);
    assert.match(item.when, /webviewId == bitfroestPrototype/);
  }
  for (const item of manifest.contributes.commands.filter(item => item.enablement)) assert.match(item.enablement, /bitfroest\.ready/);
});

test('file shortcuts require this webview, list focus and absence of text input', () => {
  const bindings = manifest.contributes.keybindings.filter(binding => binding.command !== 'bitfroest.openPrototype');
  assert.ok(bindings.some(binding => binding.key === 'ctrl+t'));
  assert.ok(bindings.some(binding => binding.key === 'f5'));
  for (const binding of bindings) {
    const clauses = binding.when.split(/\s*&&\s*/);
    if (binding.command === 'bitfroest.lister-action' || binding.command === 'bitfroest.search-key') {
      for (const guard of ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.ready']) assert.ok(clauses.includes(guard));
      assert.ok(clauses.some(clause => /^bitfroest\.(listerFocus|searchFocus|searchResultsFocus)$/.test(clause)));
      continue;
    }
    const guards = binding.when.includes('bitfroest.inlineRenameInput') ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.inlineRenameInput', 'bitfroest.textInput'] : binding.command === 'bitfroest.ignore-dialog-function-key' ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.fileDialog', '!bitfroest.transferNameInput'] : binding.command.startsWith('bitfroest.transfer-name-') ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.transferNameInput', 'bitfroest.textInput'] : binding.command.startsWith('bitfroest.conflict-') ? ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.conflictDialog'] : ['activeWebviewPanelId == bitfroestPrototype', 'webviewFocus', 'bitfroest.listFocus', '!bitfroest.textInput'];
    for (const guard of guards) assert.ok(clauses.includes(guard), `${binding.command} lacks ${guard}`);
  }
});

test('Shift+F5 is registered as a scoped same-directory copy command', async t => {
  const binding = manifest.contributes.keybindings.find(item => item.key === 'shift+f5');
  assert.equal(binding?.command, 'bitfroest.copy-same');
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.copy-same');
  assert.equal(app.panels[0].messages.at(-1).action, 'copy-same');
});
test('Insert is registered only for focused file lists and forwards its selection command', async t => {
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.toggle-selection-next');
  assert.equal(binding?.key, 'insert'); assert.match(binding.when, /bitfroest.listFocus/); assert.match(binding.when, /!bitfroest.textInput/);
  const app = harness(t); await app.command('bitfroest.openPrototype'); await app.command('bitfroest.toggle-selection-next');
  assert.equal(app.panels[0].messages.at(-1).action, 'toggle-selection-next');
});

test('column header configuration opens the configuration editor and has its own context section', async t => {
  const app = harness(t);
  await app.command('bitfroest.configureColumns');
  assert.equal(app.panels[0].viewType, 'bitfroestConfiguration');
  await app.panels[0].receive({ type: 'configuration-ready' });
  assert.equal(app.panels[0].messages.at(-1).section, 'columns');
  const item = manifest.contributes.menus['webview/context'].find(item => item.command === 'bitfroest.configureColumns');
  assert.match(item?.when || '', /webviewSection == columns/);
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties));
  assert.ok(properties['bitfroest.columns.sets']);
  assert.ok(properties['bitfroest.columns.activeSet']);
});

test('list focus does not reconfigure the window or start a focus refresh feedback chain', async t => {
  let feedback = false, effects = 0;
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), commandEffect: async (id, _args, panels) => {
    if (!feedback || id !== 'workbench.action.enableCompactAuxiliaryWindow') return;
    if (++effects > 3) return;
    const panel = panels[0];
    await panel.receive({ type: 'inputFocus', value: false, list: false });
    await panel.receive({ type: 'filesystem-refresh', state: clipboardFixture() });
    await panel.receive({ type: 'inputFocus', value: false, list: true });
  } });
  await app.command('bitfroest.openPrototype');
  const before = app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  feedback = true;
  await app.panels[0].receive({ type: 'inputFocus', value: false, list: true });
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length, before);
  assert.equal(effects, 0);
  assert.equal(app.contexts.get('bitfroest.listFocus'), true);
  await app.command('bitfroest.copy');
  assert.equal(app.panels[0].messages.at(-1).action, 'copy');
});

test('native window setup uses only the marked window and restores a stable title', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  assert.equal(panel.viewType, 'bitfroestPrototype');
  assert.equal(panel.title, 'Bitfroest.fs · Arbeitsbereich');
  assert.ok(panel.webview.html.includes('Content-Security-Policy'));
  assert.ok(panel.webview.html.includes('data-icon-theme='));
  assert.ok(panel.webview.html.includes('nonce='));
  assert.ok(panel.panelOptions.localResourceRoots.length >= 2);
  const setup = app.calls.filter(call => call.id.startsWith('workbench.action.')).map(call => call.id);
  assert.deepEqual(setup, ['workbench.action.moveEditorToNewWindow']);
  assert.equal(app.nativeCalls.length, 1);
  assert.equal(app.nativeCalls[0].operation, 'windows.maximize');
  assert.match(app.nativeCalls[0].titleToken, /^[a-f0-9-]{36}$/);
  assert.equal(app.errors.length, 0);
});

test('compact auxiliary mode waits for webview readiness after the move and ignores stale replies', async t => {
  const move = deferred(); let moveStarted;
  const started = new Promise(resolve => { moveStarted = resolve; });
  const app = harness(t, { manualReadiness: true, commandEffect: async id => { if (id === 'workbench.action.moveEditorToNewWindow') { moveStarted(); await move.promise; } } });
  const opening = app.commands.get('bitfroest.openPrototype')(); await started;
  const panel = app.panels[0]; await panel.receive({ type: 'app-ready' });
  const compact = () => app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  assert.equal(compact(), 0);
  assert.equal(panel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  move.resolve(); await opening;
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check'); assert.ok(check);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  assert.equal(compact(), 1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(compact(), 1);
});

test('compact auxiliary readiness requested after move handles app-ready later and ignores replies from a reopened panel', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.commands.get('bitfroest.openPrototype')(); const oldPanel = app.panels[0];
  assert.equal(oldPanel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  await oldPanel.receive({ type: 'app-ready' });
  const oldCheck = oldPanel.messages.find(message => message.type === 'auxiliary-compact-check'); assert.ok(oldCheck);
  await oldPanel.receive({ type: 'auxiliary-compact-ready', requestId: oldCheck.requestId });
  oldPanel.dispose();
  await app.commands.get('bitfroest.openPrototype')(); const panel = app.panels[1];
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check'); assert.ok(check);
  const compact = () => app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  assert.equal(compact(), 1);
  await oldPanel.receive({ type: 'auxiliary-compact-ready', requestId: oldCheck.requestId });
  assert.equal(compact(), 1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: check.requestId });
  assert.equal(compact(), 2);
});

test('focused file list hides the auxiliary status strip through generated host HTML without a window focus event', async t => {
  let activeWindow = 'main';
  const strips = { main: true, auxiliary: true };
  const app = harness(t, { manualReadiness: true, commandEffect: async id => {
    if (id === 'workbench.action.enableCompactAuxiliaryWindow' && activeWindow === 'auxiliary') strips.auxiliary = false;
  } });
  await app.commands.get('bitfroest.openPrototype')();
  const panel = app.panels[0];
  const { createApp } = require('./support/webview.cjs');
  const view = createApp(t, undefined, { html: panel.webview.html });
  let focused = false;
  view.document.hasFocus = () => focused;
  Object.defineProperty(view.document, 'visibilityState', { configurable: true, value: 'visible' });
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
  assert.ok(check);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: check }));
  assert.equal(strips.auxiliary, true);
  activeWindow = 'auxiliary'; focused = true;
  const list = view.document.querySelector('.list');
  list.dispatchEvent(new view.window.FocusEvent('focusin', { bubbles: true }));
  const replies = view.messages.filter(message => message.type === 'auxiliary-compact-ready');
  assert.equal(replies.length, 1);
  await panel.receive(replies[0]);
  assert.equal(strips.auxiliary, false);
  assert.equal(strips.main, true);
  const before = app.calls.length;
  list.dispatchEvent(new view.window.FocusEvent('focusin', { bubbles: true }));
  view.window.dispatchEvent(new view.window.Event('focus'));
  assert.equal(view.messages.filter(message => message.type === 'auxiliary-compact-ready').length, 1);
  assert.equal(app.calls.length, before);
  assert.equal(app.updateCalls.length, 0);
});

test('restored single editor hides native tabs and status strip through generated host readiness', async t => {
  const app = harness(t, { manualReadiness: true });
  const panel = app.restoredPanel();
  await app.serializer.deserializeWebviewPanel(panel);
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.document.hasFocus = () => true;
  Object.defineProperty(view.document, 'visibilityState', { configurable: true, value: 'visible' });
  await panel.receive({ type: 'app-ready' });
  const check = panel.messages.find(message => message.type === 'auxiliary-compact-check');
  assert.ok(check, 'restoration must request focused readiness');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: check }));
  await panel.receive(view.messages.find(message => message.type === 'auxiliary-compact-ready'));
  assert.equal(app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length, 1);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  assert.equal(app.updateCalls.length, 0);
});

test('closing a companion editor restores compact chrome once and rejects earlier readiness', async t => {
  const app = harness(t, { manualReadiness: true });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0], group = app.tabGroups[0];
  await panel.receive({ type: 'app-ready' });
  const first = panel.messages.at(-1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: first.requestId });
  const compact = () => app.calls.filter(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow').length;
  assert.equal(compact(), 1);
  group.tabs.push({ input: { viewType: 'bitfroestFolderLocks' } }); app.tabsChanged();
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: first.requestId });
  assert.equal(compact(), 1, 'companion tabs must stay accessible');
  group.tabs.pop(); app.tabsChanged();
  const next = panel.messages.at(-1);
  assert.equal(next.type, 'auxiliary-compact-check');
  assert.notEqual(next.requestId, first.requestId);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: first.requestId });
  assert.equal(compact(), 1);
  await panel.receive({ type: 'auxiliary-compact-ready', requestId: next.requestId });
  assert.equal(compact(), 2);
  const count = panel.messages.length;
  app.tabGroups.push({ viewColumn: 9, tabs: [{ input: {} }, { input: {} }] });
  app.tabsChanged(); app.groupsChanged();
  assert.equal(panel.messages.length, count, 'unrelated tab changes must not reconfigure the window');
  panel.dispose(); group.tabs.push({ input: {} }); app.tabsChanged(); group.tabs.pop(); app.tabsChanged();
  assert.equal(panel.messages.length, count);
  assert.equal(app.updateCalls.length, 0);
});

test('restored companion editors keep native tabs until the last companion closes', async t => {
  const app = harness(t, { manualReadiness: true });
  const panel = app.restoredPanel(), group = app.tabGroups[0];
  group.tabs.push({ input: { viewType: 'volume-details' } });
  await app.serializer.deserializeWebviewPanel(panel);
  await panel.receive({ type: 'app-ready' });
  assert.equal(panel.messages.some(message => message.type === 'auxiliary-compact-check'), false);
  group.tabs.pop(); app.groupsChanged();
  assert.equal(panel.messages.at(-1).type, 'auxiliary-compact-check');
});

test('preview and comparison editors do not force compact mode over their additional tabs', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  for (const message of [
    { type: 'preview', path: 'C:/tmp/a.txt' },
    { type: 'conflict-preview', path: 'C:/tmp/a.txt' },
    { type: 'compare', sourcePath: 'C:/tmp/a.txt', targetPath: 'C:/tmp/a.txt' }
  ]) {
    const before = app.calls.length;
    await panel.receive(message);
    assert.equal(app.calls.slice(before).some(call => call.id === 'workbench.action.enableCompactAuxiliaryWindow'), false, message.type);
  }
});

test('a second toggle disposes the panel and clears focus contexts', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false });
  assert.equal(app.contexts.get('bitfroest.textInput'), true);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels[0].disposed, true);
  assert.equal(app.contexts.get('bitfroest.textInput'), false);
  assert.equal(app.contexts.get('bitfroest.listFocus'), false);
  assert.equal(app.status.text, '$(folder)');
});

test('a hidden existing panel is revealed without moving another editor into a new window', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  panel.changeVisibility(false);
  assert.equal(app.status.text, '$(folder)');
  await app.command('bitfroest.openPrototype');
  assert.equal(panel.reveals, 1);
  assert.equal(app.panels.length, 1);
  assert.equal(app.nativeCalls.length, 1);
  assert.equal(app.status.text, '$(folder-opened)');
});

test('overlapping opens wait for the first theme load rather than creating duplicate windows', async t => {
  const barrier = deferred();
  const app = harness(t, { theme: async (_, icons) => { await barrier.promise; return icons; } });
  const first = app.command('bitfroest.openPrototype');
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 0);
  barrier.resolve(); await first;
  assert.equal(app.panels.length, 1);
});

test('the opening guard resets when theme acquisition fails', async t => {
  const app = harness(t, { theme: (count, icons) => { if (count === 1) throw new Error('Theme unavailable'); return icons; } });
  await assert.rejects(app.command('bitfroest.openPrototype'), /Theme unavailable/);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 1);
});

test('native maximization failures are reported without abandoning the usable panel', async t => {
  const app = harness(t, { nativeError: 'Window not found' });
  await app.command('bitfroest.openPrototype');
  assert.match(app.errors[0], /Window not found/);
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Arbeitsbereich');
  assert.equal(app.panels[0].disposed, false);
});

test('a failed window command does not launch a native helper', async t => {
  const app = harness(t, { commandError: 'workbench.action.moveEditorToNewWindow' });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.nativeCalls.length, 0);
  assert.match(app.errors[0], /moveEditorToNewWindow/);
});

test('non-Windows startup has no native process side effects or support popups', async t => {
  const app = harness(t, { platform: 'linux' });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.nativeCalls.length, 0);
  assert.equal(app.information.length, 0);
});

test('disposing a panel during native setup does not revive its title or entry', async t => {
  let complete;
  const app = harness(t, { native: callback => { complete = callback; } });
  const pending = app.command('bitfroest.openPrototype');
  await tick();
  app.panels[0].dispose();
  complete(null, '', '');
  await pending;
  assert.equal(app.status.text, '$(folder)');
  assert.equal(app.panels[0].disposed, true);
});

test('F4 opens a retained document in the main window without changing the auxiliary window', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  const before = app.calls.length;
  await app.panels[0].receive({ type: 'edit', content: 'example', language: 'typescript' });
  assert.equal(app.textDocuments.length, 1);
  assert.equal(app.textDocuments[0].content, 'example');
  assert.equal(app.textDocuments[0].language, 'plaintext');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
  assert.notEqual(app.textEditors[0].options.viewColumn, -2);
  assert.equal(app.calls.slice(before).some(call => /Window|Compact/.test(call.id)), false);
  assert.equal(app.panels[0].disposed, false);
});

test('F4 from the generated file manager HTML opens the selected source as a retained main-window tab', async t => {
  const state = clipboardFixture();
  state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => state });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.click(view.row('a.txt').querySelector('[data-filename]'));
  const start = app.calls.length;
  view.key('F4');
  const edits = view.messages.filter(message => message.type === 'edit');
  assert.equal(edits.length, 1); assert.equal(edits[0].path, 'C:/tmp/a.txt');
  await panel.receive(edits[0]);
  assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/a.txt');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
  assert.deepEqual(app.openCalls, []);
  assert.equal(app.calls.slice(start).some(call => /Window|Compact/.test(call.id)), false);
  assert.equal(panel.disposed, false);
  assert.equal(view.messages.some(message => message.type === 'filesystem-apply'), false);
});

for (const editor of [false, true]) for (const gesture of ['double-click', 'Enter']) {
  test(`${gesture} opens the activated file using its ${editor ? 'associated editor' : 'external application'}`, async t => {
    const state = clipboardFixture();
    state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
    state.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', fsSource: 'C:/tmp/b.txt' });
    state.panes[0].selected = ['b'];
    const app = harness(t, { filesystemLoad: async () => state, associatedEditor: editor });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
    const row = view.row('a.txt');
    view.click(row.querySelector('[data-filename]'), { ctrlKey: true });
    if (gesture === 'Enter') view.key('Enter', {}, row.closest('.list'));
    else {
      view.click(view.row('a.txt').querySelector('[data-filename]'), { ctrlKey: true, detail: 2 });
      view.row('a.txt').dispatchEvent(new view.window.MouseEvent('dblclick', { bubbles: true, button: 0, ctrlKey: true, detail: 2 }));
    }
    const messages = view.messages.filter(message => ['open', 'edit', 'preview'].includes(message.type));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'open');
    assert.equal(messages[0].path, 'C:/tmp/a.txt');
    const start = app.calls.length;
    await panel.receive(messages[0]);
    assert.deepEqual(app.openCalls, ['C:/tmp/a.txt']);
    assert.equal(app.textDocuments.length, editor ? 1 : 0);
    if (editor) {
      assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/a.txt');
      assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
    }
    assert.equal(app.calls.slice(start).some(call => /Window|Compact/.test(call.id)), false);
  });
}

test('file activation rejects unlisted paths and reports launch failures without opening an editor', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), openError: 'Launch failed' });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  for (const target of [undefined, 'C:/tmp/missing.txt', 'C:/private.txt', 'C:/tmp']) await panel.receive({ type: 'open', path: target });
  assert.deepEqual(app.openCalls, []);
  await panel.receive({ type: 'open', path: 'C:/tmp/a.txt' });
  assert.deepEqual(app.openCalls, ['C:/tmp/a.txt']);
  assert.ok(app.errors.some(message => message.includes('Launch failed')));
  assert.equal(app.textDocuments.length, 0);
});

test('Enter activates an unmarked cursor file while another file remains marked', async t => {
  const state = clipboardFixture();
  state.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  state.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', fsSource: 'C:/tmp/b.txt' });
  state.panes[0].selected = ['b']; state.panes[0].cursor = 'a';
  const app = harness(t, { filesystemLoad: async () => state });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: panel.webview.html });
  view.key('Enter', {}, view.row('a.txt').closest('.list'));
  const messages = view.messages.filter(message => message.type === 'open');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].path, 'C:/tmp/a.txt');
  assert.deepEqual(view.state().panes[0].selected, ['b']);
  await panel.receive(messages[0]);
  assert.deepEqual(app.openCalls, ['C:/tmp/a.txt']);
});

test('markdown preview opens a document in the same group then invokes its renderer', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'preview', content: '# Title', language: 'markdown' });
  assert.equal(app.textDocuments[0].language, 'markdown');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 3, preview: false });
  const preview = app.calls.find(call => call.id === 'markdown.showPreview');
  assert.equal(preview.args[0], app.textDocuments[0].uri);
});

test('plain previews use the active group fallback if no column is available', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  app.panels[0].viewColumn = undefined;
  await app.panels[0].receive({ type: 'preview', content: 'plain' });
  assert.deepEqual(app.textEditors[0].options, { viewColumn: -1, preview: false });
});

test('unknown messages and invalid document payloads cannot open editors', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  for (const message of [null, {}, { type: 'unrelated' }, { type: 'edit', content: 12 }, { type: 'preview', content: 'x'.repeat(100001) }]) await app.panels[0].receive(message);
  assert.equal(app.textDocuments.length, 0);
});

test('input focus messages update both independent context guards', async t => {
  const app = harness(t);
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: false, list: true });
  assert.equal(app.contexts.get('bitfroest.textInput'), false);
  assert.equal(app.contexts.get('bitfroest.listFocus'), true);
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false });
  assert.equal(app.contexts.get('bitfroest.textInput'), true);
  assert.equal(app.contexts.get('bitfroest.listFocus'), false);
});

test('registered file actions are inert without a panel and forwarded when one exists', async t => {
  const app = harness(t);
  await app.command('bitfroest.copy');
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.copy');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'action', action: 'copy' });
});

test('real directories replace stored example contents on opening', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'snapshot-1', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real });
  await app.command('bitfroest.openPrototype');
  assert.match(app.panels[0].webview.html, /snapshot-1/);
  assert.match(app.panels[0].webview.html, /realFilesystem/);
});

test('real filesystem changes are committed before a fresh snapshot is returned', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const applied = [];
  const app = harness(t, { filesystemLoad: async () => real, filesystemApply: async (before, after) => { applied.push([before, after]); return { ...after, snapshotId: 'two' }; } });
  await app.command('bitfroest.openPrototype');
  const after = structuredClone(real); after.folders['C:/tmp'].push({ id: 'new', name: 'new', type: 'folder' }); after.folders['C:/tmp/new'] = [];
  await app.panels[0].receive({ type: 'filesystem-apply', state: after });
  assert.equal(applied.length, 1);
  assert.equal(app.panels[0].messages.at(-1).state.snapshotId, 'two');
});

test('filesystem errors restore a fresh directory view and report failure', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real, filesystemApply: async () => { throw new Error('Target changed'); } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-apply', state: real });
  assert.match(app.panels[0].messages.at(-1).error, /Target changed/);
  assert.deepEqual(app.errors, []);
  assert.equal(app.panels[0].messages.at(-1).type, 'filesystem-result');
  assert.equal(app.panels[0].messages.at(-1).ok, false);
});

test('structured recovery failures reach notifications and the webview in the interface language with unchanged paths', async t => {
  const { createOperationError } = require('../operation-errors');
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  real.panes.forEach(pane => Object.assign(pane, { selected: [], cursor: null, filter: '', sort: 'name' }));
  const recoveryPath = 'C:/tmp/Neuer Ordner/Dateioperation fehlgeschlagen.stage';
  const failure = createOperationError('recovery-incomplete', { cause: new Error('Sicherungsdatei extern verändert.'), paths: [recoveryPath] });
  const app = harness(t, { language: 'en', filesystemLoad: async () => real, filesystemApply: async () => { throw failure; } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-apply', state: real });
  const result = app.panels[0].messages.at(-1);
  assert.equal(result.ok, false);
  assert.match(result.error, /Recovery is incomplete/);
  assert.match(result.error, /A backup file changed externally/);
  assert.ok(result.error.includes(recoveryPath));
  assert.deepEqual(app.errors, []);
  const view = require('./support/webview.cjs').createApp(t, real, { html: app.panels[0].webview.html });
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  assert.ok(view.document.querySelector('.operation-error-text').value.includes(recoveryPath));
  assert.match(view.document.querySelector('#status-message').textContent, /Recovery is incomplete/);
});

test('workspace state is restored into the HTML safely and saved serially', async t => {
  const gate = deferred(); let held = false;
  const initial = { name: '<folder> "quoted" & safe' };
  const app = harness(t, {
    workspaceState: { fileManagerState: initial },
    update: async (store, key) => { if (store === 'workspace' && key === 'fileManagerState' && !held) { held = true; await gate.promise; } }
  });
  await app.command('bitfroest.openPrototype');
  assert.ok(app.panels[0].webview.html.includes('&lt;folder>'));
  assert.ok(app.panels[0].webview.html.includes('&quot;'));
  const first = app.panels[0].receive({ type: 'state', state: { order: 1 } });
  const second = app.panels[0].receive({ type: 'state', state: { order: 2 } });
  await tick();
  assert.equal(app.updateCalls.filter(call => call.key === 'fileManagerState').length, 1);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(app.context.workspaceState.get('fileManagerState'), { order: 2 });
  assert.equal(app.context.globalState.get('fileManagerState'), undefined);
});

test('a storage error is reported and later state saves can recover', async t => {
  let fail = true;
  const app = harness(t, { update: async () => { if (fail) { fail = false; throw new Error('Storage unavailable'); } } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'state', state: { order: 1 } });
  await app.panels[0].receive({ type: 'state', state: { order: 2 } });
  assert.match(app.errors[0], /Storage unavailable/);
  assert.deepEqual(app.context.workspaceState.get('fileManagerState'), { order: 2 });
});

test('workspace and global modes use separate mementos and restore the chosen layout', async t => {
  const local = { source: 'workspace' }, shared = { source: 'global' };
  const app = harness(t, { workspaceState: { fileManagerState: local }, globalState: { fileManagerState: shared }, choices: ['global', 'workspace'] });
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.context.workspaceState.get('tabScope'), 'global');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Global');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'restore', resetViews: true, state: shared });
  await app.panels[0].receive({ type: 'state', state: { source: 'global-updated' } });
  assert.deepEqual(app.context.globalState.get('fileManagerState'), { source: 'global-updated' });
  assert.deepEqual(app.context.workspaceState.get('fileManagerState'), local);
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Arbeitsbereich');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'restore', resetViews: true, state: local });
});

test('first use of another mode copies the current layout, including when closed', async t => {
  const local = { source: 'current' };
  const app = harness(t, { workspaceState: { fileManagerState: local }, choices: ['global'] });
  await app.command('bitfroest.chooseTabMode');
  assert.deepEqual(app.context.globalState.get('fileManagerState'), local);
  assert.equal(app.panels.length, 0);
});

test('cancelled or unchanged tab-mode choices do not write storage', async t => {
  const app = harness(t, { choices: [undefined, 'workspace'] });
  await app.command('bitfroest.chooseTabMode');
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.updateCalls.length, 0);
  assert.equal(app.quickPicks[1].items[0].description, 'Aktiv');
});

test('an empty window defaults to global mode and respects a stored scope preference', async t => {
  const app = harness(t, { noWorkspace: true, globalState: { fileManagerState: { shared: true } } });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Global');
  await app.panels[0].receive({ type: 'state', state: { shared: 'updated' } });
  assert.deepEqual(app.context.globalState.get('fileManagerState'), { shared: 'updated' });
});

test('stored global preference wins even when a workspace is open', async t => {
  const app = harness(t, { workspaceState: { tabScope: 'global' }, choices: ['workspace'] });
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels[0].title, 'Bitfroest.fs · Global');
  await app.command('bitfroest.chooseTabMode');
  assert.equal(app.quickPicks[0].items[1].description, 'Aktiv');
});

test('only an icon-theme configuration change rebuilds an open panel', async t => {
  const app = harness(t);
  await app.configuration('workbench.iconTheme');
  assert.equal(app.panels.length, 0);
  await app.command('bitfroest.openPrototype');
  await app.configuration('editor.fontSize');
  assert.equal(app.panels.length, 1);
  await app.configuration('workbench.iconTheme');
  assert.equal(app.panels.length, 2);
  assert.equal(app.panels[0].disposed, true);
});

test('activation leaves closed panels closed in production and development with saved tabs', async t => {
  for (const development of [false, true]) {
    let loads = 0;
    const app = harness(t, { development, workspaceState: { fileManagerState: clipboardFixture() }, filesystemLoad: async () => { loads++; return clipboardFixture(); } });
    await tick();
    assert.equal(app.panels.length, 0);
    assert.equal(loads, 0);
    assert.ok(app.serializer);
    assert.ok(manifest.activationEvents.includes('onWebviewPanel:bitfroestPrototype'));
    await app.command('bitfroest.openPrototype');
    app.panels[0].dispose();
    assert.equal(app.panels.filter(panel => !panel.disposed).length, 0);
  }
});

test('restart rehydrates the existing panel with fresh lists and working host events', async t => {
  const saved = clipboardFixture(); saved.active = 1;
  for (const pane of saved.panes) Object.assign(pane, { filter: '', sort: 'name' });
  const fresh = clipboardFixture(); fresh.folders['C:/tmp'][0].name = 'fresh.txt';
  const app = harness(t, { manualReadiness: true, workspaceState: { fileManagerState: saved }, filesystemLoad: async () => fresh });
  const panel = app.restoredPanel();
  assert.ok(app.serializer, 'restart requires a registered serializer');
  await app.serializer.deserializeWebviewPanel(panel, saved);
  assert.equal(app.panels.length, 1);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.ok(panel.webview.options.localResourceRoots.length >= 1);
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  assert.equal(app.nativeCalls.length, 0);
  const view = require('./support/webview.cjs').createApp(t, saved, { html: panel.webview.html });
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.ok([...view.document.scripts].every(script => script.nonce));
  assert.ok(view.document.querySelector('[data-pane="0"] td[title="fresh.txt"]'));
  assert.equal(view.document.querySelector('.pane.active').dataset.pane, '1');
  for (const message of view.messages) await panel.receive(message);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
  await app.command('bitfroest.refresh');
  assert.equal(panel.messages.at(-1).type, 'action');
  assert.equal(panel.messages.at(-1).action, 'refresh');
  await app.command('bitfroest.openPrototype');
  assert.equal(panel.disposed, true);
});

test('closing a restored panel while directories load does not reopen it', async t => {
  const loading = deferred();
  const app = harness(t, { filesystemLoad: () => loading.promise });
  const panel = app.restoredPanel();
  assert.ok(app.serializer);
  const restoring = app.serializer.deserializeWebviewPanel(panel, clipboardFixture());
  await tick(); panel.dispose(); loading.resolve(clipboardFixture()); await restoring;
  assert.equal(app.panels.length, 1);
  assert.equal(panel.webview.html, '');
  assert.equal(app.calls.some(call => call.id === 'workbench.action.moveEditorToNewWindow'), false);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2);
});

test('failed restoration closes the unusable panel and permits a manual retry', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { if (++loads === 1) throw new Error('Unavailable'); return clipboardFixture(); } });
  const panel = app.restoredPanel();
  assert.ok(app.serializer);
  await app.serializer.deserializeWebviewPanel(panel, null);
  assert.equal(panel.disposed, true);
  assert.equal(app.errors.length, 1);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
});

test('a restore delivered during manual opening leaves one initialized owner', async t => {
  const loading = deferred();
  const app = harness(t, { filesystemLoad: () => loading.promise });
  const opening = app.command('bitfroest.openPrototype');
  const restored = app.restoredPanel();
  const restoring = app.serializer.deserializeWebviewPanel(restored, null);
  loading.resolve(clipboardFixture()); await opening; await restoring;
  const remaining = app.panels.filter(panel => !panel.disposed);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].webview.html, /Content-Security-Policy/);
});

test('a resource initialization failure releases the restored panel and opening guard', async t => {
  const app = harness(t, { theme: async (attempt, icons) => { if (attempt === 1) throw new Error('Theme unavailable'); return icons; } });
  const panel = app.restoredPanel();
  await assert.rejects(app.serializer.deserializeWebviewPanel(panel, null), /Theme unavailable/);
  assert.equal(panel.disposed, true);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 2);
});

test('native icon requests map known mock paths and return their keyed image results', async t => {
  let captured;
  const icon = 'data:image/png;base64,AA==';
  const app = harness(t, { filesystemIcons: async requests => { captured = requests; return { '/workspace/bitfroest/README.md': icon }; } });
  await app.command('bitfroest.openPrototype');
  const requests = [
    { key: '/workspace/bitfroest/README.md', path: '/workspace/bitfroest/README.md', name: 'README.md', type: 'file' },
    { key: '/home/demo/Downloads', path: '/home/demo/Downloads', name: 'Downloads', type: 'folder' },
    { key: '/home/demo/Backups/archive.zip', path: '/home/demo/Backups/archive.zip', name: 'archive.zip', type: 'file' },
    { key: '/home/demo/Downloads/demo.zip!/README.md', path: '/home/demo/Downloads/demo.zip!/README.md', name: 'README.md', type: 'file' }
  ];
  await app.panels[0].receive({ type: 'icons', requests });
  assert.ok(captured, 'The native icon provider must receive the request.');
  assert.equal(captured[0].path, path.join(root, 'workspace', 'README.md'));
  assert.equal(captured[1].path, path.join(os.homedir(), 'Downloads'));
  assert.equal(captured[2].path, path.join(os.homedir(), 'Backups', 'archive.zip'));
  assert.equal(captured[3].path, '');
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'icons', icons: { '/workspace/bitfroest/README.md': icon } });
});

test('native icons cannot turn remote workspace paths or arbitrary supplied paths into local reads', async t => {
  let captured;
  const app = harness(t, { workspaceScheme: 'vscode-remote', filesystemIcons: async requests => { captured = requests; return {}; } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'icons', requests: [
    { key: '/workspace/bitfroest/README.md', path: '/workspace/bitfroest/README.md', name: 'README.md', type: 'file' },
    { key: 'foreign', path: path.join(os.homedir(), 'private.txt'), name: 'private.txt', type: 'file' }
  ] });
  assert.ok(captured);
  assert.ok(captured.every(request => request.path === ''));
});

test('native icon request limits and malformed rows do not reach the provider', async t => {
  const providerCalls = [];
  const app = harness(t, { filesystemIcons: async requests => { providerCalls.push(requests); return {}; } });
  await app.command('bitfroest.openPrototype');
  const valid = { key: '/workspace/bitfroest/a.txt', path: '/workspace/bitfroest/a.txt', name: 'a.txt', type: 'file' };
  await app.panels[0].receive({ type: 'icons', requests: Array.from({ length: 129 }, () => valid) });
  await app.panels[0].receive({ type: 'icons', requests: 'invalid' });
  assert.equal(providerCalls.length, 0);
  await app.panels[0].receive({ type: 'icons', requests: [
    null, {}, { ...valid, key: 12 }, { ...valid, path: 12 }, { ...valid, name: 12 }, { ...valid, type: 'device' },
    { ...valid, name: 'x'.repeat(100000) }, { ...valid, path: 'x'.repeat(100000) }, valid
  ] });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].length, 1);
  assert.equal(providerCalls[0][0].key, valid.key);
});

test('closing or replacing the panel during lookup cannot deliver stale icon results', async t => {
  const barrier = deferred(); let started = false;
  const app = harness(t, { filesystemIcons: async () => { started = true; return barrier.promise; } });
  await app.command('bitfroest.openPrototype');
  const first = app.panels[0];
  const lookup = first.receive({ type: 'icons', requests: [{ key: '/workspace/bitfroest/a.txt', path: '/workspace/bitfroest/a.txt', name: 'a.txt', type: 'file' }] });
  await tick();
  assert.equal(started, true);
  first.dispose();
  await app.command('bitfroest.openPrototype');
  barrier.resolve({ '/workspace/bitfroest/a.txt': 'data:image/png;base64,AA==' });
  await lookup;
  assert.equal(first.messages.some(message => message.type === 'icons'), false);
  assert.equal(app.panels[1].messages.some(message => message.type === 'icons'), false);
});

test('failed icon lookup preserves fallback rendering through an empty response', async t => {
  const app = harness(t, { filesystemIcons: async () => { throw new Error('Native icon unavailable'); } });
  await app.command('bitfroest.openPrototype');
  await assert.doesNotReject(app.panels[0].receive({ type: 'icons', requests: [{ key: '/workspace/bitfroest/a.txt', path: '/workspace/bitfroest/a.txt', name: 'a.txt', type: 'file' }] }));
  assert.deepEqual(app.panels[0].messages.at(-1), { type: 'icons', icons: {} });
});

test('column settings and UI language are injected and settings changes are broadcast', async t => {
  const configuration = { 'columns.activeSet': 'custom', 'columns.sets': [{ id: 'custom', name: 'Custom', columns: [{ id: 'full', title: 'Filename', field: '[=tc.fullname]', width: 330 }] }] };
  const app = harness(t, { language: 'en-US', configuration });
  await app.command('bitfroest.openPrototype');
  const html = app.panels[0].webview.html;
  assert.match(html, /data-language="en-US"/);
  assert.match(html, /data-column-settings=/);
  assert.match(html, /Filename/);
  await app.configuration('bitfroest.columns');
  assert.equal(app.panels[0].messages.at(-1).type, 'column-settings');
  assert.equal(app.panels[0].messages.at(-1).settings.activeSet, 'custom');
});

test('native column tables reach the webview on startup and after configuration changes', async t => {
  const configuration = { 'columns.names': { reports: 'Reports' }, 'columns.fields': { 'reports.file': '[=tc.fullname]' }, 'columns.titles': { 'reports.file': 'My heading' }, 'columns.widths': { 'reports.file': 350 }, 'columns.activeSet': 'reports' };
  const app = harness(t, { language: 'en', configuration });
  await app.command('bitfroest.openPrototype');
  const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
  const settings = JSON.parse(decodeURIComponent(encoded));
  assert.equal(settings.sets[0].columns[0].title, 'My heading');
  assert.equal(settings.sets[0].columns[0].width, 350);
  const { createApp } = require('./support/webview.cjs');
  const view = createApp(t, null, { html: app.panels[0].webview.html });
  assert.equal(view.document.querySelector('[data-sort="file"]').textContent, 'My heading');
  assert.equal(view.document.querySelector('[data-col="file"]').getAttribute('width'), '350');
  configuration['columns.widths']['reports.file'] = 450;
  await app.configuration('bitfroest.columns');
  assert.equal(app.panels[0].messages.at(-1).settings.sets[0].columns[0].width, 450);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: app.panels[0].messages.at(-1) }));
  assert.equal(view.document.querySelector('[data-col="file"]').getAttribute('width'), '450');
  assert.equal(app.updateCalls.filter(call => call.store === 'configuration').length, 0);
});

test('default column tables follow the extension language without changing user headings', async t => {
  for (const [language, expected] of [['de', 'Größe'], ['en', 'Size']]) {
    const app = harness(t, { language: 'en', configuration: { language } });
    await app.command('bitfroest.openPrototype');
    const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
    assert.equal(JSON.parse(decodeURIComponent(encoded)).sets[0].columns.find(column => column.id === 'size').title, expected);
  }
  const app = harness(t, { language: 'en', configuration: { 'columns.titles': { 'standard.size': 'Eigene Größe' } } });
  await app.command('bitfroest.openPrototype');
  const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).sets[0].columns.find(column => column.id === 'size').title, 'Eigene Größe');
});

test('default tables do not replace saved legacy sets until a new table is explicitly configured', async t => {
  const configurationDefaults = Object.fromEntries(Object.entries(Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties))).filter(([key]) => key.startsWith('bitfroest.columns.')).map(([key, schema]) => [key.slice('bitfroest.'.length), schema.default]));
  const configuration = { 'columns.sets': [{ id: 'legacy', name: 'Legacy', columns: [{ id: 'own', title: 'Saved title', field: '[=tc.name]' }] }] };
  const app = harness(t, { configuration, configurationDefaults });
  await app.command('bitfroest.openPrototype');
  const encoded = /data-column-settings="([^"]+)"/.exec(app.panels[0].webview.html)[1];
  assert.equal(JSON.parse(decodeURIComponent(encoded)).sets[0].id, 'legacy');
  configuration['columns.names'] = { standard: 'Standard' };
  await app.configuration('bitfroest.columns');
  assert.equal(app.panels[0].messages.at(-1).settings.sets[0].id, 'standard');
  assert.equal(configuration['columns.sets'][0].columns[0].title, 'Saved title');
});

test('real editor requests open the source URI and reject untrusted paths without dummy documents', async t => {
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [{ id: 'source', name: 'real.txt', type: 'text', fsSource: 'C:/tmp/real.txt' }], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'edit', path: 'C:/tmp/real.txt', content: '' });
  assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/real.txt');
  assert.deepEqual(app.textEditors[0].options, { viewColumn: 1, preview: false });
  for (const bad of ['C:/secret.txt', 'C:/tmp/not-in-snapshot.txt', undefined]) {
    await app.panels[0].receive({ type: 'edit', path: bad, content: 'dummy' });
  }
  assert.equal(app.textDocuments.length, 1);
});

test('host errors use the selected display language', async t => {
  const app = harness(t, { language: 'en', filesystemLoad: async () => { throw new Error('ENOENT'); } });
  await app.command('bitfroest.openPrototype');
  assert.match(app.errors[0], /Test directories could not be loaded/);
});

test('real filesystem persistence stores the layout without file contents or source snapshots', async t => {
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'sensitive-snapshot', folders: { 'C:/tmp': [{ id: 'a', name: 'secret.txt', content: 'sensitive-content', fsSource: 'C:/tmp/secret.txt' }], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => structuredClone(real) });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'state', state: real });
  const persisted = app.context.workspaceState.values.get('fileManagerState');
  assert.deepEqual(persisted.panes, real.panes); assert.equal(persisted.realFilesystem, true);
  assert.equal(persisted.folders, undefined); assert.equal(persisted.snapshotId, undefined);
  assert.equal(JSON.stringify(persisted).includes('sensitive-content'), false);
});

test('real URI editor requests accept large text previews without applying the mock document limit', async t => {
  const real = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [{ id: 'source', name: 'large.txt', fsSource: 'C:/tmp/large.txt' }], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real }); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'edit', path: 'C:/tmp/large.txt', content: 'x'.repeat(100001) });
  assert.equal(app.textDocuments.length, 1); assert.equal(app.textDocuments[0].fsPath, 'C:/tmp/large.txt');
});

function lazyState() {
  return {version:1,realFilesystem:true,snapshotId:'one',active:0,unloadedFolders:['C:/tmp/docs'],folders:{'C:/tmp':[{id:'docs',name:'docs',type:'folder',fsSource:'C:/tmp/docs'}],'C:/tmp/docs':[],'C:/temp':[]},panes:[{tabs:['C:/tmp'],tab:0,selected:['docs'],cursor:'docs'},{tabs:['C:/temp'],tab:0,selected:[]}]};
}

test('initial view without saved tabs loads the configured roots instead of deferring them', async t => {
  const loads = [];
  const app = harness(t, { filesystemLoad: async settings => { loads.push(settings); return lazyState(); } });
  await app.command('bitfroest.openPrototype');
  assert.equal(loads[0]?.visibleOnly, undefined);
});
test('lazy navigation prepares only its requested directory and resumes the original pane', async t => {
  const state = lazyState(), preparations=[];
  const app = harness(t,{filesystemLoad:async()=>state,filesystemPrepare:async(before,options)=>{preparations.push({before,options});return {...state,snapshotId:'two',unloadedFolders:[],folders:{...state.folders,'C:/tmp/docs':[{id:'a',name:'a.txt'}]}};}});
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({type:'filesystem-navigate',path:'C:/tmp/docs',side:0,state});
  assert.deepEqual(preparations[0].options,{directories:['C:/tmp/docs'],recursive:false,navigation:true,visibleDirectories:['C:/tmp/docs','C:/temp']});
  assert.equal(preparations[0].before.snapshotId,'one');
  const response=app.panels[0].messages.at(-1); assert.equal(response.ok,true); assert.deepEqual(response.resumeNavigation,{path:'C:/tmp/docs',side:0}); assert.equal(response.state.snapshotId,'two');
});
test('folder action preparation is recursive and preserves the pending action without mutating', async t => {
  const state=lazyState(), preparations=[]; let applied=false;
  const app=harness(t,{filesystemLoad:async()=>state,filesystemPrepare:async(before,options)=>{preparations.push(options);return {...before,snapshotId:'two',unloadedFolders:[]};},filesystemApply:async()=>{applied=true;}});
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({type:'filesystem-prepare',paths:['C:/tmp/docs'],action:'delete',state});
  assert.deepEqual(preparations,[{directories:['C:/tmp/docs'],recursive:true}]); assert.equal(applied,false); assert.equal(app.panels[0].messages.at(-1).resumeAction,'delete');
});
test('refresh reloads only active folder tabs and defers inactive tabs without reading them', async t => {
  const state=lazyState(); state.panes[0].tabs.push('C:/tmp/docs'); const loads=[];
  const app=harness(t,{filesystemLoad:async options=>{loads.push(options);return state;}});
  await app.command('bitfroest.openPrototype'); await app.panels[0].receive({type:'filesystem-refresh',state});
  assert.deepEqual(loads.at(-1),{directories:['C:/tmp','C:/temp'],deferredDirectories:['C:/tmp/docs'],visibleOnly:true});
});


test('tab scope picker uses the selected display language',async t=>{
 const app=harness(t,{language:'en'});await app.command('bitfroest.chooseTabMode');
 assert.equal(app.quickPicks[0].items[0].label,'Workspace');assert.equal(app.quickPicks[0].items[0].description,'Active');assert.equal(app.quickPicks[0].options.title,'Save folder tabs');
});

test('reopening waits for an in-flight preparation before loading the replacement window snapshot',async t=>{
 const state=lazyState(),pending=deferred();let loads=0;
 const app=harness(t,{filesystemLoad:async()=>({...state,snapshotId:`load-${++loads}`}),filesystemPrepare:()=>pending.promise});
 await app.command('bitfroest.openPrototype');const old=app.panels[0];const preparing=old.receive({type:'filesystem-prepare',paths:['C:/tmp/docs'],action:'copy',state});await tick();old.dispose();
 const reopening=app.command('bitfroest.openPrototype');await tick();assert.equal(loads,1);assert.equal(app.panels.length,1);
 pending.resolve({...state,snapshotId:'prepared',unloadedFolders:[]});await preparing;await reopening;
 assert.equal(loads,2);assert.equal(old.messages.some(message=>message.type==='filesystem-result'),false);assert.match(app.panels[1].webview.html,/load-2/);
});


test('real delete passes useTrash explicitly to the VS Code filesystem adapter', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'delete', folders: { 'C:/tmp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { filesystemLoad: async () => real, filesystemRemove: async (before, request, options) => { await options.deletePath(request.paths[0], { useTrash: request.useTrash, recursive: true }); return real; } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-delete', paths: ['C:/tmp/a.txt'], useTrash: true, state: real });
  assert.equal(app.deleteCalls.length, 1);
  assert.equal(app.deleteCalls[0].uri.fsPath, 'C:/tmp/a.txt');
  assert.deepEqual(app.deleteCalls[0].options, { recursive: true, useTrash: true });
  assert.equal(app.panels[0].messages.at(-1).ok, true);
});

test('a partial native delete failure reports its completed count in the interface language', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'delete', folders: { 'C:/tmp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  const app = harness(t, { language: 'en', filesystemLoad: async () => real, filesystemRemove: async () => {
    const error = new Error('internal', { cause: new Error('Die native Löschfunktion ist nicht verfügbar.') }); error.deletedCount = 1; throw error;
  } });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'filesystem-delete', paths: ['C:/tmp/a.txt'], useTrash: true, state: real });
  assert.match(app.panels[0].messages.at(-1).error, /Deletion failed after 1 items: Native file deletion is not available\./);
  assert.deepEqual(app.errors, []);
  assert.equal(app.panels[0].messages.at(-1).ok, false);
});

test('conflict comparison opens validated real resources in the existing diff group without preview documents',async t=>{
 const state=lazyState();state.folders['C:/tmp'].push({id:'source',name:'source.bin',fsSource:'C:/tmp/source.bin',type:'binary'});state.folders['C:/temp']=[{id:'target',name:'target.bin',fsSource:'C:/temp/target.bin',type:'binary'}];
 const app=harness(t,{filesystemLoad:async()=>state});await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'compare',sourcePath:'C:/tmp/source.bin',targetPath:'C:/temp/target.bin'});
 const command=app.calls.find(call=>call.id==='vscode.diff');assert.ok(command);assert.equal(command.args[0].scheme,'bitfroest-conflict');assert.equal(command.args[1].scheme,'bitfroest-conflict');assert.deepEqual(app.readonlyPaths,['C:/temp/target.bin','C:/tmp/source.bin']);assert.deepEqual(command.args[3],{viewColumn:3,preview:false});assert.equal(app.textDocuments.length,0);
 for(const message of [{type:'compare',sourcePath:'C:/secret',targetPath:'C:/temp/target.bin'},{type:'compare',sourcePath:'C:/tmp/missing',targetPath:'C:/temp/target.bin'},{type:'compare',sourcePath:'C:/tmp/docs',targetPath:'C:/temp/target.bin'}])await app.panels[0].receive(message);
 assert.equal(app.calls.filter(call=>call.id==='vscode.diff').length,1);
});
test('conflict shortcut context is distinct from list focus and is cleared when the panel closes',async t=>{
 const app=harness(t);await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'inputFocus',value:true,list:false,conflict:true});assert.equal(app.contexts.get('bitfroest.conflictDialog'),true);app.panels[0].dispose();assert.equal(app.contexts.get('bitfroest.conflictDialog'),false);
 const binding=manifest.contributes.keybindings.find(item=>item.command==='bitfroest.conflict-compare');assert.ok(binding);assert.match(binding.when,/bitfroest.conflictDialog/);assert.doesNotMatch(binding.when,/listFocus|!bitfroest.textInput/);
});
test('transfer name shortcuts have a separate text-field context and clear it on disposal', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false, transferName: true });
  assert.equal(app.contexts.get('bitfroest.transferNameInput'), true);
  for (const key of ['f5', 'f6']) {
    const binding = manifest.contributes.keybindings.find(item => item.key === key && item.command === 'bitfroest.transfer-name-parts');
    assert.ok(binding);
    assert.equal(binding.when.replace(/ && !bitfroest\.shortcutOverride\.[a-z0-9]+$/, ''), 'activeWebviewPanelId == bitfroestPrototype && webviewFocus && bitfroest.transferNameInput && bitfroest.textInput');
    assert.match(binding.when, / && !bitfroest\.shortcutOverride\.[a-z0-9]+$/);
  }
  app.command('bitfroest.transfer-name-parts');
  assert.ok(app.panels[0].messages.some(item => item.type === 'action' && item.action === 'transfer-name-parts'));
  const startBinding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.transfer-name-start');
  assert.equal(startBinding?.key, 'ctrl+home'); assert.match(startBinding.when, /bitfroest.transferNameInput/);
  app.command('bitfroest.transfer-name-start'); assert.equal(app.panels[0].messages.at(-1).action, 'transfer-name-start');
  app.panels[0].dispose(); assert.equal(app.contexts.get('bitfroest.transferNameInput'), false);
});
test('other file-dialog fields consume plain function keys only inside their own webview', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false, dialog: true, transferName: false });
  assert.equal(app.contexts.get('bitfroest.fileDialog'), true);
  for (const key of ['f5', 'f6']) {
    const binding = manifest.contributes.keybindings.find(item => item.key === key && item.command === 'bitfroest.ignore-dialog-function-key');
    assert.equal(binding?.when, 'activeWebviewPanelId == bitfroestPrototype && webviewFocus && bitfroest.fileDialog && !bitfroest.transferNameInput');
  }
  await app.command('bitfroest.ignore-dialog-function-key');
  app.panels[0].dispose(); assert.equal(app.contexts.get('bitfroest.fileDialog'), false);
});
test('inline Shift F6 has its own text-input context and is cleared on disposal', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'inputFocus', value: true, list: false, inlineRename: true });
  assert.equal(app.contexts.get('bitfroest.inlineRenameInput'), true);
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.rename-one' && item.when.includes('inlineRenameInput'));
  assert.equal(binding?.key, 'shift+f6'); assert.match(binding.when, /activeWebviewPanelId == bitfroestPrototype && webviewFocus/);
  app.panels[0].dispose(); assert.equal(app.contexts.get('bitfroest.inlineRenameInput'), false);
});
test('trash opening is requested only by the current visible panel without filesystem mutations', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'open-trash', path: 'C:/untrusted' }); assert.deepEqual(app.trashCalls, ['open']);
  assert.equal(panel.messages.at(-1).type, 'open-trash-result'); assert.equal(panel.messages.at(-1).ok, true); assert.equal(app.deleteCalls.length, 0);
  panel.visible = false; await panel.receive({ type: 'open-trash' }); assert.equal(app.trashCalls.length, 1);
  panel.dispose(); await panel.receive({ type: 'open-trash' }); assert.equal(app.trashCalls.length, 1);
});
test('trash opening errors are localized and forwarded as persistent UI failures', async t => {
  const app = harness(t, { language: 'en', trashError: 'Der Papierkorb konnte nicht geöffnet werden.' }); await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'open-trash' });
  assert.equal(app.panels[0].messages.at(-1).ok, false); assert.equal(app.panels[0].messages.at(-1).error, 'The trash could not be opened.');
  assert.equal(app.errors.at(-1), 'The trash could not be opened.');
});
test('closing the requesting panel prevents late trash-launch results from reviving its UI', async t => {
  for (const ok of [true, false]) {
    const pending = deferred(), app = harness(t, { trashOpen: () => pending.promise }); await app.command('bitfroest.openPrototype');
    const panel = app.panels[0], request = panel.receive({ type: 'open-trash' }); panel.dispose();
    if (ok) pending.resolve({ requested: true }); else pending.reject(new Error('Blocked'));
    await request; assert.equal(panel.messages.some(item => item.type === 'open-trash-result'), false); assert.equal(app.errors.length, 0);
  }
});
test('right-drop choices use a native localized picker with only copy, move and cancellation', async t => {
  for (const action of ['copy', 'move', 'cancel', undefined]) {
    const app = harness(t, { language: 'en', choices: [action] }); await app.command('bitfroest.openPrototype');
    await app.panels[0].receive({ type: 'choose-drop-action', requestId: 'right-drop-1' });
    assert.deepEqual(app.quickPicks.at(-1).items.map(item => item.label), ['Copy here', 'Move here', 'Cancel']);
    assert.deepEqual(app.panels[0].messages.at(-1), { type: 'drop-action-result', requestId: 'right-drop-1', action: action || 'cancel' });
    assert.equal(app.deleteCalls.length, 0);
    const count = app.quickPicks.length; await app.panels[0].receive({ type: 'choose-drop-action', requestId: '../bad' }); assert.equal(app.quickPicks.length, count);
  }
});

test('file clipboard writes only snapshot-backed paths and returns its native ticket', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype');
  const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'one', paths: ['C:/outside/private.txt'], mode: 'copy' });
  assert.equal(app.clipboardCalls.length, 0);
  await panel.receive({ type: 'clipboard-write', requestId: 'two', paths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(app.clipboardCalls.length, 1);
  assert.equal(panel.messages.at(-1).selection.token, 'clip-1');
  assert.equal(panel.messages.at(-1).requestId, 'two');
});

test('file clipboard cut acknowledgement requires a real host commit and exact remaining sources', async t => {
  const state = clipboardFixture();
  const app = harness(t, { filesystemLoad: async () => state, clipboardSelection: { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'native-one' }, filesystemApply: async (before, after) => after });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-read', requestId: 'read' });
  const request = { type: 'clipboard-ack', requestId: 'ack', token: 'native-one', paths: ['C:/tmp/a.txt'], mode: 'move', remainingPaths: [] };
  await panel.receive(request);
  assert.equal(app.clipboardCalls.filter(call => call.action === 'ack').length, 0);
  const after = structuredClone(state); after.folders['C:/tmp'] = []; after.folders['C:/temp'] = [{ id: 'copy', name: 'a.txt', type: 'text', fsSource: 'C:/temp/a.txt' }];
  await panel.receive({ type: 'filesystem-apply', state: after });
  await panel.receive(request);
  assert.equal(app.clipboardCalls.filter(call => call.action === 'ack').length, 1);
  assert.equal(panel.messages.at(-1).matched, true);
});

test('file clipboard errors cannot report successful system export', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), clipboardError: 'Clipboard busy' });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'clipboard-write', requestId: 'busy', paths: ['C:/tmp/a.txt'], mode: 'copy' });
  assert.equal(app.panels[0].messages.at(-1).ok, false);
  assert.match(app.panels[0].messages.at(-1).error, /Clipboard busy/);
});

test('clipboard commands and shortcuts are registered only for focused file lists', async t => {
  const app = harness(t); await app.command('bitfroest.openPrototype');
  for (const [action,key] of [['clipboard-copy','c'],['clipboard-cut','x'],['clipboard-paste','v']]) {
    const binding = manifest.contributes.keybindings.find(item => item.command === `bitfroest.${action}`);
    assert.equal(binding.key, `ctrl+${key}`); assert.equal(binding.mac, `cmd+${key}`);
    assert.match(binding.when, /bitfroest.listFocus/); assert.match(binding.when, /!bitfroest.textInput/);
    await app.command(`bitfroest.${action}`);
    assert.equal(app.panels[0].messages.at(-1).action, action);
  }
});

test('conflict previews and diff use read-only filesystem resources instead of editable original URIs',async t=>{
 const state=lazyState();state.folders['C:/tmp'].push({id:'file',name:'file.txt',type:'text',fsSource:'C:/tmp/file.txt'});state.folders['C:/temp']=[{id:'target',name:'target.txt',type:'text',fsSource:'C:/temp/target.txt'}];
 const app=harness(t,{filesystemLoad:async()=>state});await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'conflict-preview',path:'C:/tmp/file.txt',language:'plaintext'});assert.equal(app.calls.find(call=>call.id==='vscode.open').args[0].scheme,'bitfroest-conflict');assert.equal(app.textDocuments.length,0);
 await app.panels[0].receive({type:'compare',sourcePath:'C:/tmp/file.txt',targetPath:'C:/temp/target.txt'});const command=app.calls.find(call=>call.id==='vscode.diff');assert.equal(command.args[0].scheme,'bitfroest-conflict');assert.equal(command.args[1].scheme,'bitfroest-conflict');assert.deepEqual(app.readonlyPaths,['C:/tmp/file.txt','C:/temp/target.txt','C:/tmp/file.txt']);
});

test('binary conflict previews use the native resource opener rather than forcing text documents',async t=>{
 const state=lazyState();state.folders['C:/tmp'].push({id:'binary',name:'file.bin',type:'binary',fsSource:'C:/tmp/file.bin'});const app=harness(t,{filesystemLoad:async()=>state});await app.command('bitfroest.openPrototype');await app.panels[0].receive({type:'conflict-preview',path:'C:/tmp/file.bin',language:'plaintext'});
 const opened=app.calls.find(call=>call.id==='vscode.open');assert.ok(opened);assert.equal(opened.args[0].scheme,'bitfroest-conflict');assert.deepEqual(opened.args[1],{viewColumn:3,preview:false});assert.equal(app.textDocuments.length,0);
});

test('transfer cancellation interrupts the running job and forwards only its actual outcome', async t => {
  const real = { version: 1, realFilesystem: true, snapshotId: 'one', folders: { 'C:/tmp': [], 'C:/temp': [] }, panes: [{ tabs: ['C:/tmp'], tab: 0 }, { tabs: ['C:/temp'], tab: 0 }] };
  let operation, release;
  const outcome = { cancelled: true, completedIds: ['one'], completedSourcePaths: ['C:/tmp/a'] };
  const app = harness(t, { filesystemLoad: async () => real, filesystemApply: async (_before, after, options) => { operation = options; options?.onProgress?.({ completedBytes: 3, totalBytes: 10 }); await new Promise(resolve => { release = resolve; }); return { ...after, operationOutcome: outcome }; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-apply', operationId: 'job-1', transfer: { mode: 'copy', sourcePath: 'C:/tmp', ids: ['one'], sourceSide: 0 }, state: real });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(operation?.signal);
  await panel.receive({ type: 'filesystem-cancel', operationId: 'old-job' }); assert.equal(operation.signal.aborted, false);
  await panel.receive({ type: 'filesystem-cancel', operationId: 'job-1' }); assert.equal(operation.signal.aborted, true);
  release(); await pending;
  assert.deepEqual(panel.messages.at(-1).operationOutcome, outcome);
  assert.equal(panel.messages.at(-1).operationId, 'job-1');
  const count = panel.messages.length; operation.onProgress({ completedBytes: 9 }); assert.equal(panel.messages.length, count);
});

test('preparation has progress and a cancellable job before applying any mutation', async t => {
  let operation;
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemPrepare: async (_before, settings) => {
    operation = settings;
    settings.onProgress?.({ phase: 'preparing', filesScanned: 3 });
    await new Promise((resolve, reject) => settings.signal?.addEventListener('abort', () => { const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }));
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-prepare', operationId: 'prepare-1', paths: ['C:/tmp'], action: 'copy', state: clipboardFixture() });
  await tick();
  assert.ok(operation.signal);
  assert.equal(panel.messages.at(-1).type, 'filesystem-progress');
  await panel.receive({ type: 'filesystem-cancel', operationId: 'prepare-1' }); await pending;
  const result = panel.messages.at(-1);
  assert.equal(result.cancelled, true); assert.equal(result.ok, true);
  assert.equal(result.resumeAction, undefined); assert.deepEqual(app.errors, []);
});

test('failed preparation acknowledges and releases the filesystem queue without a blocking native popup', async t => {
  let releaseError;
  const failure = Object.assign(new Error('Preparation failed'), { code: 'FolderChangedDuringScan', path: 'C:/tmp', scanPhase: 'readdir', cause: Object.assign(new Error('Directory changed'), { code: 'ESTALE', path: 'C:/tmp', scanPhase: 'stat', stack: 'cause stack' }) });
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemPrepare: async () => { throw failure; }, showErrorMessage: () => new Promise(resolve => { releaseError = resolve; }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'filesystem-prepare', operationId: 'prepare-failure', snapshotId: 'clipboard', paths: ['C:/tmp'], action: 'copy', state: clipboardFixture() });
  await tick();
  assert.equal(panel.messages.at(-1)?.type, 'filesystem-result');
  assert.equal(panel.messages.at(-1)?.operationId, 'prepare-failure');
  assert.deepEqual(panel.messages.at(-1)?.diagnostic.request, { type: 'filesystem-prepare', paths: ['C:/tmp'], action: 'copy', operationId: 'prepare-failure', snapshotId: 'clipboard' });
  assert.deepEqual(panel.messages.at(-1)?.diagnostic.panelPaths, ['C:/tmp', 'C:/temp']);
  assert.ok(Number.isFinite(Date.parse(panel.messages.at(-1)?.diagnostic.timestamp)));
  assert.equal(panel.messages.at(-1)?.diagnostic.architecture, process.arch);
  assert.equal(panel.messages.at(-1)?.diagnostic.osRelease, require('node:os').release());
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.code, 'FolderChangedDuringScan');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.scanPhase, 'readdir');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.cause.code, 'ESTALE');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.cause.path, 'C:/tmp');
  assert.equal(panel.messages.at(-1)?.diagnostic.failure.cause.stack, 'cause stack');
  assert.equal(panel.messages.at(-1)?.diagnostic.runtimeVersion, process.version);
  assert.equal(app.errors.length, 0, 'the webview owns persistent operation error reporting');
  const refresh = panel.receive({ type: 'filesystem-refresh', state: clipboardFixture() });
  await refresh;
  releaseError?.();
  await pending;
});

test('host progress bounds intermediate messages and always forwards the completed byte count', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemApply: async (_before, after, operation) => {
    for (let completedBytes = 0; completedBytes < 1000; completedBytes++) operation.onProgress({ phase: 'copying', completedBytes, totalBytes: 1000 });
    operation.onProgress({ phase: 'published', completedBytes: 1000, totalBytes: 1000 });
    return after;
  } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'filesystem-apply', operationId: 'progress-1', transfer: { mode: 'copy' }, state: clipboardFixture() });
  const progress = panel.messages.filter(message => message.type === 'filesystem-progress');
  assert.ok(progress.length <= 3, `unbounded messages: ${progress.length}`);
  assert.equal(progress[0].progress.completedBytes, 0);
  assert.equal(progress.at(-1).progress.completedBytes, 1000);
});

test('Unix folder inspection is enabled and uses validated direct selection without a Windows shell popup', async t => {
  const command = manifest.contributes.commands.find(command => command.command === 'bitfroest.inspect-folder-locks');
  assert.ok(command.enablement.includes('isLinux') && command.enablement.includes('isMac'));
  assert.ok(manifest.contributes.menus['webview/context'].some(item => item.command === command.command && item.when.includes('webviewSection == folder')));
  const opened = [];
  const app = harness(t, { platform: 'linux', filesystemLoad: async () => { const state = clipboardFixture(); state.folders['C:/tmp'][0] = { id: 'a', name: 'target', type: 'folder', fsSource: 'C:/tmp/target' }; return state; }, lockInspectorOpen: folder => opened.push(folder) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /data-platform="linux"/);
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard', inspectLocks: true });
  assert.deepEqual(opened, ['C:/tmp/target']); assert.equal(app.shellCalls.length, 0);
});

test('folder lock menu choice opens the integrated inspector for the snapshot directory without a shell refresh', async t => {
  const opened = []; let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; const state = clipboardFixture(); state.folders['C:/tmp'][0] = { id: 'a', name: 'target', type: 'folder', fsSource: 'C:/tmp/target' }; return state; }, lockInspectorOpen: folder => opened.push(folder), shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false, action: 'inspect-locks' }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.deepEqual(opened, ['C:/tmp/target']); assert.equal(loads, 1);
  assert.equal(panel.messages.at(-1).refreshed, false);
});

test('native shell menus resolve only a current frozen selection and refresh after an invoked action', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { const state = clipboardFixture(); if (++loads > 1) { state.snapshotId = 'fresh'; state.folders['C:/tmp'][0].size = 42; } return state; }, shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard', keyboard: true, paths: ['C:/private/arbitrary'] });
  assert.equal(app.shellCalls.length, 1); assert.deepEqual(app.shellCalls[0].paths, ['C:/tmp/a.txt']);
  assert.equal(app.shellCalls[0].settings.keyboard, true);
  assert.deepEqual(app.shellCalls[0].configuration.roots, ['C:/tmp', 'C:/temp']);
  assert.equal(loads, 2);
  assert.equal(panel.messages.find(message => message.type === 'restore').state.folders['C:/tmp'][0].size, 42);
  assert.deepEqual(panel.messages.at(-1), { type: 'shell-context-menu-result', requestId: 'shell-menu-1', ok: true, invoked: true, cancelled: false, refreshed: true, clipboardInvalidated: true });
  panel.dispose(); assert.equal(app.shellDisposals.length, 1);
});

test('native shell menus reject invalid, stale and busy requests without calling a native popup', async t => {
  const pending = deferred();
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), filesystemApply: () => pending.promise });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const message = { type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' };
  for (const patch of [{ ids: [] }, { ids: ['a', 'a'] }, { ids: ['foreign'] }, { ids: Array.from({ length: 257 }, (_, index) => String(index)) }, { directory: 'C:/private' }, { snapshotId: 'stale' }]) {
    await panel.receive({ ...message, ...patch }); assert.equal(panel.messages.at(-1).ok, false);
  }
  assert.equal(app.shellCalls.length, 0);
  const applying = panel.receive({ type: 'filesystem-apply', operationId: 'copy-1', transfer: { mode: 'copy' }, state: clipboardFixture() }); await tick();
  await panel.receive(message); assert.equal(panel.messages.at(-1).ok, false); assert.equal(app.shellCalls.length, 0);
  pending.resolve(clipboardFixture()); await applying;
  await panel.receive(message); assert.equal(app.shellCalls.length, 1); assert.equal(panel.messages.at(-1).refreshed, false);
  panel.dispose(); const count = app.shellCalls.length; await panel.receive(message); assert.equal(app.shellCalls.length, count);
});

test('native shell menus refuse remote extension execution and non-file extension resources', async t => {
  for (const options of [{ remoteName: 'ssh-remote', extensionKind: 2 }, { extensionScheme: 'vscode-remote' }]) {
    const app = harness(t, { ...options, filesystemLoad: async () => clipboardFixture() });
    await app.command('bitfroest.openPrototype');
    await app.panels[0].receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
    assert.equal(app.shellCalls.length, 0); assert.equal(app.panels[0].messages.at(-1).ok, false);
  }
});

test('the native menu keyboard command is confined to the ready Windows file list', async t => {
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.shell-context-menu');
  assert.equal(binding?.key, 'shift+f10');
  for (const guard of ['isWindows', 'bitfroest.ready', 'bitfroest.listFocus', '!bitfroest.textInput', 'webviewFocus']) assert.ok(binding.when.includes(guard));
  const app = harness(t); await app.command('bitfroest.openPrototype'); await app.command('bitfroest.shell-context-menu');
  assert.equal(app.panels[0].messages.at(-1).action, 'shell-context-menu');
});

test('native menu paths and reply identity stay frozen while a popup is pending', async t => {
  const choice = deferred();
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: async paths => { assert.equal(Object.isFrozen(paths), true); return choice.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const message = { type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard', keyboard: true };
  const pending = panel.receive(message); message.requestId = 'shell-menu-9'; message.ids[0] = 'other'; message.keyboard = false;
  choice.resolve({ ok: true, displayed: true, invoked: false, cancelled: true }); await pending;
  assert.deepEqual(app.shellCalls[0].paths, ['C:/tmp/a.txt']); assert.equal(panel.messages.at(-1).requestId, 'shell-menu-1');
  assert.equal(app.shellCalls[0].settings.keyboard, true);
});

test('native invocation invalidates a previous internal move ticket without reading the clipboard', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'clipboard-write', requestId: 'export', paths: ['C:/tmp/a.txt'], mode: 'move' });
  await panel.receive({ type: 'filesystem-apply', state: clipboardFixture() });
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  await panel.receive({ type: 'clipboard-ack', requestId: 'old-ack', token: 'clip-1', paths: ['C:/tmp/a.txt'], remainingPaths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(panel.messages.at(-1).ok, false);
  assert.deepEqual(app.clipboardCalls.map(call => call.action), ['write']);
});

test('an uncertain native menu failure refreshes metadata and cannot report an invoked action as success', async t => {
  let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, shellMenuShow: async () => { throw new Error('Native process failed after invocation'); } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  assert.equal(loads, 2); assert.equal(panel.messages.at(-1).ok, false);
  assert.equal(panel.messages.at(-1).refreshed, true); assert.equal(panel.messages.at(-1).clipboardInvalidated, true);
  assert.match(panel.messages.at(-1).error, /Native process failed/);
});

test('delayed startup creates one initialized panel and allows retry after a loading failure', async t => {
  const loading = deferred(); let attempts = 0;
  const app = harness(t, { filesystemLoad: async () => { attempts++; if (attempts === 1) return loading.promise; return clipboardFixture(); } });
  const opening = app.command('bitfroest.openPrototype'); await tick();
  await app.command('bitfroest.openPrototype'); assert.equal(app.panels.length, 0);
  loading.reject(new Error('Temporary load failure')); await opening;
  assert.equal(app.panels.length, 0); assert.equal(app.errors.length, 1);
  await app.command('bitfroest.openPrototype');
  assert.equal(app.panels.length, 1); assert.match(app.panels[0].webview.html, /a.txt/);
  assert.equal(app.contexts.get('bitfroest.ready'), true);
});

test('panel disposal aborts preparation and a replacement ignores the previous job response', async t => {
  let signal, loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, filesystemPrepare: async (_state, options) => {
    signal = options.signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }));
  } });
  await app.command('bitfroest.openPrototype'); const old = app.panels[0];
  const pending = old.receive({ type: 'filesystem-prepare', operationId: 'old-prepare', paths: ['C:/tmp'], action: 'copy', state: clipboardFixture() }); await tick();
  old.dispose(); assert.equal(signal.aborted, true);
  const reopening = app.command('bitfroest.openPrototype'); await pending; await reopening;
  assert.equal(loads, 2); assert.equal(app.panels.length, 2); assert.deepEqual(app.errors, []);
  assert.equal(old.messages.some(message => message.type === 'filesystem-result'), false);
  assert.equal(app.panels[1].messages.some(message => message.operationId === 'old-prepare'), false);
});

test('a disposed native-menu owner cannot refresh or reply into the replacement panel', async t => {
  const choice = deferred(); let loads = 0;
  const app = harness(t, { filesystemLoad: async () => { loads++; return clipboardFixture(); }, shellMenuShow: () => choice.promise });
  await app.command('bitfroest.openPrototype'); const old = app.panels[0];
  const pending = old.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' }); await tick();
  old.dispose(); await app.command('bitfroest.openPrototype');
  choice.resolve({ ok: true, displayed: true, invoked: true, cancelled: false }); await pending;
  assert.equal(app.shellDisposals.length, 1); assert.equal(loads, 2);
  assert.equal(old.messages.some(message => message.type === 'shell-context-menu-result'), false);
  assert.equal(app.panels[1].messages.some(message => message.type === 'restore'), false);
});

test('an open native menu serializes file changes and clipboard access until it closes', async t => {
  const choice = deferred(); let applies = 0;
  const app = harness(t, { filesystemLoad: async () => clipboardFixture(), shellMenuShow: () => choice.promise, filesystemApply: async (_before, after) => { applies++; return after; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' }); await tick();
  await panel.receive({ type: 'filesystem-apply', operationId: 'blocked', state: clipboardFixture() });
  assert.equal(panel.messages.at(-1).ok, false); assert.equal(applies, 0);
  await panel.receive({ type: 'clipboard-read', requestId: 'blocked-read' });
  assert.equal(panel.messages.at(-1).ok, false); assert.deepEqual(app.clipboardCalls, []);
  choice.resolve({ ok: true, displayed: true, invoked: false, cancelled: true }); await pending;
  await panel.receive({ type: 'filesystem-apply', state: clipboardFixture() }); assert.equal(applies, 1);
});

test('a failed post-invocation reread retains the confirmed snapshot and reports the refresh failure in English', async t => {
  let loads = 0;
  const app = harness(t, { language: 'en', filesystemLoad: async () => { if (++loads > 1) throw new Error('Permission denied'); return clipboardFixture(); }, shellMenuShow: async () => ({ ok: true, displayed: true, invoked: true, cancelled: false }) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await panel.receive({ type: 'shell-context-menu', requestId: 'shell-menu-1', directory: 'C:/tmp', ids: ['a'], snapshotId: 'clipboard' });
  const result = panel.messages.at(-1);
  assert.equal(result.ok, false); assert.equal(result.invoked, true); assert.equal(result.refreshed, false);
  assert.equal(result.clipboardInvalidated, true); assert.equal(loads, 2);
  assert.match(result.error, /Permission denied/); assert.doesNotMatch(result.error, /Systemmenü|Dateibestand|aktualisiert/);
  assert.equal(panel.messages.some(message => message.type === 'restore'), false);
});

test('language picker marks the VS Code default and reloads host HTML with the selected language', async t => {
  const app = harness(t, { language: 'de-CH', choices: ['en', 'de'] });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'choose-language' });
  const items = app.quickPicks[0].items;
  assert.equal(items.length, 2);
  assert.match(items.find(item => item.value === 'de').description, /Standard.*Visual Studio Code/);
  assert.match(items.find(item => item.value === 'de').label, /star/);
  assert.equal(app.updateCalls.at(-1).key, 'language');
  assert.equal(app.updateCalls.at(-1).value, 'en');
  await app.panels[0].receive({ type: 'language-reload' });
  assert.match(app.panels[0].webview.html, /data-language="en"/);
  assert.match(app.panels[0].webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, undefined, { html: app.panels[0].webview.html });
  assert.equal(view.document.documentElement.lang, 'en');
  assert.equal(view.document.querySelector('#language-toggle').getAttribute('aria-label'), 'Switch language');
  assert.equal(view.document.querySelector('#notifications-toggle').getAttribute('aria-label'), 'Notifications (0)');
  assert.ok([...view.document.scripts].every(script => script.nonce));
  await app.panels[0].receive({ type: 'app-ready' });
  await app.command('bitfroest.chooseLanguage');
  assert.equal(app.updateCalls.at(-1).value, 'auto');
});

test('saved language overrides VS Code language and picker cancellation leaves settings intact', async t => {
  const app = harness(t, { language: 'en-US', configuration: { language: 'de' } });
  await app.command('bitfroest.openPrototype');
  assert.match(app.panels[0].webview.html, /data-language="de"/);
  await app.command('bitfroest.chooseLanguage');
  assert.equal(app.updateCalls.some(call => call.store === 'configuration'), false);
  assert.match(app.quickPicks[0].items.find(item => item.value === 'en').description, /Standard/);
});

test('unsupported display languages default to English and external setting changes notify the open view', async t => {
  const configuration = {};
  const app = harness(t, { language: 'fr', configuration });
  await app.command('bitfroest.openPrototype');
  await app.command('bitfroest.chooseLanguage');
  assert.match(app.quickPicks[0].items.find(item => item.value === 'en').description, /Default.*Visual Studio Code/);
  configuration.language = 'de';
  await app.configuration('bitfroest.language');
  assert.equal(app.panels[0].messages.at(-1).type, 'language-changed');
  await app.panels[0].receive({ type: 'language-reload' });
  assert.match(app.panels[0].webview.html, /data-language="de"/);
});

test('file color settings expose scalar controls and a localized table of colors', () => {
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
  const fs = require('node:fs'), path = require('node:path');
  for (const key of ['fileTypes', 'gitStatus', 'rules']) {
    const setting = properties[`bitfroest.colors.${key}`];
    assert.equal(setting.scope, 'window');
    if (key === 'rules') { assert.equal(setting.type, 'object'); assert.equal(setting.additionalProperties.type, 'string'); }
    else assert.equal(setting.type, 'boolean');
    for (const language of ['package.nls.json', 'package.nls.de.json']) assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '..', language), 'utf8'))[setting.description.replaceAll('%', '')]);
  }
});

test('branch list retains unborn and detached identities on dismissal', async t => {
  for (const result of [
    { ok: true, branch: 'future', unborn: true, names: [], remoteNames: [] },
    { ok: true, branch: null, detached: true, head: '123456789abcdef', names: ['main'], remoteNames: [] }
  ]) {
    const initial = clipboardFixture(); let writes = 0;
    const app = harness(t, { filesystemLoad: async () => initial, gitBranches: async () => result,
      filesystemApply: async before => { writes++; return before; } });
    await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
    await panel.receive({ type: 'git-status', requestId: 'branches', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
    await panel.receive({ type: 'git-branches', path: 'C:/tmp', snapshotId: initial.snapshotId });
    const pick = app.quickPicks.at(-1); assert.ok(pick);
    assert.equal(pick.items[0].label, result.branch || 'Detached HEAD 12345678');
    assert.equal(writes, 0);
    assert.equal(app.errors.length, 0);
    panel.dispose();
  }
});

test('Git host HTML limits loading placeholders to confirmed repository entries', async t => {
  const initial = clipboardFixture(), work = deferred(); let progress;
  initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  initial.folders['C:/tmp'].push({ id: 'repo', name: 'project', type: 'folder', fsSource: 'C:/tmp/project' });
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: (_directories, _settings, _creation, onProgress) => { progress = onProgress; return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  assert.equal(view.document.querySelector('[data-git-placeholder]'), null);
  const pending = panel.receive(view.messages.find(message => message.type === 'git-status'));
  progress({ 'C:/tmp': { ok: true, repository: false, loading: true, loadingRepositories: ['project'], statuses: {} } });
  const deliver = message => view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
  deliver(panel.messages.filter(message => message.partial).at(-1));
  assert.ok(view.row('project').querySelector('[data-git-placeholder]'));
  assert.equal(view.row('a.txt').querySelector('[data-git-placeholder]'), null);
  work.resolve({ 'C:/tmp': { ok: true, repository: false, statuses: { project: 'clean' } } });
  await pending;
  deliver(panel.messages.filter(message => message.type === 'git-status-result' && !message.partial).at(-1));
  assert.ok(view.row('project').querySelector('[data-git-status="clean"].git-status-enter'));
  assert.equal(view.document.querySelector('[data-git-branch]'), null);
  panel.dispose();
});

test('Git host forwards early branch updates and rejects stale progress after navigation', async t => {
  const initial = clipboardFixture(), work = deferred(); let progress;
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: (_directories, _settings, _creation, onProgress) => { progress = onProgress; return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const pending = panel.receive({ type: 'git-status', requestId: 'early', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  assert.equal(typeof progress, 'function');
  progress({ 'C:/tmp': { ok: true, repository: true, branch: 'main', loading: true, statuses: {} } });
  assert.equal(panel.messages.find(message => message.partial)?.directories['C:/tmp'].branch, 'main');
  const count = panel.messages.filter(message => message.partial).length;
  const staleProgress = progress;
  const next = panel.receive({ type: 'git-status', requestId: 'next', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  staleProgress({ 'C:/tmp': { ok: true, repository: true, branch: 'stale', loading: true } });
  assert.equal(panel.messages.filter(message => message.partial).length, count);
  work.resolve({}); await Promise.all([pending, next]); panel.dispose();
});

test('Git host requests new directory metadata while the previous status is pending', async t => {
  const initial = clipboardFixture(), work = deferred(), requested = [];
  const app = harness(t, { filesystemLoad: async () => initial,
    gitInspect: (directories, _settings, _creation, progress) => { requested.push(directories); progress?.(Object.fromEntries(directories.map(directory => [directory, { ok: true, repository: true, branch: 'main', loading: true }]))); return work.promise; } });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  const first = panel.receive({ type: 'git-status', requestId: 'first', snapshotId: initial.snapshotId, directories: ['C:/tmp'] });
  const next = panel.receive({ type: 'git-status', requestId: 'next', snapshotId: initial.snapshotId, directories: ['C:/temp'] });
  assert.equal(requested.length, 2);
  assert.ok(panel.messages.some(message => message.partial && message.requestId === 'next'));
  work.resolve({}); await Promise.all([first, next]); panel.dispose();
});

test('F9 terminal command uses the generated host protocol and validates directories', async t => {
  const opened = [];
  const initial = clipboardFixture(); initial.panes.forEach(pane => { pane.filter = ''; pane.sort = 'name'; });
  const app = harness(t, { filesystemLoad: async () => initial, terminalOpen: async directory => opened.push(directory) });
  await app.command('bitfroest.openPrototype'); const panel = app.panels[0];
  await app.command('bitfroest.open-terminal');
  assert.ok(panel.messages.some(message => message.type === 'action' && message.action === 'open-terminal'));
  const view = require('./support/webview.cjs').createApp(t, initial, { html: panel.webview.html });
  view.document.querySelector('.list').focus(); view.key('F9');
  const request = view.messages.find(message => message.type === 'open-terminal'); assert.ok(request);
  await panel.receive(request);
  assert.deepEqual(opened, ['C:/tmp']);
  assert.ok(panel.messages.some(message => message.type === 'ui-action-result' && message.requestId === request.requestId && message.ok));
  for (const directory of ['C:/outside', 'zip:C:/file.zip!/', 'C:/tmp/file.txt', undefined]) {
    await panel.receive({ type: 'open-terminal', requestId: 'ui-action-20', path: directory });
    assert.equal(panel.messages.at(-1).ok, false);
  }
  assert.equal(opened.length, 1);
});

test('terminal launch failure replies without a notification dialog', async t => {
  const app = harness(t, { filesystemLoad: async () => clipboardFixture() });
  await app.command('bitfroest.openPrototype');
  await app.panels[0].receive({ type: 'open-terminal', path: 'C:/tmp', requestId: 'ui-action-1' });
  assert.equal(app.panels[0].messages.at(-1).ok, false);
  assert.match(app.panels[0].messages.at(-1).error, /Terminal unavailable/);
  assert.equal(app.errors.length, 0);
});
