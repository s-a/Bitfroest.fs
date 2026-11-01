const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { changedRepository } = require('./support/git-fixture.cjs');
const { createGitStatusProvider } = require('../git-status-provider');

test('real worker reports status and branches with an empty executable search path', async t => {
  const { dir } = await changedRepository(t);
  const provider = createGitStatusProvider({ workerEnv: { ...process.env, PATH: '', Path: '' } }); t.after(() => provider.dispose());
  const progress = [];
  const result = await provider.inspect([dir], {}, update => progress.push(update));
  const branch = progress.findIndex(update => update[dir].branch === 'main');
  const worktree = progress.findIndex(update => update[dir].phase === 'git-read-worktree');
  assert.ok(branch >= 0 && branch < worktree, 'branch identity precedes native status inspection');
  assert.equal(progress[branch][dir].loading, true);
  assert.equal(Object.keys(progress[branch][dir].statuses).length, 0);
  assert.equal(progress[0][dir].phase, 'git-locate');
  assert.ok(progress.some(update => update[dir].incremental && update[dir].statuses['modified.txt'] === 'modified'));
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

test('a requested refresh reads externally modified files without an automatic notification', async t => {
  const { dir, write } = await changedRepository(t);
  let notifications = 0;
  const provider = createGitStatusProvider({ onChange: () => notifications++ }); t.after(() => provider.dispose());
  await provider.inspect([dir]); await write('clean.txt', 'external change\n');
  const result = await provider.inspect([dir]); assert.equal(result[dir].statuses['clean.txt'], 'modified');
  assert.equal(notifications, 0);
});

test('returning to an unwatched repository revalidates changes made while another directory was open', async t => {
  const first = await changedRepository(t), second = await changedRepository(t);
  const provider = createGitStatusProvider(); t.after(() => provider.dispose());
  assert.equal((await provider.inspect([first.dir]))[first.dir].statuses['clean.txt'], 'clean');
  await provider.inspect([second.dir]); await first.write('clean.txt', 'external change while repository was not watched\n');
  assert.equal((await provider.inspect([first.dir]))[first.dir].statuses['clean.txt'], 'modified');
});

test('a requested parent refresh updates repository root decoration', async t => {
  const fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const container = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-root-watch-'));
  t.after(() => fsp.rm(container, { recursive: true, force: true }));
  const fixture = await changedRepository(t), dir = path.join(container, 'repo');
  await fsp.rename(fixture.dir, dir);
  const provider = createGitStatusProvider(); t.after(() => provider.dispose());
  const initial = await provider.inspect([container]);
  assert.equal(initial[container].statuses.repo, 'modified');
  await fsp.writeFile(path.join(dir, 'nested/deep.txt'), 'changed from parent view\n');
  assert.equal((await provider.inspect([container]))[container].statuses.repo, 'modified');
});

test('progress reaches all shared subscribers without completing the pending request', async t => {
  const worker = new EventEmitter(), messages = [];
  worker.postMessage = message => messages.push(message); worker.terminate = async () => 0;
  const provider = createGitStatusProvider({ createWorker: () => worker }); t.after(() => provider.dispose());
  const seen = [], secondSeen = []; let done = false;
  const first = provider.inspect(['/repo'], {}, value => seen.push(value));
  const second = provider.inspect(['/repo'], {}, value => secondSeen.push(value));
  first.then(() => { done = true; }, () => {}); second.catch(() => {});
  const early = { '/repo': { branch: 'main', loading: true } };
  worker.emit('message', { id: messages[0].id, type: 'progress', result: early });
  await Promise.resolve();
  assert.equal(done, false); assert.deepEqual(seen, [early]); assert.deepEqual(secondSeen, [early]);
  worker.emit('message', { id: messages[0].id, result: { '/repo': { branch: 'main', statuses: {} } } });
  await Promise.all([first, second]);
});
