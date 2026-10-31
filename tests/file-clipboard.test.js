const test = require('node:test');
const assert = require('node:assert/strict');
const { createClipboardProvider } = require('../clipboard-provider');

const contains = value => /^C:\/(tmp|temp)\//i.test(value);
function harness(platform = 'win32', response = { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'native-17' }) {
  const calls = [];
  const provider = createClipboardProvider({ platform, contains,
    runHelper: async (command, args, payload) => { calls.push({ command, args, payload }); return JSON.stringify(response); },
    nativeApiFactory: () => ({
      capabilities: Object.fromEntries(['clipboard.readFiles', 'clipboard.writeFiles', 'clipboard.acknowledge'].map(operation => [operation, { status: 'supported' }])),
      openSession() { return {
        invoke(operation, request) { calls.push({ operation, request }); return Promise.resolve(response); },
        close() { calls.push({ operation: 'close' }); }
      }; }
    })
  });
  return { provider, calls };
}
test('Windows exports file paths and preferred copy/cut effect through the native API', async () => {
  const app = harness();
  const result = await app.provider.write({ paths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(result.mode, 'move');
  assert.deepEqual(result.paths, ['C:/tmp/a.txt']);
  assert.equal(app.calls[0].operation, 'clipboard.writeFiles');
  assert.deepEqual(app.calls[0].request, { paths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(app.calls.some(call => call.command), false);
});
test('native read distinguishes file clipboard from absent/unknown data', async () => {
  const app = harness();
  assert.equal((await app.provider.read()).token, 'native-17');
  assert.equal(app.calls[0].operation, 'clipboard.readFiles');
  assert.equal(await harness('win32', { paths: [], mode: 'copy', token: 'empty' }).provider.read(), null);
});
test('unauthorized, relative, traversal, invalid mode and oversized path requests never reach native helper', async () => {
  for (const payload of [
    { paths: ['C:/outside/a'], mode: 'copy' }, { paths: ['relative'], mode: 'copy' },
    { paths: ['C:/tmp/../outside/a'], mode: 'copy' }, { paths: ['C:/tmp/a'], mode: 'link' },
    { paths: ['C:/tmp/a\0b'], mode: 'copy' }, { paths: Array(1025).fill('C:/tmp/a'), mode: 'copy' }
  ]) {
    const app = harness();
    await assert.rejects(app.provider.write(payload));
    assert.equal(app.calls.length, 0);
  }
});
test('read rejects external paths instead of pretending to support unrestricted imports', async () => {
  await assert.rejects(harness('win32', { paths: ['C:/outside/a'], mode: 'move', token: 'x' }).provider.read(), /freigegeben/);
});
test('cut acknowledgement carries token and remaining paths without running a file deletion', async () => {
  const app = harness('win32', { matched: true });
  assert.equal(await app.provider.ack({ token: 'native-17', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] }), true);
  assert.equal(app.calls[0].operation, 'clipboard.acknowledge');
  assert.deepEqual(app.calls[0].request, { token: 'native-17', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] });
  assert.equal(await harness('win32', { matched: false }).provider.ack({ token: 'old', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] }), false);
});
test('unknown platform fails explicitly without file-name-as-text fallback', async () => {
  const app = harness('freebsd');
  await assert.rejects(app.provider.write({ paths: ['C:/tmp/a'], mode: 'copy' }), /Datei-Zwischenablage/);
  assert.equal(app.calls.length, 0);
});

test('malformed native responses and foreign remainder fail explicitly', async () => {
  for (const response of ['{bad', 'null', '{}', '{"error":"native error"}', '{"paths":["C:/tmp/a"],"mode":"copy","token":""}']) {
    const provider = createClipboardProvider({ platform: 'win32', contains, nativeApiFactory: () => ({
      capabilities: { 'clipboard.readFiles': { status: 'supported' } },
      openSession: () => ({ invoke: async () => typeof response === 'string' ? JSON.parse(response) : response, close() {} })
    }) });
    await assert.rejects(provider.read());
  }
  const app = harness();
  await assert.rejects(app.provider.ack({ token: '', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] }));
  await assert.rejects(app.provider.ack({ token: 'x', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: ['C:/tmp/b'] }));
});
