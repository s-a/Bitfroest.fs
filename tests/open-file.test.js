const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { openAssociatedFile } = require('../open-file');

for (const editor of [false, true]) test(`Windows file activation returns editor=${editor} from the native association`, async () => {
  const calls = [], target = 'C:/tmp/a & $report ü.txt';
  const result = await openAssociatedFile(target, { platform: 'win32', executeFile: async (...args) => {
    calls.push(args); return { stdout: JSON.stringify({ editor }) };
  } });
  assert.deepEqual(result, { editor });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  const args = calls[0][1];
  assert.ok(args.includes(path.join(__dirname, '..', 'native', 'open-file.ps1')));
  assert.equal(Buffer.from(args[args.indexOf('-EncodedPath') + 1], 'base64').toString('utf8'), target);
  assert.equal(calls[0][2].windowsHide, true);
  assert.ok(calls[0][2].timeout > 0);
});

test('invalid paths fail before any native invocation', async () => {
  for (const target of [null, '', 'relative.txt', 'C:/tmp/a\0.txt']) {
    await assert.rejects(openAssociatedFile(target, { platform: 'win32', executeFile: () => assert.fail('Unexpected invocation') }));
  }
});

test('native failures and malformed replies cannot become editor fallbacks', async () => {
  await assert.rejects(openAssociatedFile('C:/tmp/a.txt', { executeFile: async () => { throw new Error('No association'); }, platform: 'win32' }), /No association/);
  for (const stdout of ['', '{}', '{"editor":"false"}', 'invalid']) {
    await assert.rejects(openAssociatedFile('C:/tmp/a.txt', { platform: 'win32', executeFile: async () => ({ stdout }) }));
  }
});

for (const [platform, executable] of [['darwin', 'open'], ['linux', 'xdg-open']]) test(`${platform} delegates activation to the desktop application launcher`, async () => {
  const calls = [];
  assert.deepEqual(await openAssociatedFile('/tmp/a b.txt', { platform, executeFile: async (...args) => { calls.push(args); } }), { editor: false });
  assert.deepEqual(calls[0].slice(0, 2), [executable, ['/tmp/a b.txt']]);
});

test('Windows helper inspects the current file association without launching an application', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-activation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'report ü & $.txt');
  fs.writeFileSync(target, 'unchanged');
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, '..', 'native', 'open-file.ps1'), '-EncodedPath', Buffer.from(target, 'utf8').toString('base64'), '-InspectOnly'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  assert.equal(typeof JSON.parse(stdout).editor, 'boolean');
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});
