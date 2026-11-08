const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('F9 requests a terminal in the active directory and keeps Alt+F9 for unpacking', t => {
  const app = createApp(t);
  app.document.querySelector('.list').focus();
  app.key('F9');
  const request = app.messages.find(message => message.type === 'open-terminal');
  assert.ok(request);
  const state = app.state();
  assert.equal(request.path, state.panes[state.active].tabs[state.panes[state.active].tab]);
  app.key('F9', { altKey: true });
  assert.equal(app.messages.filter(message => message.type === 'open-terminal').length, 1);
});

test('terminal actions preserve text entry and modal dialogs', t => {
  const app = createApp(t);
  const input = app.document.createElement('input'); app.document.body.append(input); input.focus();
  app.key('F9'); app.action('open-terminal');
  assert.equal(app.messages.some(message => message.type === 'open-terminal'), false);
  input.remove(); app.action('mkdir'); app.key('F9'); app.action('open-terminal');
  assert.equal(app.messages.some(message => message.type === 'open-terminal'), false);
});

test('terminal failures are recorded in the activity log without a modal', async t => {
  const app = createApp(t);
  app.document.querySelector('.list').focus(); app.key('F9');
  const request = app.messages.find(message => message.type === 'open-terminal'); assert.ok(request);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'ui-action-result', requestId: request.requestId, ok: false, error: 'Terminal unavailable' } }));
  assert.equal((await app.copyActivityLog()).currentMessage, 'Terminal unavailable');
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('F9 follows the active pane and reports unsupported platforms only on invocation', async t => {
  const app = createApp(t, undefined, { platform: 'darwin' });
  assert.equal(app.messages.some(message => message.type === 'open-terminal'), false);
  app.document.querySelector('.list').focus(); app.key('Tab'); app.key('F9');
  const request = app.messages.find(message => message.type === 'open-terminal'); assert.ok(request);
  assert.equal(app.state().active, 1);
  assert.equal(request.path, app.state().panes[1].tabs[app.state().panes[1].tab]);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'ui-action-result', requestId: request.requestId, ok: false, unsupported: true, error: 'Unsupported terminal' } }));
  assert.equal((await app.copyActivityLog()).currentMessage, 'Unsupported terminal');
  assert.equal(app.document.querySelector('#modal').open, false);
});
