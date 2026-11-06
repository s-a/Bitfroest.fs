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
  for (const item of generic) assert.doesNotMatch(item.when, /webviewSection == address/);
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

test('address copy feedback follows successful host confirmation in the originating panel', t => {
  const app = createApp(t, fixture());
  const panels = [...app.document.querySelectorAll('[data-pane]')];
  const address = panels[1].querySelector('.path-breadcrumbs');
  const copy = () => {
    address.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    return app.messages.filter(message => message.type === 'selection-io').at(-1);
  };
  let request = copy();
  assert.equal(address.classList.contains('path-copy-feedback'), false);
  send(app, { type: 'selection-io-result', requestId: request.requestId, ok: false });
  assert.equal(address.classList.contains('path-copy-feedback'), false);
  request = copy();
  send(app, { type: 'selection-io-result', requestId: request.requestId, ok: true });
  assert.equal(address.classList.contains('path-copy-feedback'), true);
  assert.equal(panels[0].querySelector('.path-breadcrumbs').classList.contains('path-copy-feedback'), false);
  address.dispatchEvent(new app.window.Event('animationend', { bubbles: true }));
  assert.equal(address.classList.contains('path-copy-feedback'), false);
});

test('address right-click copies the complete clicked pane path and confirms only acknowledged writes', t => {
  for (const language of ['de', 'en']) for (const side of [0, 1]) for (const selector of ['[data-breadcrumb]', '[data-path-edit]', '.path-breadcrumbs']) {
    const saved = fixture(); saved.panes[1].tabs = ['/work'];
    const app = createApp(t, saved, { language });
    const section = app.document.querySelector(`[data-pane="${side}"]`), target = section.querySelector(selector);
    const directory = saved.panes[side].tabs[0];
    const hints = [directory];
    if (selector === '[data-breadcrumb]') hints.push(language === 'de' ? 'Strg+Klick: In neuem Tab öffnen' : 'Ctrl-click: Open in a new tab');
    hints.push(language === 'de' ? 'Rechtsklick: Pfad kopieren' : 'Right-click: copy path');
    assert.equal(target.getAttribute('title') || target.closest('[title]')?.title, hints.join('\n'));
    const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    const request = app.messages.filter(message => message.type === 'selection-io').at(-1);
    assert.ok(request); assert.equal(request.action, 'copy'); assert.equal(request.text, directory);
    const status = app.document.querySelector('#status-message');
    assert.notEqual(status.dataset.outcome, 'success');
    send(app, { type: 'selection-io-result', requestId: 'unrelated', ok: true });
    assert.notEqual(status.dataset.outcome, 'success');
    send(app, { type: 'selection-io-result', requestId: request.requestId, ok: true });
    assert.equal(status.dataset.outcome, 'success');
    assert.equal(status.textContent, language === 'de' ? 'Pfad in Zwischenablage kopiert.' : 'Path copied to clipboard.');
    target.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    const failed = app.messages.filter(message => message.type === 'selection-io').at(-1);
    send(app, { type: 'selection-io-result', requestId: failed.requestId, ok: false, error: 'Clipboard unavailable' });
    assert.equal(status.dataset.outcome, 'error'); assert.match(status.textContent, /Clipboard unavailable/);
    assert.equal(app.document.querySelector('[data-context-menu]:not([hidden])'), null);
    assert.deepEqual(app.state().panes.map(p => p.tabs), saved.panes.map(p => p.tabs));
  }
});

test('address keyboard context and editable text never trigger full path copy', t => {
  const app = createApp(t, fixture());
  const crumb = pane(app).querySelector('[data-breadcrumb]'); crumb.focus();
  app.key('F10', { shiftKey: true }, crumb);
  app.click(pane(app).querySelector('[data-path-edit]'));
  const input = pane(app).querySelector('.path-input');
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(app.messages.some(message => message.type === 'selection-io'), false);
});

test('address copies preserve Windows, UNC, root and archive display paths', t => {
  for (const [directory, expected] of [['C:/work/<one>', 'C:\\work\\<one>'], ['//server/share/work', '\\\\server\\share\\work'], ['/', '/'], ['zip:C%3A%2Ftmp%2Fa.zip!/nested', 'C:\\tmp\\a.zip!\\nested']]) {
    const saved = fixture(directory);
    if (directory.startsWith('zip:')) saved.archiveLocations = { [directory]: { archive: 'C:/tmp/a.zip', parent: 'C:/tmp' } };
    const app = createApp(t, saved);
    const target = pane(app).querySelector('[data-breadcrumb]');
    target.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    assert.equal(app.messages.filter(message => message.type === 'selection-io').at(-1).text, expected);
    assert.equal(target.title.split('\n')[0], expected);
  }
});
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
