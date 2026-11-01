const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture() {
  const port = new EventEmitter(), messages = [], scans = [], timers = [], watches = [];
  let revision = 0, status = 'clean', cached;
  port.postMessage = message => messages.push(message);
  const engine = {
    invalidate() { revision++; cached = undefined; },
    describe: async () => ({ ok: true, repository: true, branch: 'main', statuses: {} }),
    locate: async directory => ({ gitdir: directory + '/.git', dir: directory }),
    inspect: async directory => {
      scans.push({ directory, revision });
      return cached ||= { ok: true, repository: true, branch: 'main', statuses: { file: status } };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../git-status-worker.js'), 'utf8'), {
    require: name => name === './media/commander-progress' ? require('../media/commander-progress') : name === 'node:worker_threads' ? { parentPort: port } : name === 'node:fs' ? {
      watch(directory) { watches.push(directory); const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; }
    } : name === 'node:path' ? path.posix : { createGitStatusEngine: () => engine },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {}
  });
  return { messages, scans, timers, watches,
    changeStatus(value) { status = value; },
    request(id) { port.emit('message', { id, type: 'inspect', directories: ['/repo'], settings: {} }); },
    async settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }
  };
}

test('status requests do not register filesystem watchers or periodic refresh timers', async () => {
  const app = fixture(); app.request(1); await app.settle();
  assert.equal(app.messages.find(message => message.id === 1 && !message.type).result['/repo'].statuses.file, 'clean');
  assert.deepEqual(app.watches, []);
  assert.deepEqual(app.timers, []);
  assert.equal(app.messages.some(message => message.type === 'changed'), false);
});

test('a new focus or explicit refresh request reads fresh status within the former cache interval', async () => {
  const app = fixture(); app.request(1); await app.settle();
  app.changeStatus('modified'); app.request(2); await app.settle();
  assert.equal(app.messages.find(message => message.id === 2 && !message.type).result['/repo'].statuses.file, 'modified');
  assert.equal(app.scans.length, 2);
  assert.ok(app.scans[1].revision > app.scans[0].revision);
});

test('worker publishes branch identities before any status inspection', async t => {
  const port = new EventEmitter(), messages = [], scanned = [];
  port.postMessage = message => messages.push(message);
  let release; const blocked = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const engine = { invalidate() {}, describe: async () => ({ ok: true, repository: true, branch: 'main', statuses: {} }), locate: async directory => ({ gitdir: directory + '/.git', dir: directory }),
    branches: async () => ({ ok: true, names: ['main'] }),
    inspect: async directory => { scanned.push(directory); await blocked; return { ok: true, repository: true, branch: 'main', statuses: {} }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../git-status-worker.js'), 'utf8'), {
    require: name => name === './media/commander-progress' ? require('../media/commander-progress') : name === 'node:worker_threads' ? { parentPort: port } : name === 'node:fs' ? { watch() { const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; } } : name === 'node:path' ? path : { createGitStatusEngine: () => engine },
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


test('a failed branch description does not complete the directory before status inspection', async t => {
  const port = new EventEmitter(), messages = [];
  let release; const blocked = new Promise(resolve => { release = resolve; }); t.after(() => release());
  port.postMessage = message => messages.push(message);
  const engine = { invalidate() {}, describe: async () => ({ ok: false, error: 'unavailable', statuses: {} }), inspect: async () => { await blocked; return { ok: true, repository: false, statuses: {} }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../git-status-worker.js'), 'utf8'), {
    require: name => name === './media/commander-progress' ? require('../media/commander-progress') : name === 'node:worker_threads' ? { parentPort: port } : { createGitStatusEngine: () => engine }
  });
  port.emit('message', { id: 1, type: 'inspect', directories: ['/repo'], settings: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].result['/repo'].loading, true);
  assert.equal(messages.some(message => !message.type), false);
});
