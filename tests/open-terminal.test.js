const test = require('node:test');
const assert = require('node:assert/strict');
const { openTerminal, readDefaultProfile } = require('../open-terminal');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

test('Windows requests a default-profile tab with a literal starting directory', async () => {
  for (const directory of ['C:/', 'C:/folder with spaces', 'C:/a;&%name', '//server/share/folder']) {
    let call, closed = 0;
    const nativeApi = { openSession: () => ({ invoke: async (...args) => { call = args; return { requested: true }; }, close: () => closed++ }) };
    await openTerminal(directory, { platform: 'win32', nativeApi });
    assert.deepEqual(call, ['shell.openTerminal', { path: path.win32.normalize(directory) }]);
    assert.equal(closed, 1);
  }
});

test('Windows encodes script paths and argument values as data before calling the native launcher', async () => {
  const script = { path: "C:\\test ' ;$().ps1", args: [{ name: 'Mode', value: 'one;$()' }, { name: 'Force', value: true }, 'a b'] };
  const profile = '{b25fca10-7ce1-4a9f-8900-ae56fafafafa}';
  const nativeApi = { openSession: () => ({
    invoke: async (operation, request) => {
      assert.equal(operation, 'shell.openTerminal');
      assert.equal(request.profile, profile);
      const command = Buffer.from(request.encodedCommand, 'base64').toString('utf16le');
      for (const value of [script.path, 'one;$()', 'a b']) {
        assert.ok(command.includes(Buffer.from(value, 'utf16le').toString('base64')));
        assert.ok(!command.includes(value));
      }
      assert.match(command, /'Force'=\$true/);
      return { requested: true };
    }, close() {},
  }) };
  await openTerminal('C:/test', { platform: 'win32', nativeApi, script, readDefaultProfile: async () => profile });
});

test('Windows reads the top-level configured default profile and rejects ambiguous installations', async t => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-profiles-'));
  t.after(() => fs.rm(local, { recursive: true, force: true }));
  const profile = '{b25fca10-7ce1-4a9f-8900-ae56fafafafa}';
  const other = '{b25fca10-7ce1-4a9f-8900-ae56fafafafb}';
  const stable = path.join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState');
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'settings.json'),
    '{ // comment\n "profiles": {"defaultProfile":"' + other + '",}, "defaultProfile":"' + profile + '",\n}');
  assert.equal(await readDefaultProfile(local), profile);
  const unpackaged = path.join(local, 'Microsoft', 'Windows Terminal');
  await fs.mkdir(unpackaged, { recursive: true });
  await fs.writeFile(path.join(unpackaged, 'settings.json'), JSON.stringify({ defaultProfile: other }));
  await assert.rejects(readDefaultProfile(local), /nicht eindeutig/);
});

test('POSIX waits for the new terminal and passes each argument as a literal word', async () => {
  let ready, closed, command;
  let disposed = 0;
  const terminal = { state: { shell: 'zsh' }, show() {} };
  const run = openTerminal('/tmp', { platform: 'darwin', window: {
    createTerminal: () => terminal,
    onDidChangeTerminalShellIntegration(listener) { ready = listener; return { dispose() { disposed++; } }; },
    onDidCloseTerminal(listener) { closed = listener; return { dispose() { disposed++; } }; },
  }, script: { path: '/tmp/backup plan.sh', args: ["a'b", '$(date); x', ''] } });
  ready({ terminal: {} });
  closed({});
  assert.equal(command, undefined);
  terminal.shellIntegration = { executeCommand: line => { command = line; } };
  ready({ terminal });
  await run;
  assert.equal(command, "'/tmp/backup plan.sh' 'a'\\''b' '$(date); x' ''");
  assert.equal(disposed, 2);
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
  await assert.rejects(openTerminal('/tmp', { platform: 'freebsd' }), { code: 'ENOTSUPPORTED' });
});

test('macOS opens the integrated terminal with the default profile and requested directory', async () => {
  let shown = false;
  await openTerminal('/tmp', { platform: 'darwin', window: {
    createTerminal(options) {
      assert.deepEqual(options, { cwd: '/tmp' });
      return { show() { shown = true; } };
    },
  } });
  assert.equal(shown, true);
});
