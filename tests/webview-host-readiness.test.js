const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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
