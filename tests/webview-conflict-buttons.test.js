const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const themes = {
  dimmed: { 'button-secondaryBackground': '#3d444d', 'button-secondaryForeground': '#adbac7', 'button-secondaryHoverBackground': '#444c56', 'button-border': 'transparent', 'editorWidget-background': '#2d333b', 'disabledForeground': '#cccccc80', 'focusBorder': '#316dca' },
  modern: { 'button-secondaryBackground': '#00000000', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#2b2b2b', 'button-border': '#ffffff1a', 'editorWidget-background': '#202020', 'disabledForeground': '#cccccc80', 'focusBorder': '#0078d4' }
};
function fixture() {
  const pane = directory => ({ tabs: [directory], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': [{ id: 'a', name: 'same.txt', type: 'text', size: 3, content: 'new', fsSource: '/left/same.txt' }], '/right': [{ id: 'b', name: 'same.txt', type: 'text', size: 4, content: 'old', fsSource: '/right/same.txt' }] } };
}
function styles(app, tokens) {
  const css = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'), tokens);
  const style = app.document.createElement('style'); style.textContent = css; app.document.head.append(style);
}

function resolvedStyles(css, tokens = themes.dimmed) {
  let actual;
  const app = { document: { createElement: () => ({}), head: { append: style => { actual = style.textContent; } } } };
  vm.runInNewContext(`(${styles.toString()})(app, tokens)`, { app, tokens, fs: { readFileSync: () => css }, path, __dirname, resolveThemeCss }, { timeout: 500 });
  return actual;
}
test('theme styles resolve nested function fallbacks without hanging or discarding theme colors', () => {
  const actual = resolvedStyles('.test { background: var(--missing, color-mix(in srgb, var(--vscode-editorWidget-background) 24%, var(--other, rgb(1, 2, 3)))); width: calc(100% - var(--gap, calc(2px + 3px))); color: var(--vscode-button-secondaryForeground, rgb(0, 0, 0)); }');
  assert.equal(actual, '.test { background: color-mix(in srgb, #2d333b 24%, rgb(1, 2, 3)); width: calc(100% - calc(2px + 3px)); color: #adbac7; }');
});

test('theme styles preserve quoted literals and ignore unused fallbacks', () => {
  assert.equal(resolvedStyles('.test { content: "var(--literal)"; color: var(--vscode-button-secondaryForeground, var(--vscode-loop)); }', { ...themes.dimmed, loop: 'var(--vscode-loop)' }), '.test { content: "var(--literal)"; color: #adbac7; }');
});

test('malformed or cyclic theme variables fail explicitly instead of stalling', () => {
  assert.throws(() => resolvedStyles('.test { color: var(--unfinished; }'), /Invalid CSS variable/);
  assert.throws(() => resolvedStyles('.test { color: var(--vscode-loop); }', { loop: 'var(--vscode-loop)' }), /Cyclic CSS variable/);
});
async function conflict(t, theme, samePath = false) {
  const app = createApp(t, fixture()); styles(app, themes[theme]); app.document.body.className = 'vscode-dark';
  app.action('copy'); if (samePath) app.document.querySelector('#value').value = '/left/same.txt';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick(); return app;
}

test('dark conflict decisions use the theme button surface or native outline instead of unbounded text actions', async t => {
  for (const theme of Object.keys(themes)) {
    const app = await conflict(t, theme); app.document.querySelector('details.dialog-options').open = true;
    for (const action of ['overwrite', 'skip', 'rename-source', 'rename-target', 'append', 'overwrite-all', 'skip-all', 'autorename-source']) {
      const button = app.document.querySelector(`[data-conflict-action="${action}"]`), style = app.window.getComputedStyle(button);
      assert.equal(style.borderTopWidth, '1px', `${theme} ${action} retains the theme button outline`);
      assert.equal(style.borderLeftWidth, '1px', 'destructive actions do not add a heavy stripe');
      assert.equal(style.borderRadius || '0px', '0px');
      if (theme === 'dimmed') { assert.equal(style.backgroundColor, 'rgb(61, 68, 77)'); assert.equal(style.color, 'rgb(173, 186, 199)'); }
      else assert.notEqual(style.borderTopColor, 'rgba(0, 0, 0, 0)', 'transparent secondary themes keep their native visible border');
    }
  }
});

test('disabled same-file decisions retain their button bounds and native disabled text', async t => {
  const app = await conflict(t, 'dimmed', true);
  for (const action of ['overwrite', 'rename-target', 'append']) {
    const button = app.document.querySelector(`[data-conflict-action="${action}"]`), style = app.window.getComputedStyle(button);
    assert.equal(button.disabled, true); assert.ok(button.title);
    assert.equal(style.backgroundColor, 'rgb(61, 68, 77)'); assert.equal(style.color, 'rgba(204, 204, 204, 0.5)'); assert.equal(style.opacity, '1');
  }
  assert.equal(app.document.querySelector('[data-conflict-action="skip"]').disabled, false);
});
