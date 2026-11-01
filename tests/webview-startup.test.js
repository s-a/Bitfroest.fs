const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function fixture(t, label) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../media/index.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.document.body.dataset.startupError = encodeURIComponent(label);
  const messages = []; let acquired = 0;
  dom.window.acquireVsCodeApi = () => { acquired++; return { postMessage: message => messages.push(message) }; };
  const source = path.join(__dirname, '../media/webview-bootstrap.js');
  if (fs.existsSync(source)) new vm.Script(fs.readFileSync(source, 'utf8'), { filename: source }).runInContext(dom.getInternalVMContext());
  return { window: dom.window, status: dom.window.document.querySelector('#startup-message'), messages, acquired: () => acquired };
}

test('startup module/runtime failures produce a localized visible error and notify the host once', t => {
  for (const label of ['Unable to start the file manager.', 'Die Dateiverwaltung konnte nicht gestartet werden.']) {
    for (const kind of ['resource', 'runtime']) {
      const app = fixture(t, label);
      if (kind === 'runtime') app.window.dispatchEvent(new app.window.ErrorEvent('error', { message: 'missing dependency' }));
      else { const script = app.window.document.createElement('script'); app.window.document.body.append(script); script.dispatchEvent(new app.window.Event('error')); }
      assert.equal(app.status.textContent, label);
      assert.equal(app.status.getAttribute('role'), 'alert');
      app.window.dispatchEvent(new app.window.ErrorEvent('error', { message: 'second failure' }));
      assert.equal(app.messages.length, 1);
      assert.equal(app.messages[0].type, 'app-startup-error');
      assert.ok(app.messages[0].diagnostic.message);
      assert.equal(app.acquired(), 1);
    }
  }
});

test('successful startup stops its error listener and shares the single acquired host API', t => {
  const app = fixture(t, 'Startup failed');
  assert.ok(app.window.CommanderHost);
  app.window.dispatchEvent(new app.window.Event('commander-started'));
  app.window.dispatchEvent(new app.window.ErrorEvent('error', { message: 'later unrelated error' }));
  assert.equal(app.status.textContent, 'Loading file manager…');
  assert.equal(app.messages.length, 0);
  assert.equal(app.acquired(), 1);
});

test('startup failure copies diagnostics through the host without browser clipboard access', async t => {
  const app = fixture(t, 'Startup failed');
  app.window.dispatchEvent(new app.window.ErrorEvent('error', { message: 'missing dependency' }));
  const copy = [...app.window.document.querySelectorAll('#modal-body button')].find(button => button.textContent === 'Copy error details');
  copy.click();
  assert.equal(app.messages.at(-1).type, 'startup-log-copy');
});

test('partial rendering failure recreates a visible error region and disables unfinished controls', t => {
  const app = fixture(t, 'Startup failed');
  const panes = app.window.document.querySelector('#panes'); panes.innerHTML = '<button>Unfinished action</button>';
  app.window.dispatchEvent(new app.window.ErrorEvent('error', { message: 'render failed after replacing the markup' }));
  const status = app.window.document.querySelector('#startup-message');
  assert.equal(status?.textContent, 'Startup failed');
  assert.equal(panes.inert, true);
  assert.equal(status.closest('[inert]'), null);
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].diagnostic.message, 'render failed after replacing the markup');
});
