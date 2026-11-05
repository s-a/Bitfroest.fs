const test = require('node:test');
const assert = require('node:assert/strict');
const Progress = require('../media/bitfroest-progress');
const { createApp } = require('./support/webview.cjs');

for (const refreshing of [false, true]) test(`malformed Git progress retains operable file lists ${refreshing ? 'after filesystem refresh' : 'after startup'}`, t => {
  const pane = directory => ({ tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const diagnostics = [], errors = [];
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'isolation', active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'file', name: 'file.txt', type: 'text' }], '/right': []
  } }, { beforeApp({ window }) { window.BitfroestDiagnostics = { report: (name, detail) => diagnostics.push({ name, ...detail }), registerState() {} }; } });
  app.window.addEventListener('error', event => { errors.push(event.message); event.preventDefault(); });
  const send = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  let query = app.messages.find(message => message.type === 'git-status');
  if (refreshing) {
    send({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId,
      directories: { '/left': { ok: true, repository: false }, '/right': { ok: true, repository: false } } });
    send({ type: 'window-focus' });
    send({ type: 'filesystem-result', ok: true, state: { ...app.state(), snapshotId: 'refreshed' } });
    query = app.messages.findLast(message => message.type === 'git-status');
  }
  const info = Progress.event({ phase: 'git-dirty-check', stage: 'inspect', ok: true, repository: false, loading: true,
    repositoryChecks: { total: 2, completed: 1, active: '/left/a' },
    overall: Progress.unknown('requests', 1, 'enumerating'), current: Progress.known('requests', 1, 2) });
  send({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, partial: true, directories: { '/left': info } });
  assert.deepEqual(errors, []);
  assert.ok(diagnostics.some(event => event.name === 'git-protocol-error' && /identities/.test(event.message) && event.directory === '/left'));
  assert.equal(app.document.querySelectorAll('.pane').length, 2);
  assert.equal(Boolean(app.document.querySelector('#panes').inert), false);
  assert.ok(app.row('file.txt'));
  send({ type: 'icons', icons: { '/left/file.txt': 'data:image/png;base64,AAAA' } });
  assert.ok(app.row('file.txt').querySelector('img.native-icon'));
  send({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, directories: { '/right': { ok: true, repository: false, statuses: {} } } });
  assert.equal(app.document.querySelector('#status-activity').hidden, true);
  const count = diagnostics.length;
  send({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, partial: true, directories: { '/left': info } });
  assert.deepEqual(errors, []); assert.equal(diagnostics.length, count);
});
