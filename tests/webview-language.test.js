const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));

test('language icon precedes notifications and requests the native language picker', t => {
  const app = createApp(t);
  const button = app.document.querySelector('#language-toggle');
  assert.ok(button);
  assert.equal(button.nextElementSibling.id, 'notifications-toggle');
  assert.ok(button.querySelector('svg'));
  assert.equal(button.getAttribute('aria-label'), 'Sprache wechseln');
  app.click(button);
  assert.equal(app.messages.at(-1).type, 'choose-language');
});

test('language reload preserves the view and waits for an open dialog', async t => {
  const app = createApp(t);
  app.action('mkdir');
  send(app, { type: 'language-changed' });
  assert.equal(app.messages.some(message => message.type === 'language-reload'), false);
  app.document.querySelector('#modal').close();
  await new Promise(resolve => setTimeout(resolve, 150));
  const message = app.messages.find(message => message.type === 'language-reload');
  assert.ok(message);
  assert.deepEqual(JSON.parse(JSON.stringify(message.state)), app.state());
});

test('English language also translates static main-menu controls while retaining menu grouping', t => {
  const app = createApp(t, undefined, { language: 'en' });
  const first = app.document.querySelector('[data-main-menu] > button');
  assert.equal(first.textContent, 'Files');
  app.click(first);
  assert.equal(app.document.querySelector('#main-menu-popup [data-group="Dateien"]').hidden, false);
  assert.match(app.document.querySelector('#main-menu-popup [data-group="Dateien"]').textContent, /Pack/);
});

test('language reload waits for the matching transfer result without requesting cancellation', async t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a'], cursor: 'a', filter: '', sort: 'name' });
  const state = { version: 1, realFilesystem: true, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': [{ id: 'a', name: 'a.txt', type: 'text', fsSource: '/left/a.txt', size: 4 }], '/right': [] } };
  const app = createApp(t, state);
  app.action('copy');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  const operation = app.messages.find(message => message.type === 'filesystem-apply');
  assert.ok(operation);
  send(app, { type: 'language-changed' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(app.messages.some(message => message.type === 'language-reload' || message.type === 'filesystem-cancel'), false);
  send(app, { type: 'filesystem-result', operationId: operation.operationId, ok: true, state, operationOutcome: { cancelled: true, completedIds: [] } });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(app.messages.find(message => message.type === 'language-reload'));
});
