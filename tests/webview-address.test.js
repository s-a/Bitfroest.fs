const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
const pane = app => app.document.querySelector('[data-pane="1"]');
function fixture(directory = '/work/one/two') {
  const p = () => ({ tabs: [directory], tab: 0, selected: [], cursor: null });
  return { version: 1, active: 0, panes: [p(), p()], folders: Object.fromEntries(['/', '/work', '/work/one', directory].map(key => [key, []])) };
}

test('folder tab shortcuts work on breadcrumbs and tab controls without changing the other pane', t => {
  const saved = fixture();
  saved.panes[1].tabs = ['/work/one/two', '/work'];
  const app = createApp(t, saved);
  for (const target of ['[data-breadcrumb]', '[data-tab]']) {
    const control = pane(app).querySelector(target);
    control.focus();
    assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).tabs, true);
    app.key('Tab', { ctrlKey: true }, control);
    assert.equal(app.state().panes[1].tab, 1);
    const next = pane(app).querySelector(target); next.focus();
    app.key('Tab', { ctrlKey: true, shiftKey: true }, next);
    assert.equal(app.state().panes[1].tab, 0);
    assert.equal(app.state().panes[0].tab, 0);
  }
});

test('address context excludes generic file commands and native text copy duplicates', t => {
  const app = createApp(t, fixture());
  const crumb = pane(app).querySelector('[data-breadcrumb]');
  const context = JSON.parse(crumb.closest('[data-vscode-context]').dataset.vscodeContext);
  assert.equal(context.webviewSection, 'address');
  assert.equal(context.preventDefaultContextMenuItems, true);
  const manifest = require('../package.json');
  const generic = manifest.contributes.menus['webview/context'].filter(item => item.submenu === 'bitfroest.menu' || /bitfroest\.clipboard-/.test(item.command || ''));
  for (const item of generic) assert.match(item.when, /webviewSection != address/);
});
test('breadcrumbs navigate the clicked panel and Ctrl-click preserves its original tab', t => {
  for (const ctrlKey of [false, true]) {
    const app = createApp(t, fixture());
    app.click(pane(app).querySelector('[data-breadcrumb="/work"]'), { ctrlKey });
    const p = app.state().panes[1];
    assert.equal(p.tabs[p.tab], '/work');
    assert.deepEqual(p.tabs, ctrlKey ? ['/work/one/two', '/work'] : ['/work']);
    assert.equal(app.state().panes[0].tabs[0], '/work/one/two');
  }
});
test('blank address space edits; invalid Enter stays open; Escape and blur discard edits', t => {
  const app = createApp(t, fixture());
  app.click(pane(app).querySelector('[data-path-edit]'));
  let input = pane(app).querySelector('.path-input');
  assert.equal(app.document.activeElement, input);
  assert.ok(input.closest('.path-address').classList.contains('is-editing'));
  input.value = '/missing'; app.key('Enter', {}, input);
  assert.equal(app.document.activeElement, input);
  assert.ok(input.closest('.path-address').classList.contains('is-editing'));
  app.key('Escape', {}, input);
  assert.equal(pane(app).querySelector('.path-input').value, '/work/one/two');
  assert.equal(pane(app).querySelector('.path-address').classList.contains('is-editing'), false);
  app.click(pane(app).querySelector('[data-path-edit]'));
  input = pane(app).querySelector('.path-input'); input.value = '/discard';
  pane(app).querySelector('[data-refresh]').focus();
  assert.equal(input.value, '/work/one/two');
  assert.equal(input.closest('.path-address').classList.contains('is-editing'), false);
  app.click(pane(app).querySelector('[data-path-edit]'));
  input.value = '/work'; app.key('Enter', {}, input);
  assert.equal(app.state().panes[1].tabs[0], '/work');
  assert.equal(pane(app).querySelector('.path-address').classList.contains('is-editing'), false);
});
test('path command exposes the flat input and breadcrumbs retain keyboard activation', t => {
  const app = createApp(t, fixture()); app.action('path');
  const input = app.document.activeElement;
  assert.equal(input.className, 'path-input');
  assert.ok(input.closest('.path-address').classList.contains('is-editing'));
  app.key('Escape', {}, input);
  const crumb = app.document.querySelector('[data-breadcrumb="/work"]');
  assert.equal(crumb.tagName, 'BUTTON');
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /\.path input\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.path input:focus-visible\s*\{[^}]*outline:\s*none[^}]*box-shadow:\s*none/);
});
test('roots and archive segments preserve navigable identities and escaped labels', t => {
  for (const [directory, expected] of [
    ['C:/work/<one>', ['C:/', 'C:/work', 'C:/work/<one>']],
    ['//server/share/work', ['//server/share', '//server/share/work']],
    ['/', ['/']]
  ]) {
    const app = createApp(t, fixture(directory));
    assert.deepEqual([...pane(app).querySelectorAll('[data-breadcrumb]')].map(el => el.dataset.breadcrumb), expected);
    assert.equal(pane(app).querySelector('.path-breadcrumbs one'), null);
  }
  const root = 'zip:C%3A%2Ftmp%2Fa.zip!', child = root + '/nested', saved = fixture(child);
  saved.archiveLocations = { [root]: { archive: 'C:/tmp/a.zip', parent: 'C:/tmp' }, [child]: { archive: 'C:/tmp/a.zip', parent: root } };
  saved.folders[root] = []; saved.folders['C:/tmp'] = [];
  const app = createApp(t, saved);
  app.click(pane(app).querySelector(`[data-breadcrumb="${root}"]`));
  assert.equal(app.state().panes[1].tabs[0], root);
});
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
test('Ctrl breadcrumb validates a real target before opening and ignores failed or stale replies', t => {
  for (const outcome of ['success', 'failure', 'stale']) {
    const saved = fixture(); saved.realFilesystem = true; saved.snapshotId = 'address';
    const app = createApp(t, saved);
    app.click(pane(app).querySelector('[data-breadcrumb="/work"]'), { ctrlKey: true });
    const request = app.messages.find(message => message.type === 'filesystem-navigate');
    assert.ok(request);
    assert.equal(request.side, 1); assert.equal(request.path, '/work');
    assert.equal(app.state().panes[1].tabs.length, 1);
    if (outcome === 'stale') app.click(app.document.querySelector('[data-pane="0"] .list'));
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: outcome !== 'failure', error: 'Unavailable', state: saved });
    assert.deepEqual(app.state().panes[1].tabs, outcome === 'success' ? ['/work/one/two', '/work'] : ['/work/one/two']);
  }
});
test('failed host navigation keeps the edited address and selection available', t => {
  const saved = fixture(); saved.realFilesystem = true; saved.snapshotId = 'address';
  const app = createApp(t, saved);
  app.click(pane(app).querySelector('[data-path-edit]'));
  const input = app.document.activeElement; input.value = '/missing'; input.setSelectionRange(2, 5);
  app.key('Enter', {}, input);
  const request = app.messages.find(message => message.type === 'filesystem-navigate');
  send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: false, error: 'Unavailable', state: saved });
  assert.equal(app.document.activeElement, input);
  assert.equal(input.value, '/missing'); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 5);
  assert.ok(input.closest('.path-address').classList.contains('is-editing'));
});
