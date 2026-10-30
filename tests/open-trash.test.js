const test = require('node:test');
const assert = require('node:assert/strict');
test('opening trash uses fixed platform-specific arguments without reading trash contents', async () => {
  const { openTrash } = require('../open-trash');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const calls = [];
    const result = await openTrash({ platform, executeFile(command, args, options, callback) { calls.push({ command, args, options }); callback(null); } });
    assert.deepEqual(result, { requested: true }); assert.equal(calls.length, 1);
    const { command, args, options } = calls[0]; assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 10000);
    if (platform === 'win32') { assert.equal(command, 'powershell.exe'); assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']); assert.match(args[3], /Shell\.Application/); assert.match(args[3], /\.Open\(10\)/); assert.doesNotMatch(args[3], /ExecutionPolicy|Registry|Get-ChildItem|Remove-/); }
    if (platform === 'darwin') { assert.equal(command, '/usr/bin/osascript'); assert.deepEqual(args, ['-e', 'tell application "Finder" to open trash', '-e', 'tell application "Finder" to activate']); }
    if (platform === 'linux') { assert.equal(command, '/usr/bin/gio'); assert.deepEqual(args, ['open', 'trash:///']); }
  }
});
test('missing capabilities, launch errors and timeouts are explicit and never use a filesystem fallback', async () => {
  const { openTrash } = require('../open-trash'); let called = false;
  await assert.rejects(openTrash({ platform: 'freebsd', executeFile() { called = true; } }), /nicht verfügbar/); assert.equal(called, false);
  for (const [failure, expected] of [[{ code: 'ENOENT' }, /nicht verfügbar/], [{ code: 'ETIMEDOUT' }, /Zeitlimit/], [{ code: 'EACCES' }, /nicht geöffnet/]]) {
    let calls = 0;
    await assert.rejects(openTrash({ platform: 'linux', executeFile(_command, _args, _options, callback) { calls++; callback(Object.assign(new Error('blocked'), failure)); } }), expected);
    assert.equal(calls, 1);
  }
});
