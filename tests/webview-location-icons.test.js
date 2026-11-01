const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

function fixture(left = '/repo', right = '/plain') {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'locations', active: 0, panes: [pane(left), pane(right)], folders: { [left]: [], [right]: [] } };
}
function reply(app, directories) {
  const request = app.messages.filter(message => message.type === 'git-status').at(-1);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { ...request, type: 'git-status-result', directories } }));
}

test('ordinary directories have no location glyph or reserved icon space', t => {
  const app = createApp(t, fixture());
  for (const path of app.document.querySelectorAll('.path')) {
    assert.equal(path.querySelector('.path-breadcrumbs').textContent.trim(), path.querySelector('.path-input').value);
    assert.equal(path.querySelector('[data-location-icon]:not([hidden])'), null);
  }
});

test('Git location follows asynchronous repository results without replacing the path input', t => {
  const app = createApp(t, fixture()), input = app.document.querySelector('.path-input');
  input.focus(); input.value = '/unfinished'; input.setSelectionRange(2, 5);
  reply(app, { '/repo': { ok: true, repository: true, branch: 'main', statuses: {} }, '/plain': { ok: true, repository: false } });
  const icon = app.document.querySelector('.pane.active [data-location-icon]:not([hidden])');
  assert.ok(icon?.querySelector('svg.bi-git'));
  assert.equal(icon.getAttribute('aria-label'), 'Git');
  assert.equal(app.document.querySelectorAll('[data-location-icon="git"]').length, 1);
  assert.equal(app.document.activeElement, input); assert.equal(input.value, '/unfinished'); assert.equal(input.selectionStart, 2);
  reply(app, { '/repo': { ok: true, repository: true, detached: true, head: 'abcdef12', statuses: {} } });
  assert.ok(app.document.querySelector('.pane.active svg.bi-git'));
  reply(app, { '/repo': { ok: false, error: 'Unavailable' } });
  assert.ok(app.document.querySelector('.pane.active [data-location-icon="git"] svg.bi-git'));
  assert.match(input.title, /Unavailable/);
});

test('ZIP root and nested paths use the light file-zip SVG, and leaving clears it', t => {
  const root = 'zip:%2Frepo%2Fsample.zip!';
  const state = fixture(root, `${root}/docs`);
  state.archiveLocations = { [root]: { archive: '/repo/sample.zip', parent: '/repo' }, [`${root}/docs`]: { archive: '/repo/sample.zip', parent: root } };
  const app = createApp(t, state);
  for (const path of app.document.querySelectorAll('[data-favorites]')) {
    const icon = path.querySelector('[data-location-icon]:not([hidden])');
    assert.ok(icon?.querySelector('svg.ph-light-file-zip'));
    assert.equal(icon.getAttribute('aria-label'), 'ZIP');
    assert.equal(icon.querySelector('svg').getAttribute('viewBox'), '0 0 256 256');
  }
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: fixture() } }));
  assert.equal(app.document.querySelector('[data-location-icon="zip"]'), null);
  assert.equal(app.document.querySelectorAll('[data-favorites] .codicon-star-full').length, 2);
});
