const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const send = (app, settings) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'favorite-settings', settings } }));

test('the favorite tree preserves group order and empty groups without encoding names as paths', t => {
  const app = createApp(t);
  send(app, { entries: {}, items: [{ id: 'b', type: 'group', name: 'Second', parent: null }, { id: 'a', type: 'group', name: 'First', parent: null }] });
  app.click(app.document.querySelector('[data-favorites]'));
  assert.deepEqual([...app.document.querySelectorAll('[data-favorite-group]')].map(item => item.textContent), ['Second', 'First']);
  app.click(app.document.querySelector('[data-favorite-group]'));
  assert.ok(app.document.querySelector('[data-favorite-back]'));
});

test('drive root favorites retain an absolute path in the host request', t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null });
  const app = createApp(t, { version: 1, realFilesystem: true, active: 0, panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } });
  send(app, { entries: { Root: 'C:\\' }, caseSensitive: false });
  app.click(app.document.querySelector('[data-favorites]')); app.click(app.document.querySelector('[data-favorite-entry]'));
  assert.equal(app.messages.find(item => item.type === 'filesystem-navigate').path, 'C:/');
});

test('the star replaces the up button and opens a keyboard accessible panel menu with settings access', t => {
  const app = createApp(t);
  assert.equal(app.document.querySelector('[data-up]'), null);
  const stars = app.document.querySelectorAll('[data-favorites]');
  assert.equal(stars.length, 2);
  app.click(stars[1]);
  assert.equal(app.document.querySelector('[data-favorite-menu]').closest('[data-pane]').dataset.pane, '1');
  app.key('Escape');
  assert.equal(app.document.querySelector('[data-favorite-menu]'), null);
  assert.equal(app.document.activeElement, stars[1]);
  app.click(stars[1]); app.click(app.document.querySelector('[data-favorite-configure]'));
  assert.ok(app.messages.some(item => item.type === 'configure-favorites'));
});

test('favorite changes update without restart, render labels as text and navigate the originating panel', t => {
  const app = createApp(t), destination = app.state().panes[0].tabs[0];
  send(app, { entries: { '<b>Work</b>': destination }, groups: {}, targets: {}, order: [] });
  app.click(app.document.querySelector('[data-pane="1"] [data-favorites]'));
  const item = app.document.querySelector('[data-favorite-entry]');
  assert.equal(item.textContent, '<b>Work</b>'); assert.equal(item.querySelector('b'), null);
  app.click(item);
  assert.equal(app.state().panes[1].tabs[app.state().panes[1].tab], destination);
  assert.equal(app.state().active, 1);
});

test('favorite submenu preserves grouping and current-directory add/remove actions send the panel path', t => {
  const app = createApp(t), path = app.state().panes[0].tabs[0];
  send(app, { entries: { work: path }, labels: { work: 'Work' }, groups: { work: 'Projects' }, order: ['work'] });
  app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-favorite-group]'));
  assert.equal(app.document.querySelector('[data-favorite-entry]').textContent, 'Work');
  app.key('Escape'); app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-favorite-toggle]'));
  assert.ok(app.messages.some(item => item.type === 'favorite-toggle' && item.path === path));
  assert.equal(app.document.activeElement, app.document.querySelector('[data-favorites]'));
});

test('paired favorites wait for successful host navigation and then update the opposite panel', t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null });
  const saved = { version: 1, realFilesystem: true, active: 0, panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, saved);
  send(app, { entries: { Media: 'A:/Media' }, targets: { Media: 'C:/Downloads' }, caseSensitive: false });
  app.click(app.document.querySelector('[data-pane="1"] [data-favorites]')); app.click(app.document.querySelector('[data-favorite-entry]'));
  assert.equal(app.messages.filter(item => item.type === 'filesystem-navigate').length, 1);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: { ...saved, folders: { ...saved.folders, 'A:/Media': [] } } } }));
  const requests = app.messages.filter(item => item.type === 'filesystem-navigate');
  assert.equal(requests[1].path, 'C:/Downloads'); assert.equal(requests[1].side, 0);
  const next = app.state();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: { ...next, folders: { ...next.folders, 'C:/Downloads': [] } } } }));
  assert.equal(app.state().panes[1].tabs[0], 'A:/Media');
  assert.equal(app.state().panes[0].tabs[0], 'C:/Downloads');
  assert.equal(app.state().active, 1);
});

test('failed favorite navigation preserves tabs and does not request the opposite target', t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null });
  const saved = { version: 1, realFilesystem: true, active: 0, panes: [p('C:/tmp'), p('C:/temp')], folders: { 'C:/tmp': [], 'C:/temp': [] } };
  const app = createApp(t, saved);
  send(app, { entries: { Missing: 'A:/missing' }, targets: { Missing: 'C:/Downloads' } });
  app.click(app.document.querySelector('[data-favorites]')); app.click(app.document.querySelector('[data-favorite-entry]'));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, error: 'Missing directory', state: saved } }));
  assert.equal(app.messages.filter(item => item.type === 'filesystem-navigate').length, 1);
  assert.deepEqual(app.state().panes.map(pane => pane.tabs), saved.panes.map(pane => pane.tabs));
});
