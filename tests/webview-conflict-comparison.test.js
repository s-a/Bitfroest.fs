const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
function fixture(source = {}, target = {}) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const common = { name: 'report.txt', type: 'text', size: 1024, date: '29.10.2026 14:32', attributes: '-ar-', mtimeMs: Date.UTC(2026, 9, 29, 13, 32, 12, 345) };
  return { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ ...common, id: 'a', content: 'source', ...source }], '/right': [{ ...common, id: 'b', content: 'target', ...target }]
  } };
}
async function open(t, source, target, language = 'de') {
  const app = createApp(t, fixture(source, target), { language });
  app.click(app.row('report.txt').querySelector('[data-filename]')); app.action('copy'); submit(app); await tick();
  return app;
}
const cell = (app, property, role) => app.document.querySelector(`[data-property="${property}"] [data-role="${role}"]`);

test('compact conflict comparison uses colors without a table or equality symbols', async t => {
  for (const language of ['de', 'en']) {
    const app = await open(t, {}, {}, language);
    assert.equal(app.document.querySelectorAll('.comparison-name').length, 1);
    assert.equal(app.document.querySelector('.comparison-name').textContent, 'report.txt');
    assert.equal(app.document.querySelector('.conflict-comparison table, table.conflict-comparison'), null);
    assert.equal(app.document.querySelectorAll('[data-comparison-symbol]').length, 0);
    assert.equal(app.document.querySelector('#modal-body').textContent.includes(language === 'de' ? 'Eine Datei mit diesem Namen ist bereits im Ziel vorhanden.' : 'A file with this name already exists in the target.'), false);
    for (const property of ['size', 'date', 'time', 'attributes']) {
      const row = app.document.querySelector(`[data-property="${property}"]`); assert.ok(row);
      assert.equal(row.dataset.comparisonState, 'equal', property);
      assert.ok(cell(app, property, 'source').getAttribute('aria-description'));
      assert.ok(cell(app, property, 'source').textContent.trim());
    }
    assert.match(cell(app, 'time', 'source').textContent, /12\.345/);
    assert.ok(app.document.querySelector('.modal-actions [data-conflict-action="overwrite"]'));
    assert.ok(app.document.querySelector('.modal-actions [data-conflict-action="skip"]'));
    assert.equal(app.document.activeElement.id, 'conflict-name');
  }
});

test('conflict comparison preserves exact size and timestamp differences instead of comparing rounded displays', async t => {
  const stamp = Date.UTC(2026, 9, 29, 13, 32, 12);
  const app = await open(t, { size: 1024, mtimeMs: stamp + 1 }, { size: 1025, mtimeMs: stamp + 2, attributes: '-a--' });
  for (const property of ['size', 'time', 'attributes']) {
    assert.equal(app.document.querySelector(`[data-property="${property}"]`).dataset.comparisonState, 'different');
    assert.notEqual(cell(app, property, 'source').textContent, cell(app, property, 'target').textContent);
  }
  assert.equal(app.document.querySelector('[data-property="date"]').dataset.comparisonState, 'equal');
});

test('unknown metadata never receives equality styling and versions compare only when present', async t => {
  const missing = { size: undefined, date: 'Datum unbekannt', mtimeMs: undefined, attributes: undefined };
  const app = await open(t, { ...missing, fileVersion: [1, 2, 3, 4] }, { ...missing, fileVersion: [1, 2, 3, 4] });
  for (const property of ['size', 'date', 'time', 'attributes']) assert.equal(app.document.querySelector(`[data-property="${property}"]`).dataset.comparisonState, 'unknown');
  assert.equal(app.document.querySelector('[data-property="version"]').dataset.comparisonState, 'equal');
});

test('same-path conflicts show the common folder once and retain destructive action restrictions', async t => {
  const app = createApp(t, fixture()); app.click(app.row('report.txt').querySelector('[data-filename]'));
  app.action('copy-same'); submit(app); await tick();
  assert.equal(app.document.querySelectorAll('.comparison-name').length, 1);
  assert.equal(app.document.querySelectorAll('[data-shared-path]').length, 1);
  assert.equal(app.document.querySelector('[data-shared-path]').textContent, '/left');
  assert.equal(app.document.querySelector('[data-conflict-action="overwrite"]').disabled, true);
  assert.equal(app.document.querySelector('[data-conflict-action="rename-source"]').disabled, false);
});

test('different filenames remain explicit while wide conflict dialogs retain their action footer', async t => {
  const app = createApp(t, fixture({}, { name: 'renamed.txt' }));
  app.click(app.row('report.txt').querySelector('[data-filename]')); app.action('copy');
  app.document.querySelector('#value').value = '/right/renamed.txt'; submit(app); await tick();
  assert.equal(cell(app, 'name', 'source').textContent, 'report.txt');
  assert.equal(cell(app, 'name', 'target').textContent, 'renamed.txt');
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'), { 'testing-iconPassed': 'rgb(36, 154, 88)' });
    app.document.head.append(style); app.document.body.className = theme;
    const dialog = app.document.querySelector('#modal');
    assert.ok(dialog.classList.contains('conflict-dialog'));
    assert.equal(app.window.getComputedStyle(dialog).display, 'flex');
    const width = Number.parseFloat(app.window.getComputedStyle(dialog).width);
    assert.ok(width > 620 && width <= app.window.innerWidth - 32);
    assert.equal(app.window.getComputedStyle(cell(app, 'size', 'source')).color, 'rgb(36, 154, 88)');
    assert.equal(app.window.getComputedStyle(app.document.querySelector('.modal-actions')).flexShrink, '0');
    style.remove();
  }
});

test('conflict footer decisions settle once and the next dialog restores its normal layout', async t => {
  const app = await open(t, {}, {});
  app.click(app.document.querySelector('.modal-actions [data-conflict-action="skip"]')); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.state().folders['/right'][0].content, 'target');
  app.action('mkdir');
  assert.equal(app.document.querySelector('#modal').classList.contains('conflict-dialog'), false);
  assert.equal(app.document.querySelector('.conflict-footer-actions'), null);
  assert.equal(app.document.querySelector('#modal-cancel').hidden, false);
});
