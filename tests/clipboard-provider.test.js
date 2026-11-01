const test = require('node:test');
const assert = require('node:assert/strict');
const { createClipboardProvider } = require('../clipboard-provider');

const allowed = value => /^C:\/tmp\//i.test(value);

test('Windows cancellation uses a separate operation without move acknowledgement', async () => {
  const app = nativeHarness();
  const selection = await app.provider.read();
  assert.equal(await app.provider.reset(selection), true);
  assert.equal(app.calls.at(-1).operation, 'clipboard.cancelFiles');
  assert.deepEqual(app.calls.at(-1).request, { token: selection.token, paths: selection.paths, mode: selection.mode });
  app.provider.dispose();
});

for (const platform of ['linux', 'darwin']) test(`${platform} system file clipboard is excluded without starting a helper or loading a binding`, async () => {
  let calls = 0;
  const provider = createClipboardProvider({ platform, contains: () => true,
    runHelper: async () => { calls++; return JSON.stringify({ paths: ['/tmp/a'], mode: 'copy', token: 'one' }); },
    nativeApiFactory: () => { calls++; throw new Error('Unexpected native load'); }
  });
  await assert.rejects(provider.read(), { code: 'CLIPBOARD_UNAVAILABLE' });
  await assert.rejects(provider.write({ paths: ['/tmp/a'], mode: 'copy' }), { code: 'CLIPBOARD_UNAVAILABLE' });
  await assert.rejects(provider.ack({ paths: ['/tmp/a'], remainingPaths: [], mode: 'move', token: 'one' }), { code: 'CLIPBOARD_UNAVAILABLE' });
  provider.dispose();
  assert.equal(calls, 0);
});

function nativeHarness(options = {}) {
  const calls = [], sessions = [];
  const api = {
    capabilities: options.capabilities || {},
    openSession() {
      const session = {
        closed: false,
        invoke(operation, request) {
          calls.push({ operation, request, session });
          if (session.closed) throw Object.assign(new Error('closed'), { code: 'SessionClosed' });
          if (operation === 'clipboard.readFiles') return Promise.resolve(options.selection || { paths: ['C:/tmp/Größe.txt'], mode: 'move', token: 'native-session:9:1' });
          if (operation === 'clipboard.writeFiles') return Promise.resolve({ paths: request.paths, mode: request.mode, token: 'native-session:9:2' });
          if (operation === 'clipboard.acknowledge' || operation === 'clipboard.cancelFiles') return Promise.resolve(options.acknowledgement || { matched: true, notificationErrors: [] });
          throw Object.assign(new Error('unknown operation'), { code: 'UnknownOperation' });
        },
        close() { session.closed = true; }
      };
      sessions.push(session);
      return session;
    }
  };
  let helperCalls = 0;
  const provider = createClipboardProvider({
    platform: 'win32',
    contains: allowed,
    nativeApiFactory: () => api,
    runHelper: async () => { helperCalls++; throw new Error('Windows must not start an external clipboard helper.'); }
  });
  return { provider, api, calls, sessions, helperCalls: () => helperCalls };
}

test('Windows file clipboard keeps one native session from read through acknowledgement', async t => {
  const app = nativeHarness();
  t.after(() => app.provider.dispose?.());

  const selection = await app.provider.read();
  assert.deepEqual(selection, {
    paths: ['C:/tmp/Größe.txt'], mode: 'move', token: 'native-session:9:1', source: 'system'
  });
  assert.equal(await app.provider.ack({
    ...selection,
    remainingPaths: []
  }), true);

  assert.deepEqual(app.calls.map(call => call.operation), [
    'clipboard.readFiles', 'clipboard.acknowledge'
  ]);
  assert.equal(app.calls[0].session, app.calls[1].session);
  assert.equal(app.helperCalls(), 0);
  assert.equal(app.sessions.length, 1);
});

test('Windows partial move acknowledgement passes the exact remaining subset to the retained native source', async t => {
  const app = nativeHarness({ selection: { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt'], mode: 'move', token: 'native-session:9:1' } });
  t.after(() => app.provider.dispose?.());
  await app.provider.read();
  const selection = { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt'], mode: 'move', token: 'native-session:9:1' };
  const result = await app.provider.ack({ ...selection, remainingPaths: ['C:/tmp/b.txt'] });
  assert.equal(result, true);
  assert.deepEqual(app.calls.at(-1), {
    operation: 'clipboard.acknowledge',
    request: { ...selection, remainingPaths: ['C:/tmp/b.txt'] },
    session: app.calls.at(-1).session
  });
  assert.equal(app.helperCalls(), 0);
});

test('Windows clipboard disposal closes the persistent native session', async () => {
  const app = nativeHarness();
  await app.provider.read();
  await app.provider.dispose();
  assert.equal(app.sessions.length, 1);
  assert.equal(app.sessions[0].closed, true);
});

test('Windows write publishes a native file selection and preserves its requested effect', async t => {
  const app = nativeHarness();
  t.after(() => app.provider.dispose?.());
  const selection = await app.provider.write({ paths: ['C:/tmp/source.txt'], mode: 'copy' });
  assert.deepEqual(selection.paths, ['C:/tmp/source.txt']);
  assert.equal(selection.mode, 'copy');
  assert.deepEqual(app.calls[0].request, { paths: ['C:/tmp/source.txt'], mode: 'copy' });
  assert.equal(app.calls[0].operation, 'clipboard.writeFiles');
  assert.equal(app.helperCalls(), 0);
});

test('Windows import still applies approved-root validation after native OLE read', async () => {
  const app = nativeHarness({ selection: { paths: ['C:/outside/foreign.txt'], mode: 'copy', token: 'native-session:9:3' } });
  await assert.rejects(app.provider.read(), /freigegeben/);
  assert.equal(app.calls[0].operation, 'clipboard.readFiles');
  assert.equal(app.helperCalls(), 0);
});

test('unsupported Windows native capability fails explicitly without starting a helper', async () => {
  const app = nativeHarness({ capabilities: { 'clipboard.readFiles': { status: 'unsupported' } } });
  await assert.rejects(app.provider.read(), { code: 'CLIPBOARD_UNAVAILABLE' });
  assert.equal(app.calls.length, 0);
  assert.equal(app.helperCalls(), 0);
});
