const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
function createApp(t, saved, options = {}) {
  const root = path.resolve(__dirname, '../..');
  const dom = new JSDOM(options.html || fs.readFileSync(path.join(root, 'media/index.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://prototype.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  document.body.dataset.language = options.language || document.body.dataset.language || 'de';
  if (options.platform) document.body.dataset.platform = options.platform;
  document.body.dataset.extensionVersion = require('../../package.json').version;
  if (options.columnSettings) document.body.dataset.columnSettings = JSON.stringify(options.columnSettings);
  if (options.fileSettings) document.body.dataset.fileSettings = encodeURIComponent(JSON.stringify(options.fileSettings));
  const messages = [];
  let persisted = saved;
  if (options.host !== false) window.acquireVsCodeApi = () => ({ getState: () => saved, setState: state => { persisted = JSON.parse(JSON.stringify(state)); }, postMessage: message => messages.push(message) });
  else if (saved) window.sessionStorage.setItem('bitfroest-demo', JSON.stringify(saved));
  if (options.icons) document.body.dataset.iconTheme = encodeURIComponent(JSON.stringify(options.icons));
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 8 }) });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.querySelector('input,button')?.focus(); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.structuredClone = structuredClone;
  window.HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };
  for (const name of ['commander-paths.js', 'commander-shortcuts.js', 'shortcut-runtime.js', 'commander-i18n.js', 'commander-column-settings.js', 'commander-tabs.js', 'commander-columns.js', 'commander-search.js', 'file-search-view.js', 'commander-contrast.js', 'commander-file-colors.js', 'commander-file-names.js', 'commander-transfer.js', 'search-duplicates.js', 'commander-clipboard.js', 'commander-lister.js', 'lister-view.js', 'workbench-vendor.js', 'workbench-icons.js', 'git-status-icons.js', 'commander-statusbar.js', 'app.js']) {
    const file = path.join(root, 'media', name);
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(dom.getInternalVMContext());
  }
  const click = (element, extra = {}) => { assert.ok(element, 'click target exists'); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1, ...extra })); };
  const key = (key, extra = {}, target = document.activeElement) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const action = value => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'action', action: value } }));
  const row = name => [...document.querySelectorAll('.pane.active tbody tr[data-id]')].find(element => element.title === name || element.querySelector('td')?.title === name);
  return { window, document, messages, click, key, action, row, state: () => options.host === false ? JSON.parse(window.sessionStorage.getItem('bitfroest-demo')) : persisted };
}


module.exports = { createApp };
