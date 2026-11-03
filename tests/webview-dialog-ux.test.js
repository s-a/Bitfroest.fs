const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');
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

test('transfer options use separate aligned checkbox rows and localized tooltips in every theme', t => {
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) for (const language of ['de', 'en']) {
    const app = createApp(t, fixture(), { language });
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
    app.document.head.append(style); app.document.body.className = theme;
    copy(app);
    const body = app.document.querySelector('#modal-body');
    const group = body.querySelector('.transfer-checks'); assert.ok(group);
    assert.equal(app.window.getComputedStyle(group).display, 'grid');
    for (const id of ['transfer-verify', 'transfer-individual']) {
      const checkbox = body.querySelector(`#${id}`), label = checkbox.closest('label');
      assert.equal(label.parentElement, group);
      assert.equal(app.window.getComputedStyle(label).display, 'grid');
      assert.equal(app.window.getComputedStyle(label.querySelector('span')).overflowWrap, 'anywhere');
      assert.ok(checkbox.title.length > 25);
      assert.equal(label.title, checkbox.title);
      assert.equal(checkbox.getAttribute('aria-description'), checkbox.title);
      assert.equal(checkbox.checked, false);
      app.click(label.querySelector('span')); assert.equal(checkbox.checked, true);
      checkbox.focus(); assert.equal(app.document.activeElement, checkbox);
    }
    assert.equal(body.querySelectorAll('.dialog-hint').length, 0);
    assert.match(body.querySelector('#transfer-filter').title, /\*/);
    assert.match(body.querySelector('#transfer-individual').title, language === 'de' ? /Zielordner/ : /target folder/);
    assert.ok(group.closest('fieldset').querySelector('legend').textContent);
  }
});

test('conflict compares source and target and separates single decisions from bulk policies', async t => {
  const app = createApp(t, fixture(), { language: 'en' }); copy(app); submit(app); await tick();
  assert.equal(app.document.querySelector('.conflict-file-heading .comparison-name').textContent, 'same.txt');
  assert.equal(app.document.querySelectorAll('.comparison-name').length, 1);
  assert.match(app.document.querySelector('[data-property="date"] [data-role="target"]').textContent, /28.10.2026/);
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
  assert.equal(app.document.querySelector('#modal-cancel').hidden, true);
  assert.equal(app.document.querySelector('#modal-close').hidden, false);
  app.click(app.document.querySelector('#modal-close')); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('destination filename dialog wraps long names and retains a shared action row in all themes', async t => {
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
    const state = fixture(); state.folders['/left'][0].name = `${'long-name-'.repeat(30)}.txt`;
    const app = createApp(t, state);
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
    app.document.head.append(style); app.document.body.className = theme;
    app.click(app.row(state.folders['/left'][0].name).querySelector('[data-filename]')); app.action('copy');
    app.document.querySelector('#transfer-individual').checked = true; submit(app); await tick();
    const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
    assert.equal(computed('.individual-rename').minWidth, '0px');
    assert.equal(computed('[data-rename-source]').overflowWrap, 'anywhere');
    assert.equal(computed('[data-rename-preview]').overflowWrap, 'anywhere');
    assert.equal(computed('.modal-actions').display, 'flex');
    assert.ok(app.document.querySelector('.modal-actions #transfer-skip'));
    assert.equal(app.document.activeElement.id, 'value');
    app.click(app.document.querySelector('#modal-cancel')); await tick();
    assert.equal(app.state().folders['/right'].length, 1);
  }
});

test('dark and contrast dialogs avoid permanent comparison and individual action frames', async t => {
  for (const theme of ['vscode-dark', 'vscode-high-contrast']) {
    const app = createApp(t, fixture());
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
    app.document.head.append(style);
    app.document.body.className = theme;
    copy(app); submit(app); await tick();
    const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
    assert.equal(computed('.file-comparison-grid').borderTopWidth, '0px', `${theme} comparison frame`);
    assert.equal(computed('.conflict-comparison').display, 'grid', `${theme} compact metadata`);
    assert.equal(computed('[data-conflict-action="overwrite"]').borderTopWidth, theme === 'vscode-dark' ? '1px' : '0px', `${theme} action frame`);
    assert.equal(computed('[data-conflict-action="overwrite"]').borderLeftWidth, theme === 'vscode-dark' ? '1px' : '0px', `${theme} destructive stripe`);
    assert.equal(app.document.activeElement.id, 'conflict-name');
  }
});
