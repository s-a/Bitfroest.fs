const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { getFilesystemIcons, clearFilesystemIconCache } = require('../filesystem-icons');

test.beforeEach(() => clearFilesystemIconCache());

test('unsupported platforms leave native icons available for theme fallback', async () => {
  let called = false;
  const icons = await getFilesystemIcons([{ key: 'folder', name: 'docs', type: 'folder' }], {
    platform: 'freebsd', testLookup: async () => { called = true; return '[]'; }
  });
  assert.equal(icons.folder, null);
  assert.equal(called, false);
});

test('batches injected icon lookups and reuses icon cache', async () => {
  const calls = [];
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const testLookup = async (command, args, rows) => {
    calls.push({ command, args, rows });
    return JSON.stringify(rows.map(row => ({ key: row.key, icon })));
  };
  const requests = Array.from({ length: 30 }, (_, index) => ({ key: `file-${index}`, name: `sample-${index}.ps1` }));
  const first = await getFilesystemIcons(requests, { platform: 'win32', testLookup });
  const second = await getFilesystemIcons(requests, { platform: 'win32', testLookup });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].rows.length, 24);
  assert.equal(calls[1].rows.length, 6);
  assert.equal(calls[0].command, null);
  assert.deepEqual(calls[0].args, []);
  assert.equal(first['file-0'], icon);
  assert.equal(second['file-0'], icon);
});

test('Windows uses the native API in bounded batches and returns only valid PNG buffers', async () => {
  const calls = [], lifecycle = { opened: 0, closed: 0 };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const nativeApi = { openSession() {
    lifecycle.opened++;
    return {
      async invoke(operation, request) {
        calls.push({ operation, request });
        return { icons: [...request.requests].reverse().map(item => ({ key: item.key, png: item.key === 'missing' ? null : item.key === 'invalid' ? Buffer.from('bad') : png })) };
      },
      close() { lifecycle.closed++; }
    };
  } };
  const requests = Array.from({ length: 25 }, (_, index) => ({ key: `native-${index}`, path: `C:\\icons\\${index}.txt`, name: `${index}.txt`, type: 'file' }));
  requests[0].key = 'missing'; requests[1].key = 'invalid';
  const result = await getFilesystemIcons(requests, { platform: 'win32', nativeApi, testLookup: () => assert.fail('Windows must use the native API') });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.request.requests.length), [24, 1]);
  assert.ok(calls.every(call => call.operation === 'icons.resolve'));
  assert.deepEqual(lifecycle, { opened: 2, closed: 2 });
  assert.equal(result['native-2'], `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.missing, null);
  assert.equal(result.invalid, null);
});

test('Windows native icon failures close each batch session and cache null results briefly', async context => {
  let clock = 1000, opened = 0, closed = 0, calls = 0;
  context.mock.method(Date, 'now', () => clock);
  const nativeApi = { openSession() {
    opened++;
    return { invoke: async () => { calls++; throw new Error('broker unavailable'); }, close() { closed++; } };
  } };
  const request = [{ key: 'native-failure', name: 'missing.txt' }];
  const options = { platform: 'win32', nativeApi, testLookup: () => assert.fail('Windows must use the native API') };
  assert.equal((await getFilesystemIcons(request, options))['native-failure'], null);
  await getFilesystemIcons(request, options);
  assert.deepEqual({ opened, closed, calls }, { opened: 1, closed: 1, calls: 1 });
  clock += 5001;
  await getFilesystemIcons(request, options);
  assert.deepEqual({ opened, closed, calls }, { opened: 2, closed: 2, calls: 2 });
});

test('rejects oversized or non-PNG responses and tolerates helper failure', async () => {
  const invalid = await getFilesystemIcons([{ key: 'bad', name: 'a.txt' }], {
    platform: 'win32', testLookup: async () => JSON.stringify([{ key: 'bad', icon: 'data:image/svg+xml;base64,PHN2Zz4=' }])
  });
  assert.equal(invalid.bad, null);
  const failed = await getFilesystemIcons([{ key: 'failed', name: 'b.txt' }], {
    platform: 'win32', testLookup: async () => { throw new Error('unavailable'); }
  });
  assert.equal(failed.failed, null);
});

test('Windows helper returns shell icons for existing paths and extension associations', { skip: process.platform !== 'win32' }, async () => {
  const icons = await getFilesystemIcons([
    { key: 'native-script', name: 'sample.ps1', type: 'file' },
    { key: 'native-exe', path: path.join(process.env.SystemRoot, 'System32', 'notepad.exe'), name: 'notepad.exe', type: 'file' },
    { key: 'native-folder', path: process.env.SystemRoot, name: 'Windows', type: 'folder' }
  ]);
  for (const icon of Object.values(icons)) assert.match(icon, /^data:image\/png;base64,/);
});

function memoryLinux(entries) {
  return {
    home: '/home/example', env: { XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data', XDG_DATA_DIRS: '/system' },
    fs: {
      async lstat(filePath) {
        const item = entries[filePath];
        if (!item) throw new Error('missing');
        return { isFile: () => true, isSymbolicLink: () => Boolean(item.link), size: item.size ?? item.bytes.length };
      },
      async readFile(filePath) { return entries[filePath].bytes; }
    }
  };
}

test('Linux reads a custom folder icon from bounded directory metadata', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const linux = memoryLinux({
    '/pictures/.directory': { bytes: Buffer.from('[Desktop Entry]\nIcon=/custom/photo.png\n') },
    '/custom/photo.png': { bytes: png }
  });
  const icons = await getFilesystemIcons([{ key: 'photo', path: '/pictures', name: 'pictures', type: 'folder' }], { platform: 'linux', linux });
  assert.equal(icons.photo, `data:image/png;base64,${png.toString('base64')}`);
});

test('Linux resolves configured theme icons and shares generic lookup cache', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const linux = memoryLinux({
    '/config/gtk-3.0/settings.ini': { bytes: Buffer.from('[Settings]\ngtk-icon-theme-name=TestTheme\n') },
    '/data/icons/TestTheme/16x16/mimetypes/text-markdown.png': { bytes: png }
  });
  let reads = 0;
  const read = linux.fs.readFile;
  linux.fs.readFile = async filePath => { reads++; return read(filePath); };
  const first = await getFilesystemIcons([{ key: 'first', name: 'one.md' }], { platform: 'linux', linux });
  const before = reads;
  const second = await getFilesystemIcons([{ key: 'second', name: 'two.md' }], { platform: 'linux', linux });
  assert.equal(first.first, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(second.second, first.first);
  assert.equal(reads, before);
});

test('Linux rejects linked or oversized files and locates pixmaps fallback', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const linux = memoryLinux({
    '/pictures/.directory': { bytes: Buffer.from('[Other]\nIcon=wrong\n[Desktop Entry]\nIcon=../../wrong\n') },
    '/home/example/.icons/hicolor/16x16/places/folder.png': { bytes: png, link: true },
    '/data/icons/hicolor/16x16/places/folder.png': { bytes: png, size: 999999 },
    '/system/icons/Adwaita/48x48/apps/folder.png': { bytes: Buffer.from('not a PNG') },
    '/usr/share/pixmaps/folder.png': { bytes: png }
  });
  const result = await getFilesystemIcons([{ key: 'folder', path: '/pictures', name: 'folder', type: 'folder' }], { platform: 'linux', linux });
  assert.equal(result.folder, 'data:image/png;base64,iVBORw0KGgo=');
});

test('Linux handles missing icon files, default paths and unsupported metadata', async () => {
  const linux = memoryLinux({ '/docs/.directory': { bytes: Buffer.from('[Desktop Entry]\nIcon=custom-icon\n') } });
  linux.env = {};
  const first = await getFilesystemIcons([{ key: 'folder', path: '/docs', type: 'folder' }, { key: 'plain', name: 'README' }], { platform: 'linux', linux });
  assert.equal(first.folder, null); assert.equal(first.plain, null);
  const second = await getFilesystemIcons([{ key: 'same', name: 'README' }], { platform: 'linux', linux });
  assert.equal(second.same, null);
});

test('normalization bounds requests and removes unsupported payload fields', async () => {
  let payload;
  const options = { platform: 'win32', testLookup: async (_, __, rows) => { payload = rows; return '[]'; } };
  const empty = await getFilesystemIcons(null, options);
  assert.deepEqual(Object.keys(empty), []);
  await getFilesystemIcons([null, { key: 42 }, { key: 'x'.repeat(301) }, { key: 'ok', path: 'x\0bad', name: 'folder/one.ps1', iconResource: 'x\0bad', type: 'other' }], options);
  assert.deepEqual(payload, [{ key: 'ok', path: '', name: 'one.ps1', type: 'file', iconResource: '' }]);
  const many = await getFilesystemIcons(Array.from({ length: 140 }, (_, index) => ({ key: `limit-${index}`, name: null, path: false })), options);
  assert.equal(Object.keys(many).length, 128);
});

test('native response bounds reject malformed JSON, shapes and huge data', async () => {
  for (const [index, output] of ['invalid JSON', '{}', JSON.stringify([{ key: 'huge', icon: 'data:image/png;base64,' + 'A'.repeat(131073) }])].entries()) {
    const result = await getFilesystemIcons([{ key: index === 2 ? 'huge' : String(index), name: `invalid-${index}.txt` }], { platform: 'win32', testLookup: async () => output });
    assert.equal(Object.values(result)[0], null);
  }
});

test('injected lookup cache expires and clears without retaining a stale icon', async context => {
  let clock = 1000, calls = 0;
  context.mock.method(Date, 'now', () => clock);
  const options = { platform: 'win32', testLookup: async (_, args, rows) => {
    assert.deepEqual(args, []); calls++;
    return JSON.stringify(rows.map(row => ({ key: row.key, icon: 'data:image/png;base64,iVBORw0KGgo=' })));
  } };
  const requests = [{ key: 'clock', name: 'clock.txt' }];
  await getFilesystemIcons(requests, options);
  await getFilesystemIcons(requests, options);
  assert.equal(calls, 1);
  clock += 60001;
  await getFilesystemIcons(requests, options);
  assert.equal(calls, 2);
  clearFilesystemIconCache();
  await getFilesystemIcons(requests, options);
  assert.equal(calls, 3);
});

test('Windows extracts Desktop.ini resource icons without changing folder attributes', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-icons-'));
  const resourcePath = path.join(process.env.SystemRoot, 'System32', 'shell32.dll');
  try {
    const before = await fs.stat(root);
    await fs.writeFile(path.join(root, 'desktop.ini'), `\uFEFF[.ShellClassInfo]\nIconResource=${resourcePath},3\n`, 'utf16le');
    const result = await getFilesystemIcons([
      { key: 'custom', path: root, name: 'custom', type: 'folder' },
      { key: 'resource', name: 'shell32.dll', iconResource: `${resourcePath},3` }
    ]);
    assert.match(result.custom, /^data:image\/png;base64,/);
    assert.equal(result.custom, result.resource);
    assert.equal((await fs.stat(root)).mode, before.mode);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows does not follow parent junctions for folder icon metadata', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-icons-junction-'));
  try {
    const target = path.join(root, 'target');
    await fs.mkdir(path.join(target, 'child'), { recursive: true });
    await fs.writeFile(path.join(target, 'child', 'desktop.ini'), `[.ShellClassInfo]\nIconResource=${path.join(process.env.SystemRoot, 'System32', 'shell32.dll')},10\n`);
    await fs.symlink(target, path.join(root, 'alias'), 'junction');
    const result = await getFilesystemIcons([
      { key: 'junction', path: path.join(root, 'alias', 'child'), name: 'child', type: 'folder' },
      { key: 'generic', name: 'child', type: 'folder' }
    ]);
    assert.match(result.generic, /^data:image\/png;base64,/);
    assert.equal(result.junction, result.generic);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bounded native cache evicts old entries and retries after transient failure', async context => {
  let clock = 1000, calls = 0;
  context.mock.method(Date, 'now', () => clock);
  const options = { platform: 'win32', testLookup: async (_, __, rows) => {
    calls++;
    return JSON.stringify(rows.map(row => ({ key: row.key, icon: null })));
  } };
  for (let offset = 0; offset < 513; offset += 128) {
    await getFilesystemIcons(Array.from({ length: Math.min(128, 513 - offset) }, (_, index) => ({ key: String(offset + index), name: `cache-${offset + index}.txt` })), options);
  }
  const before = calls;
  await getFilesystemIcons([{ key: '0', name: 'cache-0.txt' }], options);
  assert.equal(calls, before + 1);
  clock += 10001;
  await getFilesystemIcons([{ key: '0', name: 'cache-0.txt' }], options);
  assert.equal(calls, before + 2);
});

test('unavailable injected lookup falls back without rejecting the caller', async () => {
  const result = await getFilesystemIcons([{ key: 'missing-runner', name: 'anything.txt' }], { platform: 'win32', testLookup: async () => { throw new Error('unavailable'); } });
  assert.equal(result['missing-runner'], null);
});
test('macOS uses the native theme fallback without starting an icon helper', async () => {
  let started = false;
  const icons = await getFilesystemIcons([{ key: 'finder', name: 'folder', type: 'folder' }], {
    platform: 'darwin',
    testLookup: async () => { started = true; throw new Error('must not start'); }
  });
  assert.equal(icons.finder, null);
  assert.equal(started, false);
});
