const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const outcome = app => app.document.querySelector('#status-message').dataset.outcome;
function fixture() {
  const p = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'statusbar', active: 0, panes: [p('/left'), p('/right')], folders: { '/left': [{ id: 'a', name: 'Source <literal>.txt', type: 'text', size: 12, fsSource: '/left/Source <literal>.txt' }], '/right': [] } };
}
async function start(app) {
  app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  return app.messages.find(message => message.type === 'filesystem-apply');
}

test('completed selections show a themed success icon while invalid filters show a yellow error outcome', t => {
  for (const language of ['de', 'en']) {
    const app = createApp(t, undefined, { language }); app.action('select-all');
    assert.equal(outcome(app), 'success');
    assert.ok(app.document.querySelector('#status-message [data-status-icon] svg'));
    assert.match(app.document.querySelector('#status-message').textContent, language === 'de' ? /markiert/ : /selected/);
    assert.equal(app.document.querySelector('#status-message [data-status-icon]').getAttribute('aria-hidden'), 'true');
    app.action('select-group'); app.document.querySelector('#value').value = '<[';
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(outcome(app), 'error');
    assert.ok(app.document.querySelector('#status-message [data-status-icon] svg'));
  }
  const css = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /#status-message\[data-outcome="success"\][^}]*--vscode-testing-iconPassed/);
  assert.match(css, /#status-message\[data-outcome="error"\][^}]*--vscode-editorWarning-foreground/);
});

test('clipboard status waits for acknowledgment and distinguishes errors, cancellation and stale responses', t => {
  const app = createApp(t, fixture()); app.action('select-all'); app.action('copy-full-names');
  const request = app.messages.filter(message => message.type === 'selection-io').at(-1);
  assert.equal(outcome(app), 'info');
  send(app, { type: 'selection-io-result', requestId: request.requestId, ok: true });
  assert.equal(outcome(app), 'success');
  app.action('copy-full-names'); const next = app.messages.filter(message => message.type === 'selection-io').at(-1);
  send(app, { type: 'selection-io-result', requestId: next.requestId, ok: false, error: 'Failure <img src=x>' });
  assert.equal(outcome(app), 'error'); assert.equal(app.document.querySelector('#status-message img'), null);
  app.action('copy-full-names'); const cancelled = app.messages.filter(message => message.type === 'selection-io').at(-1);
  send(app, { type: 'selection-io-result', requestId: cancelled.requestId, ok: true, cancelled: true });
  assert.equal(outcome(app), 'cancelled');
  app.action('copy-full-names'); const stale = app.messages.filter(message => message.type === 'selection-io').at(-1);
  app.action('clear'); const status = app.document.querySelector('#status-message').textContent;
  send(app, { type: 'selection-io-result', requestId: stale.requestId, ok: true });
  assert.equal(app.document.querySelector('#status-message').textContent, status);
});

test('file transfers show success only after confirmation and never on cancellation or failure', async t => {
  for (const result of ['success', 'cancelled', 'error']) {
    const app = createApp(t, fixture()), request = await start(app); assert.ok(request);
    assert.equal(outcome(app), 'info');
    send(app, { type: 'filesystem-result', operationId: request.operationId, state: fixture(), ok: result !== 'error',
      ...(result === 'cancelled' ? { operationOutcome: { cancelled: true, completedIds: [] } } : {}),
      ...(result === 'error' ? { error: 'Copy failed' } : {}) });
    assert.equal(outcome(app), result);
  }
});

test('starting transfer preparation clears prior success and never reports preparation as completion', async t => {
  const state = fixture(); state.unloadedFolders = ['/right'];
  const app = createApp(t, state); app.action('select-all'); assert.equal(outcome(app), 'success');
  app.action('copy'); app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(); const request = app.messages.find(message => message.type === 'filesystem-prepare'); assert.ok(request);
  assert.equal(outcome(app), 'info');
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state: fixture() });
  assert.notEqual(outcome(app), 'success');
});
test('search completion reports success, partial failure and cancellation in the shared statusbar', t => {
  for (const result of ['success', 'error', 'cancelled']) {
    const app = createApp(t, fixture()); app.action('select-all'); app.action('search');
    app.click(app.document.querySelector('[data-search-start]'));
    const request = app.messages.filter(message => message.type === 'search-start').at(-1); assert.ok(request);
    assert.equal(outcome(app), 'info');
    send(app, { type: 'search-complete', searchId: request.searchId, results: [],
      ...(result === 'cancelled' ? { cancelled: true } : {}), ...(result === 'error' ? { errors: [{ path: '/left', error: 'Access denied' }] } : {}) });
    assert.equal(outcome(app), result);
  }
});
test('folder calculation distinguishes pending results, errors and a completed measurement', t => {
  for (const result of ['success', 'error']) {
    const state = fixture(); state.panes[0].cursor = 'dir'; state.panes[0].selected = [];
    state.folders['/left'].push({ id: 'dir', name: 'docs', type: 'folder', fsSource: '/left/docs' });
    const app = createApp(t, state); app.key(' ');
    const request = app.messages.find(message => message.type === 'folder-size'); assert.ok(request);
    assert.equal(outcome(app), 'info');
    send(app, { ...request, type: 'folder-size-result', ok: result === 'success', size: 0, error: 'Access denied' });
    assert.equal(outcome(app), result);
  }
});
test('folder size batches retain an earlier error or cancellation when the final folder succeeds', t => {
  for (const first of ['error', 'cancelled']) {
    const state = fixture(); state.folders['/left'].push(...['one', 'two'].map(id => ({ id, name: id, type: 'folder', fsSource: '/left/' + id })));
    const app = createApp(t, state); app.key('Enter', { altKey: true, shiftKey: true });
    const requests = app.messages.filter(message => message.type === 'folder-size'); assert.equal(requests.length, 2);
    send(app, { ...requests[0], type: 'folder-size-result', ok: false, ...(first === 'cancelled' ? { cancelled: true } : { error: 'Partial failure' }) });
    send(app, { ...requests[1], type: 'folder-size-result', ok: true, size: 0 });
    assert.equal(outcome(app), first);
  }
});
test('an unrelated status change does not discard a valid file selection load', t => {
  const app = createApp(t, fixture()); app.action('load-selection-file');
  const request = app.messages.filter(message => message.type === 'selection-io').at(-1); assert.ok(request);
  app.action('clear'); const status = app.document.querySelector('#status-message').textContent;
  send(app, { type: 'selection-io-result', requestId: request.requestId, ok: true, text: 'Source <literal>.txt' });
  assert.deepEqual(app.state().panes[0].selected, ['a']);
  assert.equal(app.document.querySelector('#status-message').textContent, status, 'old completion does not overwrite newer status');
});
test('first native lister open reports its completed display without requiring a second read', t => {
  const app = createApp(t, fixture()); app.key('F3');
  const request = app.messages.find(message => message.type === 'lister-open'); assert.ok(request);
  assert.equal(outcome(app), 'info');
  send(app, { type: 'lister-result', requestId: request.requestId, ok: true, id: 'opened', size: 1,
    view: { text: 'a', map: [0, 1], ends: [1], lines: [0], offset: 0, next: 1, previous: 0, size: 1, mode: 'text', encoding: 'utf-8' } });
  assert.equal(outcome(app), 'success');
  assert.equal(app.document.querySelector('[data-lister] textarea').value, 'a');
});
test('synchronous tab changes and inline renames report their actual completed action', t => {
  const state = fixture(); state.realFilesystem = false;
  const app = createApp(t, state); app.action('new-tab');
  assert.equal(outcome(app), 'success'); assert.match(app.document.querySelector('#status-message').textContent, /Tab/);
  app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); assert.ok(input);
  input.value = 'renamed.txt'; app.key('Enter', {}, input);
  assert.equal(outcome(app), 'success'); assert.match(app.document.querySelector('#status-message').textContent, /umbenannt/);
});
test('system file clipboard operations clear old success until their matching acknowledgment', t => {
  const app = createApp(t, fixture()); app.action('select-all'); app.action('clipboard-copy');
  const request = app.messages.find(message => message.type === 'clipboard-write'); assert.ok(request);
  assert.equal(outcome(app), 'info');
  send(app, { type: 'clipboard-result', requestId: request.requestId, ok: true, selection: { ...request, source: 'system' } });
  assert.equal(outcome(app), 'success');
});
test('late folder results retain model values without replacing a newer clipboard operation status', t => {
  for (const ok of [true, false]) {
    const state = fixture(); state.panes[0].cursor = 'dir'; state.panes[0].selected = [];
    state.folders['/left'].push({ id: 'dir', name: 'docs', type: 'folder', fsSource: '/left/docs' });
    const app = createApp(t, state); app.key(' ');
    const measurement = app.messages.find(message => message.type === 'folder-size'); assert.ok(measurement);
    app.action('copy-full-names'); const copy = app.messages.filter(message => message.type === 'selection-io').at(-1);
    const pending = app.document.querySelector('#status-message').textContent;
    send(app, { ...measurement, type: 'folder-size-result', ok, size: 12, error: 'Late folder failure' });
    assert.equal(app.document.querySelector('#status-message').textContent, pending);
    send(app, { type: 'selection-io-result', requestId: copy.requestId, ok: true });
    assert.equal(outcome(app), 'success'); assert.match(app.document.querySelector('#status-message').textContent, /Auswahl übertragen/);
    if (ok) assert.match(app.row('docs').textContent, /12 B/);
  }
});

test('header retains direct file actions while bottom bar reserves progress and typed status', t => {
  const app = createApp(t), doc = app.document;
  const bar = doc.querySelector('#statusbar'), header = doc.querySelector('.commander-header');
  assert.ok(header);
  assert.equal(bar.querySelector('#functionbar'), null);
  assert.ok(header.querySelector('#functionbar'));
  assert.ok(header.querySelector('#language-toggle'));
  assert.ok(header.querySelector('#notifications-toggle'));
  const labels = ['F2 Umbenennen', 'F3 Anzeigen', 'F4 Bearbeiten', 'F5 Kopieren', 'F6 Verschieben', 'F7 Neuer Ordner', 'F8 Löschen'];
  assert.deepEqual([...header.querySelectorAll('#functionbar button')].map(button => button.textContent), labels);
  app.click(app.row('README.md'));
  app.click(header.querySelector('[data-action="rename-one"]'));
  assert.ok(doc.querySelector('.inline-rename'));
  app.key('Escape', {}, doc.querySelector('.inline-rename'));
  for (const target of [bar, bar.querySelector('#status-message'), bar.querySelector('#status-progress-track')]) {
    const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  }
  assert.ok(doc.querySelector('[data-menu-action="open-trash"]'));
  assert.equal(bar.querySelector('#status-progress-track').getAttribute('aria-hidden'), 'true');
});

test('every status level and background activity includes an icon and explicit type', t => {
  const app = createApp(t);
  const bar = app.window.CommanderStatusbar.create({ t: value => value, actions: [], focusList() {} });
  for (const level of ['info', 'success', 'warning', 'error', 'cancelled']) {
    bar.setStatus('Literal <message>', level);
    const message = app.document.querySelector('#status-message');
    assert.equal(message.dataset.outcome, level);
    assert.ok(message.querySelector('[data-status-icon]'));
    assert.equal(message.textContent, 'Literal <message>');
    assert.equal(message.querySelector('message'), null);
  }
  const plan = app.window.CommanderProgress.statusPlan({ id: 'reading', startedAt: 0, steps: ['read'] });
  plan.start('read'); bar.setActivity('Reading', plan.snapshot());
  assert.equal(app.document.querySelector('#status-activity').dataset.outcome, 'info');
  assert.ok(app.document.querySelector('#status-activity [data-status-icon]'));
});

test('notification center retains literal failures, supports dismissal and restores keyboard focus', t => {
  const app = createApp(t, undefined, { language: 'en' });
  send(app, { type: 'open-trash-result', ok: false, error: 'Failure <img src=x> & recovery' });
  app.click(app.document.querySelector('#modal-cancel'));
  const toggle = app.document.querySelector('#notifications-toggle'); assert.ok(toggle);
  app.click(toggle);
  const center = app.document.querySelector('#notifications-center');
  assert.equal(center.hidden, false); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.match(center.textContent, /Failure <img src=x> & recovery/); assert.equal(center.querySelector('img'), null);
  assert.ok(center.contains(app.document.activeElement));
  const count = app.messages.length; app.key('F5'); assert.equal(app.messages.length, count);
  app.key('Escape'); assert.equal(center.hidden, true); assert.equal(app.document.activeElement, toggle);
  app.click(toggle); app.click(center.querySelector('[data-notification-close]'));
  assert.match(center.textContent, /No new notifications/);
});

test('running transfer shows aligned overall and current-file tracks without opening notifications', async t => {
  const state = fixture(), app = createApp(t, state, { language: 'en' });
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  const request = await start(app); assert.ok(request);
  const status = app.document.querySelector('#status-progress-area'); assert.ok(status); assert.equal(status.hidden, false);
  const track = status.querySelector('#status-progress-track'); assert.ok(track);
  const cancel = app.document.querySelector('#status-cancel');
  assert.equal(cancel.hidden, false, 'cancel remains reachable in the statusbar with notifications closed');
  const cancelSlot = cancel.closest('.status-cancel-slot');
  assert.notEqual(app.window.getComputedStyle(cancelSlot).display, 'none', 'active cancel slot stays visible');
  assert.notEqual(app.window.getComputedStyle(cancel).display, 'none', 'active cancel button stays visible');
  assert.equal(cancel.textContent, ''); assert.ok(cancel.querySelector('svg'));
  assert.equal(cancel.title, 'Cancel');
  const overall = track.querySelector('#status-progress-overall'), current = track.querySelector('#status-progress-file');
  send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { path: '/left/a.txt', transferred: 3, total: 12, completedBytes: 3, totalBytes: 12 } });
  assert.equal(overall.getAttribute('aria-valuenow'), '3'); assert.equal(current.getAttribute('aria-valuenow'), '3');
  assert.equal(overall.style.width, '25%'); assert.equal(current.style.width, '25%');
  assert.equal(overall.parentElement, current.parentElement, 'both values render as overlapping fills in one track');
  assert.equal(app.document.querySelector('#status-percent').textContent, '25%/25%');
  assert.equal(app.document.querySelector('#status-percent').title, 'Overall progress / Current step progress');
  assert.equal(app.document.querySelector('#status-eta').title, 'Estimated time remaining');
  assert.equal(app.document.querySelector('#status-elapsed').title, 'Elapsed time');
  send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { path: '/left/b.txt', transferred: 1, total: 4, completedBytes: 7, totalBytes: 12 } });
  assert.equal(overall.getAttribute('aria-valuenow'), '7'); assert.equal(current.getAttribute('aria-valuenow'), '1');
  assert.equal(overall.style.width, '58.333333333333336%'); assert.equal(current.style.width, '25%');
  assert.equal(app.document.querySelector('#status-percent').textContent, '58%/25%');
  assert.equal(app.document.querySelector('#status-message').textContent, 'Copy · /left/b.txt');
  assert.equal(app.document.querySelector('#status-message').title, 'Copying: b.txt\n/left/b.txt');
  assert.match(overall.getAttribute('aria-valuetext'), /7 B \/ 12 B/); assert.match(current.getAttribute('aria-valuetext'), /1 B \/ 4 B/);
  assert.equal(app.document.querySelector('#notifications-center').hidden, true);
  assert.doesNotMatch(app.document.querySelector('#notifications-list').textContent, /File system updated/);
  send(app, { type: 'filesystem-progress', operationId: 'foreign', progress: { completedBytes: 12, totalBytes: 12 } });
  assert.equal(overall.getAttribute('aria-valuenow'), '7');
  assert.equal(app.document.querySelector('#status-message').textContent, 'Copy · /left/b.txt');
  assert.ok(app.document.querySelector('#notifications-toggle').title.includes(`v${require('../package.json').version}`));
  app.click(app.document.querySelector('#notifications-clear'));
  assert.ok(app.document.querySelector('[data-cancel-transfer]'), 'clear all retains running operations');
  app.click(app.document.querySelector('[data-cancel-transfer]')); app.click(app.document.querySelector('[data-cancel-transfer]'));
  assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
  assert.equal(cancel.disabled, true);
  assert.equal(cancel.hidden, false, 'cancel remains visible until the matching acknowledgment');
  assert.equal(status.hidden, false, 'cancel request alone is not completion');
  assert.equal(overall.getAttribute('aria-valuenow'), '7'); assert.equal(current.getAttribute('aria-valuenow'), '1');
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state, operationOutcome: { cancelled: true, completedIds: [] } });
  assert.equal(cancel.hidden, true);
  assert.equal(app.document.querySelector('#statusbar').dataset.statusProgressOwner, 'background'); assert.equal(app.document.querySelector('.transfer-progress'), null);
  assert.match(app.document.querySelector('#notifications-center').textContent, /cancelled|Cancelled/);
});

test('Escape cancels the active transfer once from the list or notification details until its matching acknowledgment', async t => {
  for (const focus of ['list', 'notification']) {
    const app = createApp(t, fixture()), request = await start(app);
    if (focus === 'notification') { app.click(app.document.querySelector('#notifications-toggle')); app.document.querySelector('#notifications-center [tabindex="0"]')?.focus(); }
    const target = focus === 'list' ? app.document.querySelector('.list') : app.document.querySelector('#notifications-center');
    app.key('Escape', {}, target);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
    assert.equal(app.document.querySelector('[data-cancel-transfer]').disabled, true);
    assert.equal(app.document.querySelector('#status-cancel').disabled, true);
    app.key('Escape', {}, target);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
    assert.ok(app.document.querySelector('.transfer-progress'), 'pending cancel keeps progress visible');
    send(app, { type: 'filesystem-result', operationId: `foreign-${request.operationId}`, ok: true, state: fixture(), operationOutcome: { cancelled: true } });
    assert.ok(app.document.querySelector('.transfer-progress'), 'foreign acknowledgment does not complete the operation');
    send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state: fixture(), operationOutcome: { cancelled: true } });
    assert.equal(app.document.querySelector('.transfer-progress'), null);
  }
});

test('Escape during modal transfer preparation requests cancellation without closing the modal', async t => {
  const state = fixture(); state.unloadedFolders = ['/right'];
  const app = createApp(t, state);
  app.action('copy'); app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = app.messages.find(message => message.type === 'filesystem-prepare'); assert.ok(request);
  app.key('Escape', {}, app.document.querySelector('#value'));
  app.document.querySelector('#modal').dispatchEvent(new app.window.Event('cancel', { bubbles: false, cancelable: true }));
  assert.equal(app.document.querySelector('#modal').open, false, 'headless dialog does not model native Escape dismissal');
  assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
  assert.equal(app.document.querySelector('[data-cancel-transfer]').disabled, true);
});

test('same statusbar track retains independent overall and file extents in either endpoint order', async t => {
  const state = fixture(), app = createApp(t, state), request = await start(app);
  const track = app.document.querySelector('#status-progress-track');
  const progress = (completedBytes, totalBytes, transferred, total, path = '/left/a.txt') => send(app, {
    type: 'filesystem-progress', operationId: request.operationId,
    progress: { path, transferred, total, completedBytes, totalBytes }
  });
  progress(70, 100, 45, 100);
  assert.equal(track.querySelector('#status-progress-overall').style.width, '70%');
  assert.equal(track.querySelector('#status-progress-file').style.width, '45%');
  progress(45, 100, 70, 100);
  assert.equal(track.querySelector('#status-progress-overall').style.width, '45%');
  assert.equal(track.querySelector('#status-progress-file').style.width, '70%');
  progress(45, 100, 45, 100, '/left/b.txt');
  assert.equal(track.querySelector('#status-progress-overall').style.width, '45%');
  assert.equal(track.querySelector('#status-progress-file').style.width, '45%');
  progress(45, 100, 0, 100, '/left/c.txt');
  assert.equal(track.querySelector('#status-progress-overall').style.width, '45%');
  assert.equal(track.querySelector('#status-progress-file').style.width, '0%');
});

test('statusbar styles distinguish overall area and current file line using theme colors', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /#status-progress-overall\s*\{[^}]*color-mix\(in srgb/);
  assert.match(css, /#status-progress-overall\s*\{[^}]*border-right:\s*1px solid var\(--vscode-progressBar-background/);
  assert.match(css, /#status-progress-file\s*\{[^}]*height:\s*3px[^}]*--vscode-charts-cyan/);
  assert.match(css, /#status-progress-track \[role="progressbar"\]\s*\{[^}]*transition:\s*none/);
  assert.doesNotMatch(css, /#status-progress-file\s*\{[^}]*opacity:/);
});

test('statusbar shares its width and keeps idle progress out of the foreground layout', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /#status-progress-area\s*\{[^}]*position:\s*absolute; inset:\s*0/);
  assert.match(css, /#status-progress-area\.is-idle #status-progress-track[^}]*visibility:\s*hidden/);
  assert.match(css, /#status-message \[data-status-text\][^}]*text-overflow:\s*ellipsis/);
});

test('active progress retains its shared full-width region regardless of path length', async t => {
  const app = createApp(t, fixture()), request = await start(app);
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  const area = app.document.querySelector('#status-progress-area');
  const basis = () => app.window.getComputedStyle(area).position;
  const initial = basis(); assert.equal(initial, 'absolute');
  for (const name of ['a.txt', 'very long name '.repeat(20) + '.txt']) {
    send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { path: '/left/' + name, transferred: 1, total: 2 } });
    assert.equal(basis(), initial);
    assert.equal(app.document.querySelector('#status-progress-area'), area);
    assert.equal(area.parentElement.contains(app.document.querySelector('#status-text-region')), true);
  }
  send(app, { type: 'filesystem-result', ok: true, operationId: request.operationId, state: fixture() });
  assert.equal(basis(), initial);
  assert.notEqual(app.window.getComputedStyle(area).display, 'none');
  assert.equal(app.document.querySelector('#statusbar').dataset.statusProgressOwner, 'background');
});

test('routine filesystem updates do not add status text or notifications', async t => {
  const state = fixture(), app = createApp(t, state);
  send(app, { type: 'filesystem-result', ok: true, state });
  assert.equal(app.document.querySelector('#status-message').textContent, '');
  assert.equal(app.document.querySelector('#notifications-list').textContent, '');
});

test('routine inline feedback uses the status text without a toast or notification', t => {
  const app = createApp(t);
  send(app, { type: 'open-trash-result', ok: true });
  app.click(app.document.querySelector('.path-input'));
  const input = app.document.querySelector('.path-input'); input.value = '/not-present'; app.key('Enter', {}, input);
  assert.match(app.document.querySelector('#status-message').textContent, /nicht vorhanden/);
  assert.equal(app.document.querySelector('#toast').classList.contains('visible'), false);
  assert.equal(app.document.querySelector('#notifications-list').textContent, '');
});

test('auxiliary compact readiness is reported only for a focused visible webview', t => {
  const app = createApp(t);
  let focused = false;
  Object.defineProperty(app.document, 'visibilityState', { configurable: true, value: 'visible' });
  app.document.hasFocus = () => focused;
  send(app, { type: 'auxiliary-compact-check', requestId: '12345678-1234-1234-1234-123456789012' });
  assert.equal(app.messages.some(message => message.type === 'auxiliary-compact-ready'), false);
  focused = true; app.window.dispatchEvent(new app.window.Event('focus'));
  const ready = app.messages.find(message => message.type === 'auxiliary-compact-ready');
  assert.equal(ready?.type, 'auxiliary-compact-ready'); assert.equal(ready?.requestId, '12345678-1234-1234-1234-123456789012');
});

test('auxiliary readiness follows descendant focus once, with visibility and focus guards', t => {
  const app = createApp(t);
  let focused = true, visibility = 'hidden';
  app.document.hasFocus = () => focused;
  Object.defineProperty(app.document, 'visibilityState', { configurable: true, get: () => visibility });
  const requestId = '12345678-1234-1234-1234-123456789012';
  send(app, { type: 'auxiliary-compact-check', requestId });
  const list = app.document.querySelector('.list');
  const focus = () => list.dispatchEvent(new app.window.FocusEvent('focusin', { bubbles: true }));
  const replies = () => app.messages.filter(message => message.type === 'auxiliary-compact-ready');
  focus(); assert.equal(replies().length, 0);
  visibility = 'visible'; focused = false;
  focus(); assert.equal(replies().length, 0);
  focused = true; focus();
  assert.equal(replies().length, 1);
  assert.equal(replies()[0].requestId, requestId);
  focus(); app.window.dispatchEvent(new app.window.Event('focus'));
  app.document.dispatchEvent(new app.window.Event('visibilitychange'));
  assert.equal(replies().length, 1);
});

test('completed transfer stays in notification history and does not steal focus from the file list', async t => {
  const state = fixture(), app = createApp(t, state, { language: 'en' });
  const request = await start(app);
  assert.equal(app.document.activeElement.classList.contains('list'), true);
  send(app, { type: 'filesystem-result', operationId: request.operationId, ok: true, state, operationOutcome: { completedIds: ['a'] } });
  assert.equal(app.document.querySelector('#statusbar').dataset.statusProgressOwner, 'background');
  const center = app.document.querySelector('#notifications-center'); assert.match(center.textContent, /copied/);
  assert.equal(app.document.activeElement.classList.contains('list'), true);
  app.click(app.document.querySelector('#notifications-toggle'));
  if (center.hidden) app.click(app.document.querySelector('#notifications-toggle'));
  app.click(app.document.querySelector('#notifications-clear')); assert.match(center.textContent, /No new notifications/);
});

test('workspace restore clears notification history and active progress without mutating filesystem state', async t => {
  const state = fixture(), app = createApp(t, state); await start(app);
  send(app, { type: 'restore', state });
  assert.equal(app.document.querySelector('#statusbar').dataset.statusProgressOwner, 'background');
  assert.equal(app.document.querySelector('.transfer-progress'), null);
  app.click(app.document.querySelector('#notifications-toggle'));
  assert.match(app.document.querySelector('#notifications-center').textContent, /Keine neuen Benachrichtigungen/);
  assert.equal(app.state().folders['/left'][0].name, 'Source <literal>.txt');
});

test('header controls activate by keyboard and keep wrapping groups bounded', t => {
  const app = createApp(t); app.click(app.row('README.md'));
  const rename = app.document.querySelector('#functionbar [data-action="rename-one"]');
  rename.focus(); app.key('Enter', {}, rename);
  assert.ok(app.document.querySelector('.inline-rename'));
  const css = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /#header-actions \.functionbar[^}]*max-width:\s*100%/);
  assert.match(css, /\.commander-header > \[data-main-menu\][^}]*max-width:\s*100%/);
});

test('notification height budget follows the wrapped header on open and resize', t => {
  const app = createApp(t), header = app.document.querySelector('.commander-header');
  header.getBoundingClientRect = () => ({ bottom: 88 });
  app.click(app.document.querySelector('#notifications-toggle'));
  const center = app.document.querySelector('#notifications-center');
  assert.equal(center.style.getPropertyValue('--notification-top'), '88px');
  header.getBoundingClientRect = () => ({ bottom: 110 });
  app.window.dispatchEvent(new app.window.Event('resize'));
  assert.equal(center.style.getPropertyValue('--notification-top'), '110px');
});
