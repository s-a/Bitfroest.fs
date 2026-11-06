const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUncPaths } = require('../network-paths');
const { prepareNetworkDeletion } = require('../network-paths');
const fs = require('node:fs');
const path = require('node:path');
const { inspectRuntimeSource } = require('./support/runtime-architecture.cjs');

test('network deletion confirms only mapped and UNC targets before permitting permanent deletion', async () => {
  const paths = ['Z:/team/a', 'C:/local/b', '//server/share/c'];
  const network = [paths[0], paths[2]];
  const result = await prepareNetworkDeletion(paths, true, {
    platform: 'win32', resolvePaths: async () => ['\\\\server\\share\\team\\a', paths[1], paths[2]],
    confirm: async targets => { assert.deepEqual(targets, network); return true; }
  });
  assert.deepEqual(result, network);
});

test('unchanged explicitly confirmed network paths need no duplicate warning but changed mappings do', async () => {
  let confirmations = 0;
  const paths = ['Z:/a', 'C:/local'];
  const options = { platform: 'win32', resolvePaths: async () => ['//server/share/a', 'C:/local'], confirmedPaths: ['Z:/a'], confirm: async () => { confirmations++; return false; } };
  assert.deepEqual(await prepareNetworkDeletion(paths, true, options), ['Z:/a']);
  assert.equal(confirmations, 0);
  await assert.rejects(prepareNetworkDeletion(paths, true, { ...options, confirmedPaths: ['C:/local'] }), { name: 'AbortError' });
  assert.equal(confirmations, 1);
});

test('declined network deletion aborts and local or explicitly permanent deletion needs no extra confirmation', async () => {
  await assert.rejects(prepareNetworkDeletion(['\\\\server\\share\\a'], true, {
    platform: 'win32', confirm: async () => false
  }), { name: 'AbortError' });
  for (const [paths, useTrash, platform] of [[['C:/local/a'], true, 'win32'], [['Z:/a'], false, 'win32'], [['/mnt/share/a'], true, 'linux']]) {
    assert.deepEqual(await prepareNetworkDeletion(paths, useTrash, {
      platform, resolvePaths: async values => values, confirm: () => assert.fail('Unexpected confirmation')
    }), []);
  }
});

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
test('recent UNC targets are distinct share roots ordered by last visit and limited to ten', () => {
  const { recentUncRoots } = require('../network-paths');
  const previous = ['//server/first/nested', ...Array.from({ length: 10 }, (_, i) => `//server/share${i}`)];
  const actual = recentUncRoots(['\\\\SERVER\\First\\new', 'C:/local', '//?/UNC/other/share/sub', '//./device', '//incomplete', ...previous]);
  assert.deepEqual(actual, ['//SERVER/First', '//other/share', ...previous.slice(1, 9)]);
});

test('recent UNC roots reject all C0 control characters in servers and shares', () => {
  const { recentUncRoots } = require('../network-paths');
  const invalid = Array.from({ length: 32 }, (_, code) => {
    const character = String.fromCharCode(code);
    return [`//server${character}/share`, `//server/share${character}`];
  }).flat();
  assert.deepEqual(recentUncRoots([...invalid, '//server/share name']), ['//server/share name']);
});
