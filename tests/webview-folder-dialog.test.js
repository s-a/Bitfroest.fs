const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('new folder suggests the filename stem under the cursor and selects it for replacement', t => {
  const app = createApp(t);
  app.click(app.row('package.json').querySelector('[data-filename]'));
  app.action('mkdir');
  const input = app.document.querySelector('#value');
  assert.equal(input.value, 'package');
  assert.equal(app.document.activeElement, input);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, input.value.length);
  app.key('x', {}, input);
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('new folder uses the cursor rather than the first selected item', t => {
  const app = createApp(t);
  app.click(app.row('package.json').querySelector('[data-filename]'));
  app.click(app.row('README.md').querySelector('[data-filename]'), { ctrlKey: true });
  app.action('mkdir');
  assert.equal(app.document.querySelector('#value').value, 'README');
});

test('new folder without a current entry focuses and selects its proposed name', t => {
  const app = createApp(t);
  app.action('mkdir');
  const input = app.document.querySelector('#value');
  assert.equal(app.document.activeElement, input);
  assert.equal(input.selectionEnd, input.value.length);
});

test('search highlights switch foreground with opaque theme backgrounds and reject transparent fills', async t => {
  const app = createApp(t);
  for (const [color, expected] of [['#ffff00', '#000000'], ['#001133', '#ffffff'], ['#ff000033', '#000000']]) {
    app.document.body.style.setProperty('--vscode-list-filterMatchBackground', color);
    app.document.body.className = 'vscode-dark';
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.document.querySelector('#panes').style.getPropertyValue('--match-foreground'), expected);
  }
});

test('unmarked cursor entry remains the target for preview and delete', t => {
  const app = createApp(t);
  app.click(app.row('README.md').querySelector('[data-filename]'));
  app.key(' ');
  assert.deepEqual(app.state().panes[0].selected, []);
  app.action('view');
  assert.match(app.document.querySelector('.lister-heading').textContent, /README.md/);
  app.key('Escape');
  app.action('delete');
  assert.match(app.document.querySelector('#modal-body').textContent, /README.md/);
});

test('real filesystem mutations request host commit and remain locked until confirmed', t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const state = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, state);
  app.action('mkdir');
  app.document.querySelector('#value').value = 'New';
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = app.messages.find(message => message.type === 'filesystem-apply');
  assert.ok(request);
  assert.equal(app.document.querySelector('#panes').inert, true);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: { ...request.state, snapshotId: 'two' } } }));
  assert.equal(app.document.querySelector('#panes').inert, false);
  assert.equal(app.state().snapshotId, 'two');
});

test('typing searches directly without adding a search input row', t => {
  const app = createApp(t);
  assert.equal(app.document.querySelector('.filterbar'), null);
  app.key('k'); app.key('a'); app.key('g'); app.key('e');
  assert.equal(app.document.querySelector('.pane.active mark').textContent, 'kage');
  assert.equal(app.state().panes[0].cursor, app.row('package.json').dataset.id);
  app.action('filter');
  assert.ok(app.document.activeElement.classList.contains('list'));
});
