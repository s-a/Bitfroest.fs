const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { changedRepository } = require('./support/git-fixture.cjs');
const { createGitStatusProvider } = require('../git-status-provider');

test('real worker reports status and branches with an empty executable search path', async t => {
  const { dir } = await changedRepository(t);
  const provider = createGitStatusProvider({ workerEnv: { ...process.env, PATH: '', Path: '' } }); t.after(() => provider.dispose());
  const result = await provider.inspect([dir]);
  assert.equal(result[dir].branch, 'main'); assert.equal(result[dir].statuses['modified.txt'], 'modified');
  assert.equal((await provider.branches(dir)).count, 3);
});

test('same pending query shares one worker job and disposal settles pending work', async () => {
  const worker = new EventEmitter(); const messages = [];
  worker.postMessage = message => messages.push(message); worker.terminate = async () => 0; worker.unref = () => {};
  const provider = createGitStatusProvider({ createWorker: () => worker });
  const first = provider.inspect(['/repo']), second = provider.inspect(['/repo']);
  assert.equal(messages.length, 1);
  worker.emit('message', { id: messages[0].id, result: { '/repo': { branch: 'main' } } });
  assert.deepEqual(await first, await second);
  const pending = provider.branches('/repo'); provider.dispose();
  await assert.rejects(pending, /closed/i);
});

test('suspending releases the worker and allows a new lazy worker on reactivation', async () => {
  let created = 0, terminated = 0;
  const provider = createGitStatusProvider({ createWorker: () => {
    created++; const worker = new EventEmitter(); worker.terminate = async () => { terminated++; };
    worker.postMessage = message => queueMicrotask(() => worker.emit('message', { id: message.id, result: {} })); return worker;
  } });
  await provider.inspect(['/repo']); provider.suspend(); assert.equal(terminated, 1);
  await provider.inspect(['/repo']); assert.equal(created, 2); provider.dispose();
});

test('watcher updates an externally modified file without repeated polling', async t => {
  const { dir, write } = await changedRepository(t);
  let changed;
  const notification = new Promise(resolve => { changed = resolve; });
  const provider = createGitStatusProvider({ onChange: changed }); t.after(() => provider.dispose());
  await provider.inspect([dir]); await write('clean.txt', 'external change\n');
  const timeout = setTimeout(() => changed('timeout'), 5000); t.after(() => clearTimeout(timeout));
  assert.notEqual(await notification, 'timeout');
  const result = await provider.inspect([dir]); assert.equal(result[dir].statuses['clean.txt'], 'modified');
});

test('returning to an unwatched repository revalidates changes made while another directory was open', async t => {
  const first = await changedRepository(t), second = await changedRepository(t);
  const provider = createGitStatusProvider(); t.after(() => provider.dispose());
  assert.equal((await provider.inspect([first.dir]))[first.dir].statuses['clean.txt'], 'clean');
  await provider.inspect([second.dir]); await first.write('clean.txt', 'external change while repository was not watched\n');
  assert.equal((await provider.inspect([first.dir]))[first.dir].statuses['clean.txt'], 'modified');
});
