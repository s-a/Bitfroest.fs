const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUncPaths } = require('../network-paths');
const fs = require('node:fs');
const path = require('node:path');
const { inspectRuntimeSource } = require('./support/runtime-architecture.cjs');

test('replaced network interpreter adapter is absent', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../native/network-paths.ps1')), false);
});

test('default network resolution uses the packaged native binding without an interpreter', async () => {
  assert.deepEqual(inspectRuntimeSource(fs.readFileSync(require.resolve('../network-paths'), 'utf8'), 'network-paths.js'), []);
  const original = path.join(path.parse(__filename).root, 'network-probe.txt');
  assert.deepEqual(await resolveUncPaths([original]), [original]);
});

test('Windows resolves confirmed drive mappings once per clipboard batch and preserves existing UNC text', async () => {
  const calls = [];
  const originals = ['Z:\\Team\\a.txt', 'z:/Team/b.txt', 'C:\\local.txt', '\\\\server\\share\\already.txt', '\\\\?\\UNC\\server\\share\\long.txt'];
  const result = await resolveUncPaths(originals, { platform: 'win32', runHelper: async input => {
    calls.push(input); return { mappings: { 'Z:': '\\\\files\\shared', 'C:': null } };
  } });
  assert.deepEqual(result, ['\\\\files\\shared\\Team\\a.txt', '\\\\files\\shared\\Team\\b.txt', ...originals.slice(2)]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].drives, ['Z:', 'C:']);
});
test('macOS and Linux preserve native and UNC paths without starting a Windows process', async () => {
  for (const platform of ['darwin', 'linux']) {
    const originals = ['/Volumes/team/a.txt', '/mnt/share/b.txt', 'Z:\\file.txt', '\\\\files\\share\\c.txt'];
    assert.deepEqual(await resolveUncPaths(originals, { platform, runHelper: () => assert.fail('Windows helper must not run') }), originals);
  }
});
test('native failures and unconfirmed or unsafe mappings preserve the original paths', async () => {
  const originals = ['Z:\\a.txt'];
  for (const runHelper of [async () => { throw new Error('timeout'); }, async () => 'not json', async () => ({ mappings: {} }), async () => ({ mappings: { 'Z:': 'relative' } }), async () => ({ mappings: { 'Z:': '\\\\server' } }), async () => ({ mappings: { 'Z:': '\\\\server\\share\r\nwrong' } })]) {
    assert.deepEqual(await resolveUncPaths(originals, { platform: 'win32', runHelper }), originals);
  }
});
test('mapped drive roots can point into a subdirectory of a share', async () => {
  const result = await resolveUncPaths(['Z:\\a.txt'], { platform: 'win32', runHelper: async () => ({ mappings: { 'Z:': '\\\\files\\share\\team\\' } }) });
  assert.deepEqual(result, ['\\\\files\\share\\team\\a.txt']);
});
test('device paths and traversing native responses are not treated as confirmed UNC mappings', async () => {
  const originals = ['Z:\\a.txt'];
  for (const value of ['\\\\?\\C:', '\\\\.\\device', '\\\\files\\share\\..\\other']) {
    assert.deepEqual(await resolveUncPaths(originals, { platform: 'win32', runHelper: async () => ({ mappings: { 'Z:': value } }) }), originals);
  }
});
test('a batch containing only UNC, relative or non-drive paths needs no native lookup', async () => {
  const originals = ['\\\\server\\share\\a', '/tmp/file', 'relative', 'Z:file'];
  assert.deepEqual(await resolveUncPaths(originals, { platform: 'win32', runHelper: () => assert.fail('No drive lookup needed') }), originals);
});

test('an explicitly supplied native API resolves the whole batch once and closes its session', async () => {
  const originals = ['Z:\\Team\\a.txt', 'z:/Team/b.txt', 'C:\\local.txt'];
  const calls = [];
  let closed = 0;
  const nativeApi = { openSession() { return {
    async invoke(operation, request) {
      calls.push([operation, request]);
      return { mappings: { 'Z:': '\\\\files\\shared', 'C:': null } };
    },
    close() { closed++; }
  }; } };
  const result = await resolveUncPaths(originals, { platform: 'win32', nativeApi });
  assert.deepEqual(result, ['\\\\files\\shared\\Team\\a.txt', '\\\\files\\shared\\Team\\b.txt', originals[2]]);
  assert.deepEqual(calls, [['paths.resolveNetwork', { drives: ['Z:', 'C:'] }]]);
  assert.equal(closed, 1);
});

test('an explicitly supplied native API failure preserves paths and closes its session', async () => {
  const originals = ['Z:\\a.txt'];
  let closed = 0;
  const nativeApi = { openSession() { return {
    invoke: async () => { throw new Error('broker unavailable'); },
    close() { closed++; }
  }; } };
  assert.deepEqual(await resolveUncPaths(originals, { platform: 'win32', nativeApi }), originals);
  assert.equal(closed, 1);
});
