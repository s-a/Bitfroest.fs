const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
test('hidden folders stay visible with an icon badge separate from clipboard markers', t => {
  for (const language of ['de', 'en']) {
    const p = () => ({ tabs: ['C:/one'], tab: 0, selected: ['h'], cursor: 'h', filter: '', sort: 'name' });
    const app = createApp(t, { version: 1, realFilesystem: true, active: 0, panes: [p(), p()], folders: { 'C:/one': [
      { id: 'h', name: 'Hidden folder', type: 'folder', attributes: 'd--h' },
      { id: 'normal', name: '.ordinary', type: 'folder', attributes: 'd---' }
    ] } }, { platform: 'win32', language });
    const row = app.row('Hidden folder'), icon = row.querySelector('.fileicon');
    assert.ok(row.classList.contains('is-hidden'));
    const hidden = row.querySelector('.hidden-marker.codicon-eye-closed');
    assert.ok(hidden);
    const filename = row.querySelector('.filename'), original = icon.closest('.git-icon,.filename-icon');
    assert.ok(original);
    assert.equal(hidden.parentElement, original);
    assert.match(row.getAttribute('aria-label'), language === 'de' ? /Versteckt/ : /Hidden/);
    assert.equal(app.row('.ordinary').classList.contains('is-hidden'), false);
    app.action('clipboard-cut');
    const cut = row.querySelector('.cut-marker.codicon-arrow-right'); assert.ok(cut);
    assert.equal(cut.parentElement, filename);
    assert.ok([...filename.children].indexOf(cut) < [...filename.children].indexOf(original));
    assert.equal(cut.textContent, '');
    assert.ok(row.querySelector('.hidden-marker'));
    app.action('clipboard-copy');
    assert.ok(row.classList.contains('is-copied')); assert.equal(row.querySelector('.cut-marker'), null);
    assert.ok(row.querySelector('.hidden-marker'));
    app.action('swap');
    assert.equal(app.document.querySelectorAll('.hidden-marker').length, 2);
    const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
    assert.match(css, /\.filename\s*\{[^}]*position:\s*relative/);
    assert.match(css, /\.cut-marker[^}]*position:\s*absolute/);
  }
});
