const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
function fixture(side) {
  return { version: 1, realFilesystem: true, snapshotId: 'initial', active: side,
    panes: [pane('/left'), pane('/right')], unloadedFolders: ['/left/child', '/right/child'], folders: {
      '/left': [{ id: 'left-child', name: 'child', type: 'folder' }, { id: 'left-other', name: 'other', type: 'folder' }],
      '/right': [{ id: 'right-child', name: 'child', type: 'folder' }, { id: 'right-other', name: 'other', type: 'folder' }],
      '/left/child': [], '/right/child': [], '/left/other': [], '/right/other': []
    } };
}
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
const click = (app, side, id) => app.click(app.document.querySelector(`[data-pane="${side}"] [data-id="${id}"] [data-filename]`));
for (const side of [0, 1]) {
  test(`hidden tab completion on side ${side} cannot clear rows streamed to its duplicate`, t => {
    const initial = fixture(side), target = `${initial.panes[side].tabs[0]}/child`, obsolete = structuredClone(initial);
    const app = createApp(t, initial);
    click(app, side, `${side ? 'right' : 'left'}-child`); app.key('Enter');
    const first = app.messages.findLast(message => message.type === 'filesystem-navigate');
    app.action('new-tab');
    const second = app.messages.findLast(message => message.type === 'filesystem-navigate');
    send(app, { type: 'filesystem-directory', navigationRequestId: second.navigationRequestId, path: target, rows: [{ id: 'streamed', name: 'streamed.txt', type: 'text' }] });
    assert.equal(Boolean(app.row('streamed.txt')), true);
    const expected = app.state().panes.map(p => [...p.tabs]);
    send(app, { type: 'filesystem-result', navigationRequestId: first.navigationRequestId, ok: true, state: obsolete });
    assert.equal(Boolean(app.row('streamed.txt')), true);
    assert.deepEqual(app.state().panes.map(p => [...p.tabs]), expected);
  });
  for (const order of ['old-first', 'new-first']) test(`out-of-order success ${order} on side ${side} preserves both panel destinations and current rows`, t => {
    const initial = fixture(side), original = structuredClone(initial), app = createApp(t, initial);
    const navigate = path => {
      app.action('path'); const input = app.document.querySelector(`[data-pane="${side}"] .path-input`);
      input.value = path; app.key('Enter', {}, input);
      return app.messages.findLast(message => message.type === 'filesystem-navigate');
    };
    const first = navigate('/earlier'), second = navigate('/latest');
    const expected = app.state().panes.map(p => [...p.tabs]);
    const current = structuredClone(original); current.snapshotId = 'latest';
    current.folders['/latest'] = [{ id: 'latest-row', name: 'latest.txt', type: 'text' }];
    const obsolete = structuredClone(original); obsolete.snapshotId = 'earlier'; obsolete.folders['/earlier'] = [];
    const oldReply = { type: 'filesystem-result', navigationRequestId: first.navigationRequestId, ok: true, state: obsolete };
    const newReply = { type: 'filesystem-result', navigationRequestId: second.navigationRequestId, ok: true, state: current };
    app.click(app.document.querySelector(`[data-pane="${1 - side}"] .list`));
    for (const reply of order === 'old-first' ? [oldReply, newReply] : [newReply, oldReply]) {
      send(app, reply);
      assert.deepEqual(app.state().panes.map(p => [...p.tabs]), expected);
      assert.equal(app.state().active, 1 - side);
    }
    assert.equal(app.state().snapshotId, 'latest');
    assert.equal(Boolean(app.document.querySelector(`[data-pane="${side}"] [data-id="latest-row"]`)), true);
    send(app, { type: 'filesystem-directory', navigationRequestId: first.navigationRequestId, path: '/earlier', rows: [{ id: 'late', name: 'late.txt', type: 'text' }] });
    assert.deepEqual(app.state().panes.map(p => [...p.tabs]), expected);
    assert.equal(Boolean(app.document.querySelector(`[data-pane="${side}"] [data-id="late"]`)), false);
  });
  test(`failed navigation on side ${side} preserves a newly opened background tab`, t => {
    const app = createApp(t, fixture(side));
    click(app, side, `${side ? 'right' : 'left'}-child`); app.key('Enter');
    app.action('background-tab');
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    const background = structuredClone(app.state().panes[side].tabStates[1]);
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: false, error: 'EACCES' });
    assert.equal(app.state().panes[side].tabs.length, 2);
    assert.equal(app.state().panes[side].tabs[0], side ? '/right' : '/left');
    assert.deepEqual(app.state().panes[side].tabStates[1], background);
    assert.match(app.document.querySelector('#status-message').textContent, /EACCES/);
  });
  test(`failed directory tab on side ${side} removes only its own tab`, t => {
    const app = createApp(t, fixture(side));
    click(app, side, `${side ? 'right' : 'left'}-child`); app.action('open-dir-tab');
    app.action('background-tab');
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    const background = structuredClone(app.state().panes[side].tabStates[2]);
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: false, error: 'EACCES' });
    assert.equal(app.state().panes[side].tabs.length, 2);
    assert.equal(app.state().panes[side].tabStates.some(tab => tab.id === request.navigationTabId), false);
    assert.deepEqual(app.state().panes[side].tabStates[1], background);
    assert.match(app.document.querySelector('#status-message').textContent, /EACCES/);
  });
  test(`unknown path on side ${side} clears immediately and obsolete failure cannot undo later navigation`, t => {
    const initial = fixture(side), app = createApp(t, initial);
    const navigate = path => {
      app.action('path'); const input = app.document.querySelector(`[data-pane="${side}"] .path-input`);
      input.value = path; app.key('Enter', {}, input);
      return app.messages.findLast(message => message.type === 'filesystem-navigate');
    };
    const first = navigate('/unknown');
    assert.equal(app.state().panes[side].tabs[0], '/unknown');
    assert.equal(Boolean(app.document.querySelector(`[data-pane="${side}"] [data-file-row][data-id]`)), false);
    const second = navigate('/later');
    send(app, { type: 'filesystem-result', navigationRequestId: first.navigationRequestId, ok: false, error: 'ENOENT' });
    assert.equal(app.state().panes[side].tabs[0], '/later');
    const fresh = app.state(); fresh.folders['/later'] = [{ id: 'later', name: 'later.txt', type: 'text' }];
    send(app, { type: 'filesystem-result', navigationRequestId: second.navigationRequestId, ok: true, state: fresh });
    assert.equal(app.state().panes[side].tabs[0], '/later');
    assert.ok(app.document.querySelector(`[data-pane="${side}"] [data-id="later"]`));
  });
  for (const outcome of ['EACCES', 'ENOENT', 'cancelled']) test(`cold navigation on side ${side} restores its source after ${outcome}`, t => {
    const initial = fixture(side), root = initial.panes[side].tabs[0];
    const app = createApp(t, initial);
    click(app, side, `${side ? 'right' : 'left'}-child`); app.key('Enter');
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId,
      ok: outcome === 'cancelled', cancelled: outcome === 'cancelled', error: outcome });
    assert.equal(app.state().panes[side].tabs[0], root);
    assert.ok(app.document.querySelector(`[data-pane="${side}"] [data-id="${side ? 'right' : 'left'}-other"]`));
    assert.equal(app.state().panes[side].tabStates[0].history.length, 1);
  });
  test(`cold navigation on side ${side} clears old rows before any host response`, t => {
    const initial = fixture(side), root = initial.panes[side].tabs[0], target = `${root}/child`;
    const app = createApp(t, initial);
    click(app, side, `${side ? 'right' : 'left'}-child`); app.key('Enter');
    assert.equal(app.state().panes[side].tabs[0], target);
    assert.equal(app.document.querySelector(`[data-pane="${side}"] [data-id="${side ? 'right' : 'left'}-other"]`), null);
    assert.ok(app.document.querySelector(`[data-pane="${1 - side}"] [data-file-row]`));
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    const row = { id: 'fresh', name: 'fresh.txt', type: 'text' };
    send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: target, names: ['fresh.txt'], rows: [row] });
    assert.ok(app.document.querySelector(`[data-pane="${side}"] [data-id="fresh"]`));
    const fresh = structuredClone(initial); fresh.unloadedFolders = []; fresh.folders[target] = [row];
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: fresh });
    assert.equal(app.state().panes[side].tabs[0], target);
    assert.equal(app.state().panes[side].tabs.length, 1);
  });
  for (const command of ['open-dir-tab', 'open-dir-other-tab']) test(`${command} from side ${side} keeps its captured destination after selection changes`, t => {
    const initial = fixture(side), root = initial.panes[side].tabs[0], target = `${root}/child`;
    const expected = initial.panes.map(p => [...p.tabs]), destinationSide = command === 'open-dir-other-tab' ? 1 - side : side;
    expected[destinationSide].push(target);
    const app = createApp(t, initial);
    click(app, side, `${side ? 'right' : 'left'}-child`); app.action(command);
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    assert.deepEqual(app.state().panes.map(p => [...p.tabs]), expected);
    const otherSide = 1 - destinationSide;
    click(app, otherSide, `${otherSide ? 'right' : 'left'}-other`);
    const fresh = structuredClone(initial); fresh.unloadedFolders = []; fresh.folders[target] = [{ id: 'loaded', name: 'loaded.txt', type: 'text' }];
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: fresh });
    assert.deepEqual(app.state().panes.map(p => [...p.tabs]), expected);
    assert.equal(app.state().active, otherSide);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-navigate').length, 1);
  });
  test(`completion of a closed destination tab on side ${side} cannot reopen it`, t => {
    const initial = fixture(side), target = `${initial.panes[side].tabs[0]}/child`, app = createApp(t, initial);
    click(app, side, `${side ? 'right' : 'left'}-child`); app.action('open-dir-tab');
    const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
    app.action('close-tab');
    const expected = app.state().panes.map(p => [...p.tabs]);
    const fresh = app.state(); fresh.unloadedFolders = []; fresh.folders[target] = [];
    send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: fresh });
    assert.deepEqual(app.state().panes.map(p => [...p.tabs]), expected);
  });
}
