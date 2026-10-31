const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');
const { createClipboardProvider } = require('../clipboard-provider');
const { openAssociatedFile } = require('../open-file');
const { createCopySession } = require('../native-copy');
const windows = { skip: process.platform !== 'win32' };

test('Windows copy default uses the packaged native binding and reuses one session', windows, async t => {
  const app = stubPackagedNativeBinding(t, { 'files.copy': () => ({ status: 'committed', copied: true, cancelled: false }) });
  const input = { roots: ['C:/tmp'], source: 'C:/tmp/a.txt', target: 'C:/tmp/b.txt', expected: { dev: '1', ino: '2', size: '10', mtimeNs: '3', ctimeNs: '4' } };
  const session = createCopySession({ platform: 'win32', spawn: () => assert.fail('The Windows default must not start a script.') });
  try {
    assert.deepEqual(await session.copy(input), { copied: true, granular: true });
    await session.copy({ ...input, target: 'C:/tmp/c.txt' });
    assert.deepEqual(app.calls.map(call => call.operation), ['files.copy', 'files.copy']);
    assert.equal(app.sessions.length, 1);
  } finally { await session.dispose(); }
  assert.equal(app.sessions[0].closed, true);
});

test('Windows clipboard default uses the packaged native binding for read write and acknowledgement', windows, async t => {
  const selection = { paths: ['C:/tmp/Größe.txt'], mode: 'move', token: 'owner' };
  const app = stubPackagedNativeBinding(t, {
    'clipboard.readFiles': () => selection,
    'clipboard.writeFiles': request => ({ ...selection, mode: request.mode }),
    'clipboard.acknowledge': () => ({ matched: true })
  });
  const provider = createClipboardProvider({ platform: 'win32', contains: value => value.startsWith('C:/tmp/'),
    runHelper: () => assert.fail('The Windows default must not start a script.') });
  try {
    assert.equal((await provider.read()).token, 'owner');
    assert.equal((await provider.write({ paths: selection.paths, mode: 'copy' })).mode, 'copy');
    assert.equal(await provider.ack({ ...selection, remainingPaths: [] }), true);
    assert.deepEqual(app.calls.map(call => call.operation), ['clipboard.readFiles', 'clipboard.writeFiles', 'clipboard.acknowledge']);
    assert.equal(app.sessions.length, 1);
  } finally { provider.dispose(); }
  assert.equal(app.sessions[0].closed, true);
});

test('Windows application opening default uses the packaged native binding without a process fallback', windows, async t => {
  const app = stubPackagedNativeBinding(t, { 'shell.openAssociated': () => ({ editor: false }) });
  assert.deepEqual(await openAssociatedFile('C:/tmp/file.txt', { platform: 'win32', executeFile: () => assert.fail('The Windows default must not start a script.') }), { editor: false });
  assert.deepEqual(app.calls, [{ operation: 'shell.openAssociated', request: { path: 'C:/tmp/file.txt' } }]);
  assert.equal(app.sessions[0].closed, true);
});
