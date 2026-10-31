const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('new directory and repository metadata are watched before status inspection starts', async () => {
  const port = new EventEmitter(), observed = new Set(), messages = [];
  port.postMessage = message => messages.push(message);
  const engine = { invalidate() {}, describe: async () => ({ ok: true, repository: true, branch: 'main', statuses: {} }), locate: async () => ({ gitdir: '/repo/.git', dir: '/repo' }),
    inspect: async directory => ({ ok: true, repository: true, root: '/repo', gitdir: '/repo/.git', watchedBeforeScan: observed.has(directory), statuses: {} }) };
  const watcherFs = { watch(directory) { observed.add(directory); const watcher = new EventEmitter(); watcher.close = () => observed.delete(directory); return watcher; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../git-status-worker.js'), 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port } : name === 'node:fs' ? watcherFs : name === 'node:path' ? path : { createGitStatusEngine: () => engine },
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  port.emit('message', { id: 1, type: 'inspect', directories: ['/repo'], settings: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.find(message => message.id === 1 && message.type !== 'progress')?.result?.['/repo'].watchedBeforeScan, true);
});

test('worker publishes branch identities before any status inspection', async t => {
  const port = new EventEmitter(), messages = [], scanned = [];
  port.postMessage = message => messages.push(message);
  let release; const blocked = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const engine = { invalidate() {}, describe: async () => ({ ok: true, repository: true, branch: 'main', statuses: {} }), locate: async directory => ({ gitdir: directory + '/.git', dir: directory }),
    branches: async () => ({ ok: true, names: ['main'] }),
    inspect: async directory => { scanned.push(directory); await blocked; return { ok: true, repository: true, branch: 'main', statuses: {} }; } };
  const watcherFs = { watch() { const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../git-status-worker.js'), 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port } : name === 'node:fs' ? watcherFs : name === 'node:path' ? path : { createGitStatusEngine: () => engine },
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  port.emit('message', { id: 1, type: 'inspect', directories: ['/first', '/second'], settings: {} });
  await new Promise(resolve => setImmediate(resolve));
  const progress = messages.filter(message => message.type === 'progress');
  assert.equal(progress.length, 2);
  assert.equal(progress[0].result['/first'].branch, 'main');
  assert.equal(progress[1].result['/second'].loading, true);
  assert.equal(messages.some(message => message.id === 1 && message.type !== 'progress'), false);
  port.emit('message', { id: 2, type: 'branches', directory: '/first' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.find(message => message.id === 2)?.result.names[0], 'main');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanned.length, 2);
  assert.equal(messages.filter(message => message.type === 'progress').length, 4);
});
