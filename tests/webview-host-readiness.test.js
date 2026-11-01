const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

test('startup log becomes visible while stylesheets have not reported completion', async t => {
  const media = path.join(__dirname, '../media');
  const dom = new JSDOM(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  const body = document.body; body.remove();
  window.acquireVsCodeApi = () => ({ postMessage() {} });
  new vm.Script(fs.readFileSync(path.join(media, 'webview-bootstrap.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  document.documentElement.append(body);
  await Promise.resolve();
  assert.match(document.querySelector('#startup-log').textContent, /Waiting for stylesheet: app\.css/);
  assert.match(document.querySelector('#startup-log').textContent, /Webview/);
});

test('startup status reports resources only after they load and stops after readiness', t => {
  const media = path.join(__dirname, '../media');
  const dom = new JSDOM(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.acquireVsCodeApi = () => ({ postMessage() {} });
  document.body.dataset.startupResource = encodeURIComponent('Ressource geladen: {resource}');
  new vm.Script(fs.readFileSync(path.join(media, 'webview-bootstrap.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  const status = document.querySelector('#startup-message');
  assert.equal(status.textContent, 'Loading file manager…');
  document.querySelector('script[src="commander-paths.js"]').dispatchEvent(new window.Event('load'));
  assert.equal(status.textContent, 'Loading file manager…');
  assert.equal(document.querySelector('#startup-detail').textContent, 'Ressource geladen: commander-paths.js');
  window.dispatchEvent(new window.Event('commander-started'));
  document.querySelector('script[src="app.js"]').dispatchEvent(new window.Event('load'));
  assert.equal(document.querySelector('#startup-detail').textContent, 'Ressource geladen: commander-paths.js');
});

test('an early stylesheet failure is reported before the body exists and rendered when it becomes available', t => {
  const media = path.join(__dirname, '../media');
  const dom = new JSDOM(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window, messages = [];
  const body = document.body; body.remove();
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  new vm.Script(fs.readFileSync(path.join(media, 'webview-bootstrap.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  document.querySelector('link[href="app.css"]').dispatchEvent(new window.Event('error'));
  assert.match(messages[0]?.diagnostic?.message, /app\.css/);
  document.documentElement.append(body);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  assert.match(document.querySelector('#startup-log').textContent, /Stylesheet failed to load: app\.css/);
  assert.equal(document.querySelector('#modal').open, true);
  assert.equal(document.querySelector('#startup-progress').hidden, true, 'a failed start is no longer in progress');
  assert.match(document.querySelector('#modal textarea').value, /app\.css/);
});

for (const failure of ['exception', 'rejection', 'resource']) test(`startup ${failure} opens the existing error dialog without depending on application initialization`, async t => {
  const media = path.join(__dirname, '../media');
  const dom = new JSDOM(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window, messages = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  new vm.Script(fs.readFileSync(path.join(media, 'webview-bootstrap.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  const image = document.createElement('img'); document.body.append(image);
  image.dispatchEvent(new window.Event('error'));
  assert.equal(messages.length, 0, 'an optional image failure must not prevent application startup');
  if (failure === 'exception') window.dispatchEvent(new window.ErrorEvent('error', { message: '<broken startup>', filename: 'app.js', lineno: 42, colno: 7, error: new window.Error('<broken startup>') }));
  if (failure === 'rejection') {
    const event = new window.Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: new window.Error('<broken startup>') });
    window.dispatchEvent(event);
  }
  if (failure === 'resource') document.querySelector('script[src="app.js"]').dispatchEvent(new window.Event('error'));
  assert.equal(document.querySelector('#modal').open, true);
  assert.ok(document.querySelector('#modal .operation-error-art'));
  assert.match(document.querySelector('#modal textarea').value, failure === 'resource' ? /app\.js/ : /<broken startup>/);
  assert.equal(document.querySelector('#modal broken'), null, 'diagnostics are text, not markup');
  assert.equal(document.querySelector('#panes').inert, true);
  assert.equal(document.querySelector('#functionbar')?.inert ?? true, true);
  const report = messages.find(message => message.type === 'app-startup-error');
  assert.ok(report?.diagnostic?.message);
  if (failure === 'exception') { assert.equal(report.diagnostic.source, 'app.js'); assert.equal(report.diagnostic.line, 42); }
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'duplicate' }));
  assert.equal(messages.filter(message => message.type === 'app-startup-error').length, 1);
  document.querySelector('#modal-cancel').click();
  assert.equal(document.querySelector('#modal').open, false);
});

test('the actual startup script sequence acquires the host once and announces readiness after both lists render', t => {
  const media = path.join(__dirname, '../media');
  const dom = new JSDOM(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://prototype.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  let acquisitions = 0;
  const messages = [];
  window.acquireVsCodeApi = () => {
    assert.equal(++acquisitions, 1, 'the public host API is acquired exactly once');
    return { getState: () => null, setState() {}, postMessage(message) {
      if (message.type === 'app-ready') {
        assert.equal(document.querySelectorAll('.pane .list').length, 2);
        assert.ok(document.querySelector('#functionbar button'));
      }
      messages.push(message);
    } };
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 8 }) });
  window.TextEncoder = TextEncoder;
  for (const script of document.querySelectorAll('script[src]')) {
    const file = path.join(media, script.getAttribute('src'));
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(dom.getInternalVMContext());
  }
  assert.equal(acquisitions, 1);
  assert.equal(messages.filter(message => message.type === 'app-ready').length, 1);
  assert.equal(document.querySelector('#startup-progress'), null, 'successful rendering removes the startup indicator');
  assert.equal(messages.some(message => message.type === 'app-startup-error'), false);
  const readyIndex = messages.findIndex(message => message.type === 'app-ready');
  assert.ok(messages.slice(readyIndex + 1).some(message => message.type === 'inputFocus' && message.list));
  assert.ok(messages.slice(readyIndex + 1).some(message => message.type === 'icons'));
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'unrelated later event' }));
  assert.equal(messages.some(message => message.type === 'app-startup-error'), false);
});

test('window focus during initial rendering defers refresh until host readiness and keeps the lists usable', async t => {
  const media = path.join(__dirname, '../media');
  const dom = new JSDOM(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://prototype.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const saved = { version: 1, active: 0, realFilesystem: true, snapshotId: 'startup', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', size: 12, fsSource: 'C:/tmp/a.txt' }], 'C:/temp': [] } };
  let ready = false, earlyFocus = false;
  const refreshes = [], dropped = [];
  window.acquireVsCodeApi = () => ({ getState: () => saved, setState() {}, postMessage(message) {
    if (message.type === 'app-ready') { ready = true; return; }
    if (message.type !== 'filesystem-refresh') return;
    if (!ready) { dropped.push(message); return; }
    refreshes.push(message);
    queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: saved } })));
  } });
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (...args) {
    focus.apply(this, args);
    if (this.matches('.list') && !earlyFocus) {
      earlyFocus = true;
      window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('focus'));
      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'window-focus' } }));
      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'window-focus' } }));
    }
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 8 }) });
  window.TextEncoder = TextEncoder;
  for (const script of document.querySelectorAll('script[src]')) {
    const file = path.join(media, script.getAttribute('src'));
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(dom.getInternalVMContext());
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(earlyFocus, true, 'the early native-frame focus ordering is exercised');
  assert.equal(dropped.length, 0, 'no refresh may be lost to the fail-closed host readiness guard');
  assert.equal(refreshes.length, 1, 'early focus events coalesce into one refresh after readiness');
  assert.equal(document.querySelector('#panes').inert, false);
  assert.equal(document.querySelector('#functionbar').inert, false);
  const left = document.querySelector('[data-pane="0"] .list'); left.focus();
  left.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.closest('[data-pane]').dataset.pane, '1');
});
