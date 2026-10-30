const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const tick = () => new Promise(resolve => setImmediate(resolve));
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

test('one bottom statusbar contains version, compact function actions and a final notification button', t => {
  const app = createApp(t);
  const bar = app.document.querySelector('#statusbar'); assert.ok(bar);
  assert.equal(bar.querySelector('#status-version'), null);
  assert.ok(bar.querySelector('#status-message'));
  assert.ok(bar.querySelector('#status-progress-area'));
  assert.ok(bar.querySelector('#status-cancel'));
  assert.equal(bar.querySelector('#status-cancel').hidden, true);
  assert.equal(bar.querySelector('.status-cancel-slot').nextElementSibling.id, 'functionbar');
  assert.equal(bar.querySelector('#status-progress-area').classList.contains('is-idle'), true);
  assert.equal(bar.lastElementChild.id, 'notifications-toggle');
  const buttons = bar.querySelectorAll('#functionbar button'); assert.equal(buttons.length, 6);
  const labels = ['F3 Anzeigen', 'F4 Bearbeiten', 'F5 Kopieren', 'F6 Verschieben', 'F7 Neuer Ordner', 'F8 Löschen'];
  for (const [index, button] of buttons.entries()) { assert.equal(button.querySelector('svg'), null); assert.equal(button.textContent, labels[index]); assert.equal(button.getAttribute('aria-label'), labels[index]); }
  app.click(bar.querySelector('[data-action="mkdir"]'));
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Neuer Ordner');
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
  const request = await start(app); assert.ok(request);
  const status = app.document.querySelector('#status-progress-area'); assert.ok(status); assert.equal(status.hidden, false);
  const track = status.querySelector('#status-progress-track'); assert.ok(track);
  const cancel = app.document.querySelector('#status-cancel');
  assert.equal(cancel.hidden, false, 'cancel remains reachable in the statusbar with notifications closed');
  assert.equal(cancel.textContent, 'Cancel');
  assert.equal(cancel.title, 'Cancel');
  const overall = track.querySelector('#status-progress-overall'), current = track.querySelector('#status-progress-file');
  send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { path: '/left/a.txt', transferred: 3, total: 12, completedBytes: 3, totalBytes: 12 } });
  assert.equal(overall.getAttribute('aria-valuenow'), '3'); assert.equal(current.getAttribute('aria-valuenow'), '3');
  assert.equal(overall.style.width, '25%'); assert.equal(current.style.width, '25%');
  assert.equal(overall.parentElement, current.parentElement, 'both values render as overlapping fills in one track');
  const trackStyle = () => track.style;
  assert.equal(trackStyle().getPropertyValue('--status-progress-overlap'), '25%');
  assert.equal(trackStyle().getPropertyValue('--status-progress-extent'), '25%');
  assert.match(trackStyle().getPropertyValue('--status-progress-unique'), /progressBar-background/);
  send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { path: '/left/b.txt', transferred: 1, total: 4, completedBytes: 7, totalBytes: 12 } });
  assert.equal(overall.getAttribute('aria-valuenow'), '7'); assert.equal(current.getAttribute('aria-valuenow'), '1');
  assert.equal(overall.style.width, '58.333333333333336%'); assert.equal(current.style.width, '25%');
  assert.equal(trackStyle().getPropertyValue('--status-progress-overlap'), '25%');
  assert.equal(trackStyle().getPropertyValue('--status-progress-extent'), '58.333333333333336%');
  assert.match(trackStyle().getPropertyValue('--status-progress-unique'), /progressBar-background/);
  assert.equal(app.document.querySelector('#status-message').textContent, 'Copying: b.txt');
  assert.equal(app.document.querySelector('#status-message').title, 'Copying: b.txt\n/left/b.txt');
  assert.match(overall.getAttribute('aria-valuetext'), /7 B \/ 12 B/); assert.match(current.getAttribute('aria-valuetext'), /1 B \/ 4 B/);
  assert.equal(app.document.querySelector('#notifications-center').hidden, true);
  assert.doesNotMatch(app.document.querySelector('#notifications-list').textContent, /File system updated/);
  send(app, { type: 'filesystem-progress', operationId: 'foreign', progress: { completedBytes: 12, totalBytes: 12 } });
  assert.equal(overall.getAttribute('aria-valuenow'), '7');
  assert.equal(app.document.querySelector('#status-message').textContent, 'Copying: b.txt');
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
  assert.equal(status.classList.contains('is-idle'), true); assert.equal(app.document.querySelector('.transfer-progress'), null);
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

test('same statusbar track distinguishes overlap and unique progress for either endpoint order', async t => {
  const state = fixture(), app = createApp(t, state), request = await start(app);
  const track = app.document.querySelector('#status-progress-track');
  const progress = (completedBytes, totalBytes, transferred, total, path = '/left/a.txt') => send(app, {
    type: 'filesystem-progress', operationId: request.operationId,
    progress: { path, transferred, total, completedBytes, totalBytes }
  });
  progress(70, 100, 45, 100);
  assert.equal(track.style.getPropertyValue('--status-progress-overlap'), '45%');
  assert.equal(track.style.getPropertyValue('--status-progress-extent'), '70%');
  assert.match(track.style.getPropertyValue('--status-progress-unique'), /progressBar-background/);
  progress(45, 100, 70, 100);
  assert.equal(track.style.getPropertyValue('--status-progress-overlap'), '45%');
  assert.equal(track.style.getPropertyValue('--status-progress-extent'), '70%');
  assert.match(track.style.getPropertyValue('--status-progress-unique'), /charts-green/);
  progress(45, 100, 45, 100, '/left/b.txt');
  assert.equal(track.style.getPropertyValue('--status-progress-overlap'), '45%');
  assert.equal(track.style.getPropertyValue('--status-progress-extent'), '45%');
  progress(45, 100, 0, 100, '/left/c.txt');
  assert.equal(track.style.getPropertyValue('--status-progress-overlap'), '0%');
  assert.equal(track.style.getPropertyValue('--status-progress-extent'), '45%');
  assert.equal(track.style.getPropertyValue('--status-progress-unique'), 'var(--vscode-progressBar-background, var(--vscode-focusBorder))');
});

test('statusbar styles paint overlap once and retain separate theme-colored endpoint markers', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /#status-progress-track\s*\{[^}]*color-mix\(in srgb/);
  assert.match(css, /#status-progress-overall\s*\{[^}]*border-right:\s*1px solid var\(--vscode-progressBar-background/);
  assert.match(css, /#status-progress-file\s*\{[^}]*border-right:\s*1px solid var\(--vscode-charts-green/);
  assert.match(css, /#status-progress-track \[role="progressbar"\]\s*\{[^}]*transition:\s*none/);
  assert.doesNotMatch(css, /#status-progress-file\s*\{[^}]*opacity:/);
});

test('routine filesystem updates appear as status text without creating notifications', async t => {
  const state = fixture(), app = createApp(t, state);
  send(app, { type: 'filesystem-result', ok: true, state });
  assert.equal(app.document.querySelector('#status-message').textContent, 'Dateisystem aktualisiert');
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
  assert.equal(app.document.querySelector('#status-progress-area')?.classList.contains('is-idle'), true);
  const center = app.document.querySelector('#notifications-center'); assert.match(center.textContent, /copied/);
  assert.equal(app.document.activeElement.classList.contains('list'), true);
  app.click(app.document.querySelector('#notifications-toggle'));
  if (center.hidden) app.click(app.document.querySelector('#notifications-toggle'));
  app.click(app.document.querySelector('#notifications-clear')); assert.match(center.textContent, /No new notifications/);
});

test('workspace restore clears notification history and active progress without mutating filesystem state', async t => {
  const state = fixture(), app = createApp(t, state); await start(app);
  send(app, { type: 'restore', state });
  assert.equal(app.document.querySelector('#status-progress-area')?.classList.contains('is-idle'), true);
  assert.equal(app.document.querySelector('.transfer-progress'), null);
  app.click(app.document.querySelector('#notifications-toggle'));
  assert.match(app.document.querySelector('#notifications-center').textContent, /Keine neuen Benachrichtigungen/);
  assert.equal(app.state().folders['/left'][0].name, 'Source <literal>.txt');
});
