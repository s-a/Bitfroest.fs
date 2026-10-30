const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(real = false) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: real, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'same.txt', type: 'text', size: 3, date: '29.10.2026 14:32', content: 'new' }],
    '/right': [{ id: 'b', name: 'same.txt', type: 'text', size: 3, date: '28.10.2026 12:00', content: 'old' }]
  } };
}
function copy(app) { app.click(app.row('same.txt').querySelector('[data-filename]')); app.action('copy'); }
function submit(app) { app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); }

test('transfer dialog exposes its accessible name, source, description and selected destination', t => {
  const app = createApp(t, fixture()); copy(app);
  const dialog = app.document.querySelector('dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'modal-title');
  assert.equal(dialog.getAttribute('aria-describedby'), 'modal-description');
  assert.equal(app.document.querySelector('[data-transfer-source]').textContent, '/left');
  assert.match(app.document.querySelector('#modal-description').textContent, /1/);
  const input = app.document.querySelector('#value');
  assert.equal(app.document.activeElement, input);
  assert.equal(input.selectionEnd - input.selectionStart, input.value.length);
  assert.ok(app.document.querySelector('details.dialog-options #transfer-policy'));
});

test('conflict compares source and target and separates single decisions from bulk policies', async t => {
  const app = createApp(t, fixture(), { language: 'en' }); copy(app); submit(app); await tick();
  assert.equal(app.document.querySelector('[data-conflict-file="source"] .comparison-name').textContent, 'same.txt');
  assert.equal(app.document.querySelector('[data-conflict-file="target"] .comparison-name').textContent, 'same.txt');
  assert.match(app.document.querySelector('[data-conflict-file="target"]').textContent, /28.10.2026/);
  assert.ok(app.document.querySelector('fieldset.conflict-single [data-conflict-action="overwrite"]'));
  assert.ok(app.document.querySelector('details.dialog-options [data-conflict-action="overwrite-all"]'));
  assert.equal(app.document.querySelector('[data-conflict-action="overwrite"]').getAttribute('data-destructive'), 'true');
  assert.equal(app.document.activeElement.id, 'conflict-name');
  submit(app); await tick();
  assert.equal(app.state().folders['/right'][0].content, 'old');
  assert.equal(app.document.querySelector('dialog').open, true);
});

test('disabled conflict actions explain why they cannot be used', async t => {
  const app = createApp(t, fixture(true), { language: 'en' }); copy(app); submit(app); await tick();
  const append = app.document.querySelector('[data-conflict-action="append"]');
  assert.equal(append.disabled, true);
  assert.ok(append.title.length > 10);
  assert.equal(append.getAttribute('aria-describedby'), 'conflict-limitations');
  assert.match(append.title, /Append/i);
});

test('a delayed close event from the transfer form cannot cancel its newly opened conflict dialog', async t => {
  const app = createApp(t, fixture());
  app.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    queueMicrotask(() => this.dispatchEvent(new app.window.Event('close')));
  };
  copy(app); submit(app); await tick();
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Datei bereits vorhanden');
  assert.equal(app.state().folders['/right'][0].content, 'old');
  app.click(app.document.querySelector('#modal-cancel')); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('dark and contrast dialogs avoid permanent comparison and individual action frames', async t => {
  for (const theme of ['vscode-dark', 'vscode-high-contrast']) {
    const app = createApp(t, fixture());
    const style = app.document.createElement('style');
    let css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
    while (css.includes('var(')) css = css.replace(/var\([^()]*\)/g, '#666666');
    style.textContent = css;
    app.document.head.append(style);
    app.document.body.className = theme;
    copy(app); submit(app); await tick();
    const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
    assert.equal(computed('.file-comparison-grid').borderTopWidth, '0px', `${theme} comparison frame`);
    assert.equal(computed('.file-comparison + .file-comparison').borderLeftWidth, '0px', `${theme} comparison divider`);
    assert.equal(computed('[data-conflict-action="overwrite"]').borderTopWidth, theme === 'vscode-dark' ? '1px' : '0px', `${theme} action frame`);
    assert.equal(computed('[data-conflict-action="overwrite"]').borderLeftWidth, theme === 'vscode-dark' ? '1px' : '0px', `${theme} destructive stripe`);
    assert.equal(app.document.activeElement.id, 'conflict-name');
  }
});
