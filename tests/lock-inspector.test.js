const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createLockInspector } = require('../lock-inspector');

function fixture(t, overrides = {}) {
  const panels = [], calls = [];
  const context = { extensionUri: { fsPath: path.resolve(__dirname, '..') }, globalStorageUri: { fsPath: path.join(require('node:os').tmpdir(), 'lock-inspector-backups') }, subscriptions: [] };
  const rows = [{ id: 'one', pid: 8123, started: '637000000000000000', executable: 'C:\\tmp\\target\\app.exe', name: 'literal <app>', file: 'C:\\tmp\\target\\held.txt', kind: 'handle' }];
  const provider = { scan: async folder => { calls.push(['scan', folder]); return { path: folder, rows, inaccessible: 3 }; }, act: async (...args) => calls.push(args), fileAction: async (...args) => calls.push(args), dispose: () => calls.push(['dispose']), ...overrides.provider };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), toString() { return this.fsPath; } }), file: fsPath => ({ fsPath }) },
    ViewColumn: { Active: -1 }, env: { clipboard: { writeText: async value => calls.push(['clipboard', value]) } },
    window: { showWarningMessage: async (...args) => { calls.push(['confirm', ...args]); return overrides.confirm; }, showQuickPick: async () => undefined,
      createWebviewPanel: (_type, _title, _column, settings) => {
        const panel = { messages: [], settings, visible: true, reveal() {}, webview: { cspSource: 'test-resource:', asWebviewUri: uri => uri, postMessage: async value => panel.messages.push(value), onDidReceiveMessage: callback => { panel.receive = callback; } }, onDidDispose: callback => { panel.disposed = callback; }, dispose() { panel.disposed(); } };
        panels.push(panel); return panel;
      } }
  };
  const inspector = createLockInspector(vscode, context, { language: () => 'de', createProvider: () => provider });
  t.after(() => inspector.dispose());
  return { inspector, panels, calls, rows };
}

test('generated inspector HTML has restrictive CSP and readiness starts a single frozen-directory scan', async t => {
  const { inspector, panels, calls } = fixture(t); inspector.open('C:\\tmp\\target');
  const panel = panels[0]; assert.match(panel.webview.html, /Content-Security-Policy/); assert.match(panel.webview.html, /script-src 'nonce-/);
  assert.equal(calls.length, 0); await panel.receive({ type: 'locks-ready' });
  assert.deepEqual(calls[0], ['scan', 'C:\\tmp\\target']);
  assert.equal(panel.messages.find(message => message.type === 'locks-state').inaccessible, 3);
});

test('native confirmation cancellation does not run mutation; invented IDs cannot be confirmed', async t => {
  const { inspector, panels, calls } = fixture(t); inspector.open('C:\\tmp\\target'); const panel = panels[0];
  await panel.receive({ type: 'locks-ready' });
  await panel.receive({ type: 'locks-action', action: 'terminate', ids: ['fake'] });
  assert.equal(calls.filter(call => call[0] === 'confirm').length, 0);
  await panel.receive({ type: 'locks-action', action: 'terminate', ids: ['one'] });
  assert.equal(calls.filter(call => call[0] === 'confirm').length, 1);
  assert.equal(calls.filter(call => call[0] === 'terminate').length, 0);
});

test('confirmed unlock runs only the observed selection and refreshes the results', async t => {
  const { inspector, panels, calls } = fixture(t, { confirm: 'Ausführen' });
  inspector.open('C:\\tmp\\target'); const panel = panels[0]; await panel.receive({ type: 'locks-ready' });
  await panel.receive({ type: 'locks-action', action: 'unlock', ids: ['one'] });
  assert.deepEqual(calls.find(call => call[0] === 'unlock'), ['unlock', ['one']]);
  assert.equal(calls.filter(call => call[0] === 'scan').length, 2);
});

test('closing during native confirmation prevents the action', async t => {
  let finish;
  const confirmation = new Promise(resolve => { finish = resolve; });
  const { inspector, panels, calls } = fixture(t, { confirm: confirmation });
  inspector.open('C:\\tmp\\target'); const panel = panels[0]; await panel.receive({ type: 'locks-ready' });
  const pending = panel.receive({ type: 'locks-action', action: 'terminate', ids: ['one'] });
  while (!calls.some(call => call[0] === 'confirm')) await new Promise(resolve => setImmediate(resolve));
  panel.dispose(); finish('Ausführen'); await pending;
  assert.equal(calls.some(call => call[0] === 'terminate'), false);
});

test('restart scheduling requests concrete registry approval and passes a separate backup path without touching Windows', async t => {
  let saved;
  const { inspector, panels, calls } = fixture(t, { confirm: 'Ausführen', provider: { schedule: async backup => { saved = backup; return { backup }; } } });
  inspector.open('C:\\tmp\\target'); const panel = panels[0]; await panel.receive({ type: 'locks-ready' });
  await panel.receive({ type: 'locks-action', action: 'schedule', ids: [] });
  const confirmation = calls.find(call => call[0] === 'confirm');
  assert.match(confirmation[1], /HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\PendingFileRenameOperations/);
  assert.match(confirmation[2].detail, /C:\\tmp\\target/);
  assert.ok(path.isAbsolute(saved)); assert.match(saved, /restart-delete-backups/);
  assert.ok(panel.messages.some(message => message.type === 'locks-notice' && message.message.includes(saved)));
});

test('closed inspector drops late results and releases its native provider', async t => {
  let finish;
  const { inspector, panels, calls } = fixture(t, { provider: { scan: async () => new Promise(resolve => { finish = resolve; }) } });
  inspector.open('C:\\tmp\\target'); const panel = panels[0]; const pending = panel.receive({ type: 'locks-ready' });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  panel.dispose(); finish({ path: 'old', rows: [], inaccessible: 0 }); await pending;
  assert.equal(panel.messages.some(message => message.type === 'locks-state'), false); assert.ok(calls.some(call => call[0] === 'dispose'));
});

test('actual host HTML renders process children safely, warns about incomplete access and supports keyboard refresh', async t => {
  const { inspector, panels } = fixture(t); inspector.open('C:\\tmp\\target'); const panel = panels[0];
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only', pretendToBeVisual: true }); t.after(() => dom.window.close());
  const messages = []; dom.window.acquireVsCodeApi = () => ({ postMessage: value => messages.push(value) });
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'media', 'lock-inspector.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  assert.equal(messages[0].type, 'locks-ready');
  await panel.receive(messages[0]);
  for (const data of panel.messages) dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  assert.match(dom.window.document.body.textContent, /literal <app>/); assert.equal(dom.window.document.querySelector('app'), null);
  assert.match(dom.window.document.querySelector('[role="status"]').textContent, /3/);
  assert.equal(dom.window.document.querySelectorAll('a').length, 0);
  assert.equal(dom.window.document.querySelectorAll('input[type="checkbox"][data-process]').length, 1);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true }));
  assert.equal(messages.at(-1).type, 'locks-refresh');
});

test('main actions request all listed processes while the process context keeps the checked subset', async t => {
  const { inspector, panels, rows } = fixture(t); inspector.open('C:\\tmp\\target'); const panel = panels[0];
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const messages = []; dom.window.acquireVsCodeApi = () => ({ postMessage: value => messages.push(value) });
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'media', 'lock-inspector.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'locks-state', path: 'target', rows: [...rows, { ...rows[0], id: 'two', pid: 9999 }], inaccessible: 0 } }));
  dom.window.document.querySelector('[data-process]').checked = true;
  dom.window.document.querySelector('[data-action="unlock"]').click();
  assert.deepEqual(Array.from(messages.at(-1).ids), []);
  dom.window.document.querySelector('.process').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(messages.at(-1).action, 'context'); assert.deepEqual(Array.from(messages.at(-1).ids), ['one']);
  messages.length = 0;
  dom.window.document.querySelector('[data-process]').focus();
  dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(messages.at(-1)?.action, 'context');
});
