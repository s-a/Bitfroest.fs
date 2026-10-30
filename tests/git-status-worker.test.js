const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('new directory and repository metadata are watched before status inspection starts', async () => {
  const port = new EventEmitter(), observed = new Set(), messages = [];
  port.postMessage = message => messages.push(message);
  const engine = { invalidate() {}, locate: async () => ({ gitdir: '/repo/.git', dir: '/repo' }),
    inspect: async directory => ({ ok: true, repository: true, root: '/repo', gitdir: '/repo/.git', watchedBeforeScan: observed.has(directory), statuses: {} }) };
  const watcherFs = { watch(directory) { observed.add(directory); const watcher = new EventEmitter(); watcher.close = () => observed.delete(directory); return watcher; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../git-status-worker.js'), 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port } : name === 'node:fs' ? watcherFs : name === 'node:path' ? path : { createGitStatusEngine: () => engine },
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  port.emit('message', { id: 1, type: 'inspect', directories: ['/repo'], settings: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.find(message => message.id === 1)?.result?.['/repo'].watchedBeforeScan, true);
});
