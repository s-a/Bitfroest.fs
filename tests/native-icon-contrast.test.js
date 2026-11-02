const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contrast = require('../media/commander-contrast');
const { createApp } = require('./support/webview.cjs');

test('native icon contrast adds an opposite outline only for low contrast visible pixels', () => {
  const black = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 0]);
  const white = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
  assert.equal(contrast.nativeIconOutline(black, '#101010'), '#ffffff');
  assert.equal(contrast.nativeIconOutline(white, '#ffffff'), '#000000');
  assert.equal(contrast.nativeIconOutline(black, '#ffffff'), null);
  assert.equal(contrast.nativeIconOutline(white, '#101010'), null);
  assert.equal(contrast.nativeIconOutline(new Uint8ClampedArray(8), '#101010'), null);
  assert.equal(contrast.nativeIconOutline(black, 'transparent'), null);
});

test('native icon contrast accounts for alpha and retains legible multicolour icons', () => {
  assert.equal(contrast.nativeIconOutline(new Uint8ClampedArray([255, 255, 255, 50]), '#101010'), '#ffffff');
  const mixed = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  assert.equal(contrast.nativeIconOutline(mixed, '#101010'), null);
  assert.equal(contrast.nativeIconOutline(null, '#101010'), null);
});

test('loaded native icons adapt to base, hover and selection backgrounds without changing the image', async t => {
  const pane = () => ({ tabs: ['/repo'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, realFilesystem: true, snapshotId: 'contrast', active: 0, panes: [pane(), pane()], folders: {
    '/repo': [{ id: 'd', name: 'folder', type: 'folder' }]
  } };
  let reads = 0, analyses = 0;
  const app = createApp(t, state, { beforeApp({ window, document }) {
    const outline = window.CommanderContrast.nativeIconOutline;
    window.CommanderContrast.nativeIconOutline = (...args) => { analyses++; return outline(...args); };
    for (const [name, value] of Object.entries({ 'sideBar-background': '#101010', 'list-hoverBackground': '#ffffff', 'list-activeSelectionBackground': '#ffffff', 'list-inactiveSelectionBackground': '#111111' })) document.body.style.setProperty(`--vscode-${name}`, value);
    window.HTMLCanvasElement.prototype.getContext = () => ({
      measureText: () => ({ width: 8 }), drawImage() {},
      getImageData() { reads++; return { data: new Uint8ClampedArray([0, 0, 0, 255]) }; }
    });
  } });
  const source = 'data:image/png;base64,AAAA';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: { '/repo/folder': source } } }));
  const icon = app.row('folder').querySelector('img.native-icon');
  Object.defineProperties(icon, { naturalWidth: { value: 16 }, naturalHeight: { value: 16 }, complete: { value: true } });
  icon.dispatchEvent(new app.window.Event('load'));
  assert.match(icon.style.getPropertyValue('--native-icon-outline-base'), /drop-shadow.*#ffffff/);
  assert.equal(icon.style.getPropertyValue('--native-icon-outline-hover'), 'none');
  assert.equal(icon.style.getPropertyValue('--native-icon-outline-active'), 'none');
  assert.match(icon.style.getPropertyValue('--native-icon-outline-inactive'), /#ffffff/);
  app.document.body.style.setProperty('--vscode-sideBar-background', '#ffffff');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.row('folder').querySelector('img.native-icon'), icon);
  assert.equal(icon.style.getPropertyValue('--native-icon-outline-base'), 'none');
  assert.equal(icon.getAttribute('src'), source); assert.equal(reads, 1);
  assert.equal(analyses, 3, 'Repeated icons, hover and theme updates must reuse contrast results for known backgrounds.');
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /tr:hover \.native-icon\s*\{[^}]*--native-icon-outline-hover/);
  assert.match(css, /tr\.selected \.native-icon\s*\{[^}]*--native-icon-outline-inactive/);
  assert.match(css, /\.pane\.active[^}]*tr\.selected \.native-icon\s*\{[^}]*--native-icon-outline-active/);
});
