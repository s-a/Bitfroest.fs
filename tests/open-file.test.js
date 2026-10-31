const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openAssociatedFile } = require('../open-file');

for (const editor of [false, true]) test(`Windows file activation returns editor=${editor} from the native association`, async () => {
  const calls = [], target = 'C:/tmp/a & $report ü.txt';
  let closed = false;
  const result = await openAssociatedFile(target, { platform: 'win32', nativeApi: { openSession: () => ({
    invoke: async (operation, request) => { calls.push({ operation, request }); return { editor }; }, close() { closed = true; }
  }) }, executeFile: () => assert.fail('A Windows file association must not start a helper.') });
  assert.deepEqual(result, { editor });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { operation: 'shell.openAssociated', request: { path: target } });
  assert.equal(closed, true);
});

test('invalid paths fail before any native invocation', async () => {
  for (const target of [null, '', 'relative.txt', 'C:/tmp/a\0.txt']) {
    await assert.rejects(openAssociatedFile(target, { platform: 'win32', executeFile: () => assert.fail('Unexpected invocation') }));
  }
});

test('native failures and malformed replies cannot become editor fallbacks', async () => {
  const apiFor = invoke => ({ openSession: () => ({ invoke, close() {} }) });
  await assert.rejects(openAssociatedFile('C:/tmp/a.txt', { nativeApi: apiFor(async () => { throw new Error('No association'); }), platform: 'win32' }), /No association/);
  for (const response of ['', {}, { editor: 'false' }, 'invalid']) {
    await assert.rejects(openAssociatedFile('C:/tmp/a.txt', { platform: 'win32', nativeApi: apiFor(async () => response) }));
  }
});

test('unsupported macOS activation reports the limitation without starting a program', async () => {
  let calls = 0;
  await assert.rejects(openAssociatedFile('/tmp/a b.txt', { platform: 'darwin', executeFile: async () => { calls++; } }), { code: 'ENOTSUPPORTED' });
  assert.equal(calls, 0);
});

test('Linux file activation uses the packaged native desktop API and closes its session', async t => {
  const { stubPackagedNativeBinding } = require('./support/native-binding.cjs');
  const fixture = stubPackagedNativeBinding(t, { 'shell.openAssociated': () => ({ editor: false, available: true, requested: true }) });
  assert.deepEqual(await openAssociatedFile('/tmp/a b ü & $.txt', { platform: 'linux', executeFile() { assert.fail('External helper launch'); } }), { editor: false });
  assert.deepEqual(fixture.calls, [{ operation: 'shell.openAssociated', request: { path: '/tmp/a b ü & $.txt' } }]);
  assert.equal(fixture.sessions[0].closed, true);
});

test('Windows native module inspects the current file association without launching an application', { skip: process.platform !== 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-activation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'report ü & $.txt');
  fs.writeFileSync(target, 'unchanged');
  const result = await openAssociatedFile(target, { inspectOnly: true });
  assert.equal(typeof result.editor, 'boolean');
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});
test('Windows association lookup uses the native session and closes it', async () => {
  const calls = [], lifecycle = { opened: 0, closed: 0 };
  const nativeApi = { openSession() {
    lifecycle.opened++;
    return {
      async invoke(operation, request) { calls.push({ operation, request }); return { editor: true }; },
      close() { lifecycle.closed++; }
    };
  } };
  const result = await openAssociatedFile('C:\\tmp\\report.txt', {
    platform: 'win32', nativeApi,
    executeFile: () => assert.fail('The native API must be used instead of a helper process.')
  });
  assert.deepEqual(result, { editor: true });
  assert.deepEqual(calls, [{ operation: 'shell.openAssociated', request: { path: 'C:\\tmp\\report.txt' } }]);
  assert.deepEqual(lifecycle, { opened: 1, closed: 1 });
});

test('Windows association inspection is explicit and invalid native replies close the session', async () => {
  let closed = 0;
  const nativeApi = { openSession: () => ({
    async invoke(operation, request) {
      assert.equal(operation, 'shell.openAssociated');
      assert.deepEqual(request, { path: 'C:\\tmp\\report.txt', inspectOnly: true });
      return {};
    },
    close() { closed++; }
  }) };
  await assert.rejects(openAssociatedFile('C:\\tmp\\report.txt', { platform: 'win32', nativeApi, inspectOnly: true }), /Ungültige Antwort/);
  assert.equal(closed, 1);
});
