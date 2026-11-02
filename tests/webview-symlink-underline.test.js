const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

test('symbolic link filenames are underlined in file and search-result views on Windows and Linux', t => {
  const directory = 'C:/links';
  const rows = [
    { id: 'link-file', name: 'link-file.txt', type: 'link', fsSource: `${directory}/link-file.txt` },
    { id: 'link-directory', name: 'link-directory', type: 'link', fsSource: `${directory}/link-directory` },
    { id: 'ordinary-file', name: 'link-ordinary.txt', type: 'text', fsSource: `${directory}/link-ordinary.txt` },
    { id: 'ordinary-directory', name: 'link-ordinary-directory', type: 'folder', fsSource: `${directory}/link-ordinary-directory` }
  ];
  const state = searchResults => ({
    version: 1,
    realFilesystem: true,
    active: 0,
    folders: { [directory]: rows },
    panes: [directory, 'C:/other'].map((current, index) => ({
      tabs: [current], tab: 0, selected: [], cursor: null, filter: 'link', sort: 'name',
      ...(index === 0 && searchResults ? { tabStates: [{ path: current, searchResult: { paths: rows.map(row => row.fsSource) } }] } : {})
    }))
  });

  for (const platform of ['win32', 'linux']) {
    for (const searchResults of [false, true]) {
      const app = createApp(t, state(searchResults), { platform });
      for (const name of ['link-file.txt', 'link-directory']) {
        const filename = app.row(name).querySelector('[data-filename]');
        assert.ok(filename.querySelector('mark'), `${name} keeps its filter highlight`);
        assert.ok(filename.classList.contains('is-link'), `${name} exposes link styling`);
      }
      for (const name of ['link-ordinary.txt', 'link-ordinary-directory']) {
        assert.equal(app.row(name).querySelector('[data-filename]').classList.contains('is-link'), false, `${name} remains unstyled`);
      }
      const source = app.row('link-file.txt').querySelector('[data-result-source]');
      assert.equal(Boolean(source), searchResults);
      if (source) assert.equal(source.classList.contains('is-link'), false);
    }
  }

  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /\[data-filename\]\.is-link\s*\{[^}]*text-decoration:\s*underline/s);
});
