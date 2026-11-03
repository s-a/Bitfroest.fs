const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

function fixture(side) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  return { version: 1, realFilesystem: true, snapshotId: 'initial', active: side,
    panes: [pane('/left'), pane('/right')], folders: {
      '/left': [{ id: 'left', name: 'child', type: 'folder', fsSource: '/left/child' }],
      '/right': [{ id: 'right', name: 'child', type: 'folder', fsSource: '/right/child' }],
      '/left/child': [], '/right/child': []
    } };
}
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const overlay = (app, side) => app.document.querySelector(`[data-pane="${side}"] [data-file-row] [data-directory-loading]`);
const open = (app, side) => {
  const row = app.document.querySelector(`[data-pane="${side}"] [data-id="${side ? 'right' : 'left'}"]`);
  row.querySelector('[data-filename]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  return row;
};

for (const side of [0, 1]) for (const outcome of ['success', 'failure', 'cancelled']) {
  test(`panel ${side} overlays the double-clicked folder until navigation ${outcome}`, t => {
    const app = createApp(t, fixture(side));
    const row = app.document.querySelector(`[data-pane="${side}"] [data-id="${side ? 'right' : 'left'}"]`);
    const original = row.querySelector('.fileicon');
    open(app, side);
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    const spinner = overlay(app, side);
    assert.ok(spinner, 'the spinner overlays the clicked folder');
    assert.equal(row.querySelector('.fileicon'), original, 'the original folder icon is retained');
    assert.equal(spinner.querySelector('svg').dataset.iconReviewed, 'workbench:loading');
    assert.ok(spinner.querySelector('.codicon-modifier-spin'));
    assert.equal(row.getAttribute('aria-busy'), 'true');
    assert.equal(app.document.querySelector('[data-location-icon] [data-directory-loading]'), null);
    assert.equal(overlay(app, 1 - side), null);
    send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, rows: [] });
    send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, done: true });
    assert.ok(overlay(app, side));
    assert.equal(row.querySelectorAll('[data-directory-loading]').length, 1);
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId,
      ok: outcome === 'success', cancelled: outcome === 'cancelled', state: app.state(), ...(outcome === 'failure' ? { error: 'Unavailable' } : {}) });
    assert.equal(overlay(app, side), null);
    assert.equal(app.state().panes[side].tabs[0], `/${side ? 'right' : 'left'}${outcome === 'success' ? '/child' : ''}`);
  });
}

test('an obsolete navigation response cannot remove the current icon overlay', t => {
  const app = createApp(t, fixture(0));
  const navigate = () => {
    open(app, 0);
    return app.messages.findLast(message => message.type === 'filesystem-navigate');
  };
  const first = navigate(), current = navigate();
  assert.ok(overlay(app, 0));
  send(app, { type: 'filesystem-result', navigationRequestId: first.navigationRequestId, ok: true, state: app.state() });
  assert.ok(overlay(app, 0));
  send(app, { type: 'filesystem-result', navigationRequestId: current.navigationRequestId, ok: false, error: 'Unavailable' });
  assert.equal(overlay(app, 0), null);
});

test('the overlay shares the icon bounds without intercepting pointer input', t => {
  const app = createApp(t, fixture(0));
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  open(app, 0);
  const spinner = overlay(app, 0);
  assert.ok(spinner);
  const computed = app.window.getComputedStyle(spinner);
  assert.equal(computed.position, 'absolute');
  assert.equal(computed.top, '50%');
  assert.equal(computed.pointerEvents, 'none');
  const inner = [...style.sheet.cssRules].find(rule => rule.selectorText === '.directory-loading > .codicon');
  assert.ok(inner, 'the spinner has its own smaller frame inside the folder icon');
  assert.equal(inner.style.getPropertyValue('--icon-size').replace(/\s/g, ''), 'calc(var(--icon-base-size)*.7)');
  assert.equal(computed.display, 'flex');
  assert.equal(computed.alignItems, 'center');
  assert.equal(computed.justifyContent, 'center');
  const reduced = [...style.sheet.cssRules].find(rule => rule.conditionText === '(prefers-reduced-motion: reduce)' && [...rule.cssRules].some(child => child.selectorText?.includes('.directory-loading')));
  assert.ok(reduced, 'the overlay supports reduced motion');
});

test('keyboard and address navigation never place a folder loading animation on the star', t => {
  for (const method of ['keyboard', 'address']) {
    const app = createApp(t, fixture(0));
    if (method === 'keyboard') { app.click(app.row('child').querySelector('[data-filename]')); app.key('Enter'); }
    else { app.action('path'); const input = app.document.activeElement; input.value = '/left/child'; app.key('Enter', {}, input); }
    assert.ok(app.messages.findLast(message => message.type === 'filesystem-navigate'));
    assert.equal(app.document.querySelector('[data-directory-loading]'), null);
  }
});

test('double-clicking an already loaded archive folder navigates without a filesystem read', t => {
  const saved = fixture(0), root = 'zip:C%3A%2Ftmp%2Fexample.zip!', nested = `${root}/docs`;
  saved.panes[0].tabs = [root];
  saved.archiveLocations = { [root]: { archive: 'C:/tmp/example.zip', parent: 'C:/tmp' }, [nested]: { archive: 'C:/tmp/example.zip', parent: root } };
  saved.folders[root] = [{ id: 'docs', name: 'docs', type: 'folder', fsSource: nested }]; saved.folders[nested] = [];
  const app = createApp(t, saved);
  app.row('docs').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate'), false);
  assert.equal(app.state().panes[0].tabs[0], nested);
  assert.equal(app.document.querySelector('[data-directory-loading]'), null);
});
