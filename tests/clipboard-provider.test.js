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

test('Linux file clipboard uses a native session and preserves POSIX path bytes', async () => {
  const selectedPath = '/tmp/Ordner\\name-ß.txt';
  const app = nativeHarness({ selection: { paths: [selectedPath], mode: 'move', token: 'linux:1:4' } }, 'linux');
  const selection = await app.provider.read();
  assert.deepEqual(selection, { paths: [selectedPath], mode: 'move', token: 'linux:1:4', source: 'system' });
  assert.equal(await app.provider.ack({ ...selection, remainingPaths: [] }), true);
  assert.deepEqual(app.calls.map(call => call.operation), ['clipboard.readFiles', 'clipboard.acknowledge']);
  assert.equal(app.calls[0].session, app.calls[1].session);
  assert.deepEqual(app.calls[1].request, { token: 'linux:1:4', paths: [selectedPath], mode: 'move', remainingPaths: [] });
  assert.equal(app.helperCalls(), 0);
  app.provider.dispose();
  assert.equal(app.sessions[0].closed, true);
});

test('Linux file clipboard writes and cancels through the persistent native session', async () => {
  const app = nativeHarness({}, 'linux');
  const selection = await app.provider.write({ paths: ['/tmp/a.txt'], mode: 'copy' });
  assert.deepEqual(app.calls.map(call => call.operation), ['clipboard.writeFiles']);
  assert.equal(await app.provider.reset(selection), true);
  assert.deepEqual(app.calls.map(call => call.operation), ['clipboard.writeFiles', 'clipboard.cancelFiles']);
  assert.equal(app.calls[0].session, app.calls[1].session);
  assert.equal(app.helperCalls(), 0);
  app.provider.dispose();
});

test('Linux clipboard accepts literal backslash traversal-like filename bytes but rejects slash traversal', async () => {
  const app = nativeHarness({}, 'linux');
  await app.provider.write({ paths: ['/tmp/a\\..\\b.txt'], mode: 'copy' });
  assert.deepEqual(app.calls[0].request, { paths: ['/tmp/a\\..\\b.txt'], mode: 'copy' });
  await assert.rejects(app.provider.write({ paths: ['/tmp/a/../b.txt'], mode: 'copy' }), /Ungültiger Zwischenablage-Pfad/);
  app.provider.dispose();
});

test('Linux clipboard reports protocol-specific unsupported capabilities explicitly', async () => {
  const app = nativeHarness({ capabilities: { 'clipboard.readFiles': { status: 'unsupported', reason: 'WaylandDataControlUnavailable' } } }, 'linux');
  await assert.rejects(app.provider.read(), { code: 'CLIPBOARD_UNAVAILABLE' });
  assert.equal(app.calls.length, 0);
  app.provider.dispose();
});

test('Linux clipboard maps unavailable runtime protocols to the status-bar capability error', async () => {
  const failure = Object.assign(new Error('WaylandDataControlUnavailable'), { code: 'UnsupportedOperation' });
  const app = nativeHarness({ failure }, 'linux');
  await assert.rejects(app.provider.read(), error => error.code === 'CLIPBOARD_UNAVAILABLE' && error.cause === failure);
  app.provider.dispose();
});

test('Linux clipboard opens a new session on the next request after connection loss', async () => {
  for (const code of ['X11ConnectionLost', 'ClipboardConnectionLost']) {
    const sessions = [], calls = [];
    const provider = createClipboardProvider({ platform: 'linux', contains: () => true, nativeApiFactory: () => ({
      capabilities: {},
      openSession() {
        const index = sessions.length;
        const session = { closed: false, close() { this.closed = true; }, async invoke() {
          calls.push(index);
          if (index === 0) throw Object.assign(new Error('The desktop connection was lost.'), { code });
          return { paths: ['/tmp/reconnected'], mode: 'copy', token: 'new-connection' };
        } };
        sessions.push(session);
        return session;
      }
    }) });
    try {
      await assert.rejects(provider.read(), { code });
      assert.deepEqual(calls, [0]);
      assert.equal((await provider.read()).token, 'new-connection');
      assert.deepEqual(calls, [0, 1]);
      assert.equal(sessions[0].closed, true);
    } finally { provider.dispose(); }
  }
});

function nativeHarness(options = {}, platform = 'win32') {
  const calls = [], sessions = [];
  const api = {
    capabilities: options.capabilities || {},
    openSession() {
      const session = {
        closed: false,
        invoke(operation, request) {
          calls.push({ operation, request, session });
          if (options.failure) return Promise.reject(options.failure);
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
    platform,
    contains: value => allowed(value) || value.startsWith('/tmp/'),
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
