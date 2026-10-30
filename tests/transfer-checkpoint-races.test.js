const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => structuredClone(value);
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: ['a', 'b', 'c'], cursor: 'a', filter: '', sort: 'name' });
  const file = (id, name, directory) => ({ id, name, type: 'text', content: id, size: 1, fsSource: `${directory}/${name}` });
  return { version: 1, realFilesystem: true, snapshotId: 'before', active: 0, panes: [pane('C:/tmp'), pane('C:/temp')], folders: {
    'C:/tmp': ['a', 'b', 'c'].map(id => file(id, `${id}.txt`, 'C:/tmp')),
    'C:/temp': [file('old-b', 'b.txt', 'C:/temp'), file('old-c', 'c.txt', 'C:/temp')]
  } };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
const applies = app => app.messages.filter(message => message.type === 'filesystem-apply');
function confirmed(request) {
  const state = clone(request.state); state.snapshotId += '-next';
  for (const row of state.folders['C:/temp']) row.fsSource = `C:/temp/${row.name}`;
  return state;
}
function reply(app, request, state, ok = true) {
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, ok, state, error: ok ? undefined : 'Write denied' } }));
}

test('a target deleted during a prior write does not produce a stale conflict or remove neighbours', async t => {
  const saved = fixture(); saved.panes[0].selected = ['a', 'b'];
  const app = createApp(t, saved); app.action('copy'); submit(app); await tick();
  const first = applies(app)[0], native = confirmed(first);
  native.folders['C:/temp'] = native.folders['C:/temp'].filter(row => row.name !== 'b.txt');
  reply(app, first, native); await tick();
  const second = applies(app)[1]; assert.ok(second);
  assert.equal(app.document.querySelector('[data-conflict-action="overwrite"]'), null);
  assert.deepEqual(Array.from(second.state.folders['C:/temp'], row => row.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
});

test('a conflict uses fresh metadata returned after the preceding host write', async t => {
  const app = createApp(t, fixture()); app.action('copy'); submit(app); await tick();
  const first = applies(app)[0], native = confirmed(first);
  native.folders['C:/temp'].find(row => row.name === 'b.txt').date = '01.01.2030 00:00';
  reply(app, first, native); await tick();
  assert.match(app.document.querySelector('[data-conflict-file="target"] .comparison-meta').textContent, /2030/);
});

test('later writes have distinct operation ids and reject stale earlier acknowledgements', async t => {
  const app = createApp(t, fixture()); app.action('copy'); submit(app); await tick();
  const first = applies(app)[0]; reply(app, first, confirmed(first)); await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const second = applies(app)[1]; assert.ok(second); assert.notEqual(second.operationId, first.operationId);
  reply(app, first, confirmed(first)); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  reply(app, second, confirmed(second)); await tick();
  assert.equal(app.document.querySelector('[data-conflict-file="source"] .comparison-name').textContent, 'c.txt');
});

test('a later failed write acknowledges only the already confirmed cut prefix', async t => {
  const app = createApp(t, fixture()); app.key('x', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt', 'C:/tmp/c.txt'], mode: 'move', token: 'prefix', source: 'system' };
  const respond = type => {
    const request = app.messages.find(message => message.type === type);
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, selection } }));
  };
  respond('clipboard-write'); app.key('Tab'); app.key('v', { ctrlKey: true }); respond('clipboard-read'); submit(app); await tick();
  const first = applies(app)[0], native = confirmed(first); reply(app, first, native); await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const second = applies(app)[1]; assert.ok(second); reply(app, second, clone(native), false); await tick();
  const acknowledgement = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(acknowledgement);
  assert.deepEqual(Array.from(acknowledgement.remainingPaths), ['C:/tmp/b.txt', 'C:/tmp/c.txt']);
  assert.equal(app.state().folders['C:/tmp'].some(row => row.name === 'a.txt'), false);
});

test('overwrite all keeps subsequent automatic decisions in one host batch', async t => {
  const saved = fixture();
  saved.folders['C:/temp'].unshift({ id: 'old-a', name: 'a.txt', type: 'text', content: 'old-a', size: 5, fsSource: 'C:/temp/a.txt' });
  const app = createApp(t, saved); app.action('copy'); submit(app); await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite-all"]')); await tick();
  assert.equal(applies(app).length, 1);
  for (const id of ['a', 'b', 'c']) assert.equal(applies(app)[0].state.folders['C:/temp'].find(row => row.name === `${id}.txt`).content, id);
});

test('final host outcomes retain earlier successes and unmark all confirmed copied entries', async t => {
  const app = createApp(t, fixture()); app.action('copy'); submit(app); await tick();
  const first = applies(app)[0]; reply(app, first, confirmed(first)); await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const second = applies(app)[1]; reply(app, second, confirmed(second)); await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const last = applies(app)[2]; assert.ok(last);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: last.operationId, ok: true, state: confirmed(last), operationOutcome: { completedIds: ['c'], cancelled: false } } })); await tick();
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.match(app.document.querySelector('#status-message').textContent, /3/);
});
