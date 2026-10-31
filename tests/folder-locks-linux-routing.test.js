const test = require('node:test');
const assert = require('node:assert/strict');
const { createPosixFolderLocks } = require('../folder-locks-posix');
const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');

test('Linux default routing loads the packaged module without probing or executing an interpreter', async t => {
  const { calls, sessions } = stubPackagedNativeBinding(t, { 'locks.rename': () => ({ changed: 1, errors: [] }), 'processes.terminate': () => ({ changed: 0, errors: [] }) });
  const provider = createPosixFolderLocks({ platform: 'linux', fs: { access() { assert.fail('interpreter probe'); } }, execute() { assert.fail('interpreter execution'); } });
  t.after(() => provider.dispose());
  const caps = await provider.capabilities();
  assert.equal(caps.actions.rename.available, true);
  assert.equal(caps.actions.terminate.available, true);
  assert.equal((await provider.request({ action: 'rename', path: '/safe/a', destination: '/safe/b', expected: { dev: '1', ino: '2' }, expectedParent: { dev: '1', ino: '3' } })).changed, 1);
  assert.equal(calls[0].operation, 'locks.rename');
  provider.dispose();
  assert.equal(sessions[0].closed, true);
});

function fixture(t, invoke, options = {}) {
  const calls = [], sessions = [];
  const nativeApi = {
    capabilities: Object.fromEntries(['locks.rename', 'processes.terminate'].map(operation => [operation, { status: 'conditional' }])),
    openSession() {
      const session = { close() { calls.push(['close']); }, invoke(operation, request) { calls.push([operation, request]); return invoke(operation, request); } };
      sessions.push(session); return session;
    }
  };
  const provider = createPosixFolderLocks({ platform: 'linux', nativeApi, execute() { throw new Error('External process execution is forbidden.'); }, ...options });
  t.after(() => provider.dispose());
  return { provider, calls, sessions };
}

test('Linux capabilities and mutations use the native module with precise identities and one reusable session', async t => {
  const { provider, calls, sessions } = fixture(t, () => ({ changed: 1, errors: [] }));
  const caps = await provider.capabilities();
  assert.equal(caps.actions.terminate.available, true);
  assert.equal(caps.actions.rename.available, true);
  assert.equal(caps.actions.unlock.available, false);
  assert.equal(caps.actions.schedule.available, false);
  const rename = { action: 'rename', path: '/safe/source', destination: '/safe/target', expected: { dev: '1', ino: '9007199254740993' }, expectedParent: { dev: '1', ino: '12' } };
  assert.equal((await provider.request(rename)).changed, 1);
  const rows = [{ pid: 1234, started: 'linux:boot:9999999999999', file: '/safe/source/a', kind: 'handle' }];
  await provider.request({ action: 'terminate', path: '/safe/source', rows, hostPid: 1 });
  assert.deepEqual(calls[0], ['locks.rename', { path: rename.path, destination: rename.destination, expected: rename.expected, expectedParent: rename.expectedParent }]);
  assert.deepEqual(calls[1], ['processes.terminate', { path: '/safe/source', rows, hostPid: process.pid }]);
  assert.equal(sessions.length, 1);
  provider.dispose(); assert.equal(calls.filter(([operation]) => operation === 'close').length, 1);
});

test('Linux disposal closes native work and rejects a pending caller without publishing its late result', async t => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { provider, calls } = fixture(t, () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const pending = provider.request({ action: 'terminate', path: '/safe', rows: [] });
  await started;
  provider.dispose();
  await assert.rejects(pending, /geschlossen/);
  finish({ changed: 1, errors: [] });
  assert.equal(calls.filter(([operation]) => operation === 'close').length, 1);
  await assert.rejects(provider.request({ action: 'terminate', path: '/safe', rows: [] }), /geschlossen/);
});

test('Linux ordinary file actions never fall through to process termination', async t => {
  const { provider, calls } = fixture(t, () => ({ changed: 1, errors: [] }));
  for (const action of ['copy', 'copy-info', 'delete', 'delete-processes']) {
    await assert.rejects(provider.request({ action, path: '/safe', rows: [] }), /Sperrenaktion/);
  }
  assert.deepEqual(calls, []);
});

test('Linux native deadline invalidates the stalled session and a later explicit request opens a new one', async t => {
  let finish;
  const { provider, calls, sessions } = fixture(t, () => sessions.length === 1 ? new Promise(resolve => { finish = resolve; }) : { changed: 1, errors: [] }, { timeout: 5 });
  await assert.rejects(provider.request({ action: 'rename', path: '/safe/a', destination: '/safe/b' }), { code: 'ETIMEDOUT' });
  assert.equal(calls.filter(([operation]) => operation === 'close').length, 1);
  finish({ changed: 0, errors: ['late'] });
  assert.equal((await provider.request({ action: 'rename', path: '/safe/a', destination: '/safe/b' })).changed, 1);
  assert.equal(sessions.length, 2);
});
