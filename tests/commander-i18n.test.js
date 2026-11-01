const test = require('node:test');
const assert = require('node:assert/strict');

test('integrity and recovery failures are localized in English', () => {
  const { t } = create('en');
  assert.equal(t('Veröffentlichtes Kopierziel fehlt oder wurde extern geändert.'), 'The published copy destination is missing or changed externally.');
  assert.equal(t('Das gespeicherte ZIP-Archiv fehlt oder wurde geändert.'), 'The saved ZIP archive is missing or changed.');
  assert.equal(t('Die Veröffentlichungsquelle ist unvollständig.'), 'The publication source is incomplete.');
});

test('release integrity and startup errors have explicit English translations', () => {
  const { t } = require('../media/commander-i18n').create('en');
  assert.equal(t('Datei während der Kopierprüfung extern geändert.'), 'A file changed externally during copy verification.');
  assert.equal(t('Der Zielpfad ist bereits vorhanden.'), 'The destination path already exists.');
  assert.equal(t('Ein vorhandenes Startverzeichnis ist erforderlich.'), 'An existing startup directory is required.');
});
const fs = require('node:fs');
const path = require('node:path');
const { create, dictionaries } = require('../media/commander-i18n');
const { createApp } = require('./support/webview.cjs');

test('language follows the interface locale and unsupported locales use English', () => {
  for (const locale of ['en', 'en-US', 'fr', undefined]) assert.equal(create(locale).t('Neuer Ordner'), 'New folder');
  for (const locale of ['de', 'de-DE', 'DE-at']) assert.equal(create(locale).t('Neuer Ordner'), 'Neuer Ordner');
});
test('unsafe case rename and externally replaced output errors are available in English', () => {
  const { t } = create('en');
  assert.equal(t('Eine sichere atomare Umbenennung der Groß-/Kleinschreibung ist nicht verfügbar.'), 'Safe atomic case-only renaming is not available.');
  assert.equal(t('Neue Datei extern verändert.'), 'A new file changed externally.');
});
test('both dictionaries contain the same nonempty keys and parameter values remain unchanged', () => {
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.de).sort());
  for (const locale of ['en', 'de']) for (const text of Object.values(dictionaries[locale])) assert.ok(text.length);
  assert.equal(create('en').t('Unbekannter Name'), 'Unbekannter Name');
  assert.equal(create('en').t('{count} Dateien', { count: 3 }), '3 files');
});
test('markup translation changes only static fragments and preserves interpolated file data', () => {
  const { ui } = create('en');
  const name = 'Neuer Ordner';
  assert.equal(ui`<p>Neuer Ordner: ${name}</p>`, '<p>New folder: Neuer Ordner</p>');
});
test('English interface localizes labels and folder/copy/conflict dialogs without translating filenames', async t => {
  const app = createApp(t, undefined, { language: 'en' });
  assert.equal(app.document.documentElement.lang, 'en');
  assert.equal(app.document.querySelector('[data-action="mkdir"]').getAttribute('aria-label'), 'F7 New folder');
  assert.equal(app.document.querySelector('[data-sort="size"]').textContent, 'Size');
  app.action('mkdir');
  assert.equal(app.document.querySelector('#modal-title').textContent, 'New folder');
  assert.equal(app.document.querySelector('#modal-cancel').textContent, 'Cancel');
  app.click(app.document.querySelector('#modal-cancel'));
  app.click(app.row('README.md').querySelector('[data-filename]'));
  app.action('copy');
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Copy');
  assert.equal(app.document.querySelector('label[for="transfer-filter"]').textContent, 'Only files of this type');
  assert.ok(app.row('README.md'));
});
test('German interface preserves German labels', t => {
  const app = createApp(t, undefined, { language: 'de-DE' });
  app.action('mkdir');
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Neuer Ordner');
});
test('native contribution translations have matching English and German keys', () => {
  const root = path.resolve(__dirname, '..');
  const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const de = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.de.json'), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const command of manifest.contributes.commands) assert.ok(en[command.title.slice(1, -1)]);
});

test('English conflict and permanent delete dialogs state their effects in English', async t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', sort: 'name', filter: '' });
  const file = (id, content) => ({ id, name: 'Neuer Ordner.txt', type: 'text', size: content.length, content });
  const saved = { version: 1, realFilesystem: true, active: 0, snapshotId: 'one', panes: [pane('C:/tmp'), { ...pane('C:/temp'), selected: [], cursor: null }], folders: { 'C:/tmp': [file('a', 'new')], 'C:/temp': [file('b', 'old')] } };
  const app = createApp(t, saved, { language: 'en-US' });
  app.action('delete-permanently');
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Delete permanently?');
  assert.match(app.document.querySelector('#modal-body').textContent, /permanently deleted/);
  app.click(app.document.querySelector('#modal-cancel'));
  app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelector('#modal-title').textContent, 'File already exists');
  assert.equal(app.document.querySelector('[data-conflict-action="overwrite-all"]').textContent, 'Overwrite all');
  assert.match(app.document.querySelector('#modal-body').textContent, /Neuer Ordner\.txt/);
  assert.equal(app.document.querySelector('[data-conflict-file="source"] .comparison-meta-label').textContent, 'Size / Date');
  app.click(app.document.querySelector('[data-conflict-action="cancel"]'));
  await new Promise(resolve => setImmediate(resolve));
});

test('short extension column heading follows the selected interface language', t => {
  for (const [language, expected] of [['de', 'Erw.'], ['de-DE', 'Erw.'], ['en', 'Ext.']]) {
    const app = createApp(t, undefined, { language });
    assert.equal(app.document.querySelector('[data-sort="type"]').textContent, expected);
    assert.equal(create(language).t('Ext.'), expected);
  }
});
