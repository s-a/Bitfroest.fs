const test = require('node:test');
const assert = require('node:assert/strict');
const { createPosixFolderLocks } = require('../folder-locks-posix');
const { createFolderLocks } = require('../folder-locks');

const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
function linuxFs() {
  const stat = '51 (name with ) spaces) S ' + Array.from({ length: 19 }, (_, i) => i === 18 ? '987654321012345' : '0').join(' ');
  const files = { '/proc/51/stat': stat, '/proc/51/comm': 'fixture\n', '/proc/51/cmdline': 'fixture\0--arg\0', '/proc/51/maps': '10-20 r-xp 0 01:01 3 /safe/lib test.so\n20-30 r-xp 0 01:01 3 /safe/lib test.so\n30-40 r-xp 0 01:01 4 /safe/literal\\040.so\n', '/proc/sys/kernel/random/boot_id': 'boot-id\n' };
  const links = { '/proc/51/exe': '/bin/fixture', '/proc/51/cwd': '/safe/sub', '/proc/51/fd/4': '/safe/sub/a.txt', '/proc/51/fd/5': '/safe-other/not-ours', '/proc/51/fd/6': '/SAFE/not-ours' };
  return {
    access: async () => { throw missing(); },
    readdir: async value => { if (value === '/proc') return ['51', '52', 'self']; if (value === '/proc/51/fd') return ['4', '5', '6']; throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    readFile: async value => { if (!(value in files)) throw value.startsWith('/proc/52') ? Object.assign(new Error('denied'), { code: 'EACCES' }) : missing(); return files[value]; },
    readlink: async value => { if (!(value in links)) throw missing(); return links[value]; }
  };
}

test('Linux reads only process references, preserves precise identity and enforces case-sensitive directory boundaries', async t => {
  const provider = createPosixFolderLocks({ platform: 'linux', fs: linuxFs() }); t.after(() => provider.dispose());
  const result = await provider.request({ action: 'scan', path: '/safe' });
  assert.deepEqual(result.rows.map(row => row.file).sort(), ['/safe/lib test.so', '/safe/literal\\040.so', '/safe/sub', '/safe/sub/a.txt']);
  assert.ok(result.rows.every(row => row.started === 'linux:boot-id:987654321012345'));
  assert.equal(result.inaccessible, 1); assert.equal(result.referencesOnly, true);
});

test('missing native capabilities disable unsafe actions explicitly while Linux inspection remains available', async t => {
  const provider = createPosixFolderLocks({ platform: 'linux', fs: linuxFs(), nativeApi: { capabilities: {} } }); t.after(() => provider.dispose());
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.actions.unlock.available, false); assert.equal(capabilities.actions.schedule.available, false);
  assert.equal(capabilities.actions.terminate.available, false); assert.equal(capabilities.actions.terminate.reason, 'native-api-unavailable');
  assert.equal(capabilities.actions.copy.available, true);
  await assert.rejects(provider.request({ action: 'unlock', path: '/safe', rows: [] }), /nicht verfügbar/);
});

test('macOS folder locks are unsupported without filesystem probes or process calls', async t => {
  let filesystemCalls = 0, processCalls = 0;
  const adapter = createPosixFolderLocks({ platform: 'darwin', fs: {
    access: async () => { filesystemCalls++; throw missing(); },
    realpath: async () => { filesystemCalls++; throw missing(); },
    open: async () => { filesystemCalls++; throw missing(); }
  }, execute: async () => { processCalls++; throw new Error('Process execution is forbidden.'); } });
  const provider = createFolderLocks({ platform: 'darwin', posixAdapter: adapter });
  t.after(() => provider.dispose());
  const adapterCapabilities = await adapter.capabilities();
  assert.ok(Object.values(adapterCapabilities.actions).every(action => action.available === false));
  await assert.rejects(adapter.request({ action: 'scan', path: '/safe' }), /nicht verfügbar/i);
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.platform, 'darwin');
  assert.ok(Object.values(capabilities.actions).every(action => action.available === false));
  await assert.rejects(provider.scan('/safe'), /nicht verfügbar/i);
  assert.equal(filesystemCalls, 0);
  assert.equal(processCalls, 0);
});
