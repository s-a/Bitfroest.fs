const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
function resolveThemeCss(css, tokens = {}, chain = []) {
  function quotedEnd(start) {
    for (let i = start + 1; i < css.length; i++) {
      if (css[i] === '\\') i++;
      else if (css[i] === css[start]) return i;
    }
    throw new SyntaxError('Invalid CSS string');
  }
  let result = '', cursor = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '"' || css[i] === "'") { i = quotedEnd(i); continue; }
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Invalid CSS comment');
      i = end + 1; continue;
    }
    if (!css.startsWith('var(', i) || /[\w-]/.test(css[i - 1] || '')) continue;
    let end = i + 4, depth = 1, comma = -1;
    for (; end < css.length; end++) {
      if (css[end] === '"' || css[end] === "'") { end = quotedEnd(end); continue; }
      if (css[end] === '(') depth++;
      else if (css[end] === ')' && --depth === 0) break;
      else if (css[end] === ',' && depth === 1 && comma < 0) comma = end;
    }
    const name = css.slice(i + 4, comma < 0 ? end : comma).trim();
    if (depth || !/^--[\w-]+$/.test(name)) throw new SyntaxError('Invalid CSS variable');
    const key = name.startsWith('--vscode-') ? name.slice(9) : name;
    let replacement;
    if (Object.hasOwn(tokens, key)) {
      if (chain.includes(name)) throw new Error(`Cyclic CSS variable: ${name}`);
      replacement = resolveThemeCss(tokens[key], tokens, [...chain, name]);
    } else replacement = comma < 0 ? 'transparent' : resolveThemeCss(css.slice(comma + 1, end).trim(), tokens, chain);
    result += css.slice(cursor, i) + replacement;
    cursor = end + 1; i = end;
  }
  return result + css.slice(cursor);
}
function createApp(t, saved, options = {}) {
  const root = path.resolve(__dirname, '../..');
  const dom = new JSDOM(options.html || fs.readFileSync(path.join(root, 'media/index.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://prototype.invalid/' });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
  const window = dom.window, document = window.document;
  if (options.ResizeObserver) window.ResizeObserver = options.ResizeObserver;
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
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
    if (this.tagName === 'FORM' && this.style.position === 'fixed') return Math.max(0, ...[...this.children].map(child => child.offsetWidth));
    return parseFloat(this.style.width) || (this.textContent.length * 8 + 24);
  } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() {
    return this.classList.contains('ag-body-viewport') || this.classList.contains('ag-center-cols-viewport') ? 1000 : parseFloat(this.style.width) || 0;
  } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() {
    return this.classList.contains('ag-body-viewport') ? 440 : parseFloat(this.style.height) || 0;
  } });
  window.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
  new vm.Script(fs.readFileSync(path.join(root, 'node_modules/ag-grid-community/dist/ag-grid-community.min.noStyle.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  const createGrid = window.agGrid.createGrid;
  window.agGrid = { ...window.agGrid, createGrid: (element, options) => createGrid(element, { ...options, suppressAnimationFrame: true }) };
  new vm.Script(fs.readFileSync(path.join(root, 'media/bitfroest-grid.js'), 'utf8')).runInContext(dom.getInternalVMContext());
  for (const name of ['bitfroest-paths.js', 'webview-interactions.js', 'path-field.js', 'bitfroest-shortcuts.js', 'bitfroest-menu.js', 'shortcut-runtime.js', 'bitfroest-i18n.js', 'bitfroest-column-settings.js', 'bitfroest-tabs.js', 'bitfroest-directory-cache.js', 'bitfroest-columns.js', 'bitfroest-search.js', 'file-search-view.js', 'bitfroest-contrast.js', 'bitfroest-file-colors.js', 'bitfroest-file-names.js', 'bitfroest-transfer.js', 'search-duplicates.js', 'bitfroest-clipboard.js', 'bitfroest-lister.js', 'lister-view.js', 'workbench-vendor.js', 'workbench-icons.js', 'git-status-icons.js', 'icon-font-metrics.js', 'icon-layout.js', 'xray-icons.js', 'bitfroest-icons.js', 'bitfroest-progress.js', 'bitfroest-statusbar.js', 'bitfroest-jobs.js', 'bitfroest-preview.js', 'bitfroest-quick-diff.js', 'bitfroest-xray.js', 'app.js']) {
    if (name === 'app.js') options.beforeApp?.({ window, document });
    const file = path.join(root, 'media', name);
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(dom.getInternalVMContext());
  }
  const click = (element, extra = {}) => { assert.ok(element, 'click target exists'); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1, ...extra })); };
  const key = (key, extra = {}, target = document.activeElement) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const action = value => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'action', action: value } }));
  const row = name => [...document.querySelectorAll('.pane.active [data-file-row][data-id]')].find(element => element.title === name || element.querySelector('[data-cell]')?.title === name);
  return { window, document, messages, click, key, action, row, grid: (side = persisted?.active || 0) => window.agGrid.getGridApi(`files-${side}`), state: () => options.host === false ? JSON.parse(window.sessionStorage.getItem('bitfroest-demo')) : persisted };
}


module.exports = { createApp, resolveThemeCss };
