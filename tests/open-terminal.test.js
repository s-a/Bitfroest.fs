const test = require('node:test');
const assert = require('node:assert/strict');
const { openTerminal } = require('../open-terminal');
const path = require('node:path');

test('Windows opens a PowerShell tab in window zero with a literal starting directory', async () => {
  for (const directory of ['C:/', 'C:/folder with spaces', 'C:/a;&%name', '//server/share/folder']) {
    let call, closed = 0;
    const nativeApi = { openSession: () => ({ invoke: async (...args) => { call = args; return { requested: true }; }, close: () => closed++ }) };
    await openTerminal(directory, { platform: 'win32', nativeApi });
    assert.deepEqual(call, ['shell.openTerminal', { path: path.win32.normalize(directory) }]);
    assert.equal(closed, 1);
  }
});

test('launcher errors propagate without starting a fallback shell', async () => {
  const error = Object.assign(new Error('missing terminal'), { code: 'ENOENT' });
  let closed = 0;
  await assert.rejects(openTerminal('C:/folder', { platform: 'win32', nativeApi: { openSession: () => ({ invoke: async () => { throw error; }, close: () => closed++ }) } }), error);
  assert.equal(closed, 1);
});

test('Linux opens the integrated terminal in the requested directory', async () => {
  let options, shown = 0;
  await openTerminal('/home/test', { platform: 'linux', window: { createTerminal: value => { options = value; return { show: () => shown++ }; } } });
  assert.deepEqual(options, { cwd: '/home/test' });
  assert.equal(shown, 1);
});

test('invalid native responses and timeouts release the session', async () => {
  for (const timeout of [false, true]) {
    let closed = 0;
    const nativeApi = { openSession: () => ({ invoke: () => timeout ? new Promise(() => {}) : Promise.resolve({ requested: false }), close: () => closed++ }) };
    await assert.rejects(openTerminal('C:/folder', { platform: 'win32', nativeApi, timeout: 5 }), timeout ? { code: 'DesktopTimeout' } : /Antwort/);
    assert.equal(closed, 1);
  }
});

test('invalid paths and unsupported platforms never launch a process', async () => {
  for (const directory of ['', 'relative', 'C:/bad\0path', 'zip:C:/file.zip!/']) {
    await assert.rejects(openTerminal(directory, { platform: 'win32', nativeApi: { openSession: () => assert.fail('unexpected launch') } }));
  }
  await assert.rejects(openTerminal('/tmp', { platform: 'darwin' }), { code: 'ENOTSUPPORTED' });
});
