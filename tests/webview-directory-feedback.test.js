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
const overlay = (app, side) => app.document.querySelector(`[data-pane="${side}"] [data-location-icon] > [data-directory-loading]`);

for (const side of [0, 1]) for (const outcome of ['success', 'failure', 'cancelled']) {
  test(`panel ${side} overlays its location icon until navigation ${outcome}`, t => {
    const app = createApp(t, fixture(side));
    const icon = app.document.querySelector(`[data-pane="${side}"] [data-location-icon]`);
    const original = icon.firstElementChild;
    app.click(app.row('child').querySelector('[data-filename]')); app.key('Enter');
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    const spinner = overlay(app, side);
    assert.ok(spinner, 'the spinner overlays the existing location icon');
    assert.equal(icon.firstElementChild, original, 'the original icon is retained');
    assert.equal(spinner.querySelector('svg').dataset.iconReviewed, 'workbench:loading');
    assert.ok(spinner.classList.contains('codicon-modifier-spin'));
    assert.equal(icon.closest('button').getAttribute('aria-busy'), 'true');
    assert.equal(overlay(app, 1 - side), null);
    send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, rows: [] });
    send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, done: true });
    assert.ok(overlay(app, side));
    assert.equal(icon.querySelectorAll('[data-directory-loading]').length, 1);
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId,
      ok: outcome === 'success', cancelled: outcome === 'cancelled', state: app.state(), ...(outcome === 'failure' ? { error: 'Unavailable' } : {}) });
    assert.equal(overlay(app, side), null);
    assert.equal(icon.closest('button').getAttribute('aria-busy'), 'false');
  });
}

test('an obsolete navigation response cannot remove the current icon overlay', t => {
  const app = createApp(t, fixture(0));
  const navigate = target => {
    app.action('path'); const input = app.document.querySelector('.pane.active .path-input');
    input.value = target; app.key('Enter', {}, input);
    return app.messages.findLast(message => message.type === 'filesystem-navigate');
  };
  const first = navigate('/earlier'), current = navigate('/latest');
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
  app.click(app.row('child').querySelector('[data-filename]')); app.key('Enter');
  const spinner = overlay(app, 0);
  assert.ok(spinner);
  const computed = app.window.getComputedStyle(spinner);
  assert.equal(computed.position, 'absolute');
  assert.equal(computed.inset, '0px');
  assert.equal(computed.pointerEvents, 'none');
  const reduced = [...style.sheet.cssRules].find(rule => rule.conditionText === '(prefers-reduced-motion: reduce)' && [...rule.cssRules].some(child => child.selectorText?.includes('.directory-loading')));
  assert.ok(reduced, 'the overlay supports reduced motion');
});
