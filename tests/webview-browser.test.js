const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('browser lister retains its mock state and displays markdown as text without host messages', t => {
  const app = createApp(t, undefined, { host: false });
  app.click(app.row('README.md').querySelector('[data-filename]')); app.key('F3');
  assert.match(app.document.querySelector('[data-lister] textarea').value, /Bitfroest/);
  app.key('Escape');
  app.key('F4');
  const editor = app.document.querySelector('.editor'); editor.value = 'Edited mock content';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  const file = app.state().folders['/workspace/bitfroest'].find(file => file.name === 'README.md');
  assert.equal(file.content, 'Edited mock content');
  assert.equal(app.messages.length, 0);
  const reloaded = createApp(t, app.state(), { host: false });
  assert.equal(reloaded.state().folders['/workspace/bitfroest'].find(file => file.name === 'README.md').content, file.content);
});

test('browser context menu allows file actions and a plain text preview', t => {
  const app = createApp(t, undefined, { host: false });
  app.click(app.row('.gitignore').querySelector('[data-filename]')); app.key('F3');
  assert.match(app.document.querySelector('[data-lister] textarea').value, /node_modules/);
  app.key('Escape');
  app.row('.gitignore').dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(app.document.querySelector('[data-browser-action="swap"]'));
  app.click(app.document.querySelector('[data-browser-action="swap"]'));
  assert.equal(app.state().panes[0].tabs[0], '/home/demo/Downloads');
});

test('restoring another workspace layout closes a modal and restores pane state', t => {
  const app = createApp(t);
  const saved = app.state(); saved.active = 1;
  app.action('mkdir'); assert.equal(app.document.querySelector('dialog').open, true);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: saved } }));
  assert.equal(app.document.querySelector('dialog').open, false);
  assert.equal(app.state().active, 1);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: null } }));
  assert.equal(app.state().active, 0);
});

test('theme changes adjust file-icon associations while folders remain explicit folders', async t => {
  const app = createApp(t, undefined, { icons: {
    base: { file: 'base-file', fileExtensions: { json: 'base-json' }, languageIds: { markdown: 'base-md' } },
    light: { fileExtensions: { json: 'light-json' } }, highContrast: { fileExtensions: { json: 'contrast-json' } }
  } });
  assert.ok(app.row('package.json').querySelector('.base-json'));
  assert.ok(app.row('README.md').querySelector('.base-md'));
  assert.ok(app.row('docs').querySelector('.folder'));
  app.document.body.classList.add('vscode-light'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.row('package.json').querySelector('.light-json'));
  app.document.body.classList.remove('vscode-light'); app.document.body.classList.add('vscode-high-contrast'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.row('package.json').querySelector('.contrast-json'));
});
