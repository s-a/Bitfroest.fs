const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');

async function x11Fixture(t, script) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clipboard-x11-api-'));
  const displayNumber = crypto.randomInt(1000, 20000);
  const authority = path.join(directory, 'authority');
  const field = value => { const size = Buffer.alloc(2); size.writeUInt16BE(value.length); return Buffer.concat([size, value]); };
  const family = Buffer.alloc(2); family.writeUInt16BE(65535);
  await fs.writeFile(authority, Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(displayNumber))),
    field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(crypto.randomBytes(16))]), { mode: 0o600 });
  const server = spawn('Xvfb', [`:${displayNumber}`, '-displayfd', '3', '-screen', '0', '640x480x24',
    '-nolisten', 'unix', '-nolisten', 'local', '-listen', 'tcp', '-auth', authority], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe']
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk.toString(); });
  t.after(async () => {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const display = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The private X11 server did not start: ${errors}`)), 5000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`The private X11 server exited with ${code}: ${errors}`)); });
    server.stdio[3].once('data', data => { clearTimeout(timer); resolve(`localhost:${data.toString().trim()}`); });
  });
  const binary = process.env.NATIVE_BINDING_TEST_PATH || path.resolve(__dirname, '../native/binding.node');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { createNativeApi } = require(process.env.TEST_CLIPBOARD_API);
    const api = createNativeApi(require(process.env.NATIVE_BINDING_TEST_PATH));
    (async () => {
      const root = process.env.TEST_CLIPBOARD_ROOT;
      try { ${script} }
      finally { await api.shutdownAsync(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DISPLAY: display, XAUTHORITY: authority, WAYLAND_DISPLAY: '', WAYLAND_SOCKET: '',
      TEST_CLIPBOARD_ROOT: directory, TEST_CLIPBOARD_API: path.resolve(__dirname, '../native-api.js'),
      NATIVE_BINDING_TEST_PATH: binary }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('X11 file clipboard transfers a real selection between clients and binds acknowledgement to its owner', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  await x11Fixture(t, `
    assert.equal(api.capabilities['clipboard.readFiles'].status, 'conditional');
    const paths = [path.join(root, 'A'), path.join(root, 'a\\\\..\\\\b-😀')];
    for (const target of paths) await fs.writeFile(target, 'kept');
    const writer = api.openSession(), reader = api.openSession();
    const written = await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    assert.deepEqual(written.paths, paths);
    const read = await reader.invoke('clipboard.readFiles', {});
    assert.deepEqual(read.paths, paths);
    assert.equal(read.mode, 'move');
    assert.equal((await reader.invoke('clipboard.readFiles', {})).token, read.token);
    assert.equal((await reader.invoke('clipboard.acknowledge', { ...read, remainingPaths: [] })).matched, false);
    assert.deepEqual((await writer.invoke('clipboard.readFiles', {})).paths, paths);
    const own = await writer.invoke('clipboard.readFiles', {});
    assert.equal((await writer.invoke('clipboard.acknowledge', { ...own, remainingPaths: [paths[1]] })).matched, true);
    assert.deepEqual((await reader.invoke('clipboard.readFiles', {})).paths, [paths[1]]);
    const foreign = await reader.invoke('clipboard.writeFiles', { paths: [paths[0]], mode: 'copy' });
    assert.equal((await writer.invoke('clipboard.cancelFiles', own)).matched, false);
    assert.deepEqual((await reader.invoke('clipboard.readFiles', {})).paths, foreign.paths);
    assert.equal((await reader.invoke('clipboard.cancelFiles', foreign)).matched, true);
    assert.deepEqual((await writer.invoke('clipboard.readFiles', {})).paths, []);
  `);
});

test('X11 selection generations change when the same owner publishes the same paths again', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  await x11Fixture(t, `
    const paths = [path.join(root, 'file.txt')];
    await fs.writeFile(paths[0], 'first');
    const writer = api.openSession(), reader = api.openSession();
    await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    const first = await reader.invoke('clipboard.readFiles', {});
    await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    const second = await reader.invoke('clipboard.readFiles', {});
    assert.notEqual(second.token, first.token);
    assert.equal((await reader.invoke('clipboard.readFiles', {})).token, second.token);
  `);
});

test('X11 selection tokens change when a selected path has a new file identity', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  await x11Fixture(t, `
    const paths = [path.join(root, 'file.txt')];
    await fs.writeFile(paths[0], 'first');
    const writer = api.openSession(), reader = api.openSession();
    await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    const first = await reader.invoke('clipboard.readFiles', {});
    await fs.rename(paths[0], path.join(root, 'original.txt'));
    await fs.writeFile(paths[0], 'replacement');
    const second = await reader.invoke('clipboard.readFiles', {});
    assert.notEqual(second.token, first.token);
    assert.equal((await reader.invoke('clipboard.readFiles', {})).token, second.token);
  `);
});

test('X11 acknowledgement and cancellation reject a valid token with different captured paths or mode', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  await x11Fixture(t, `
    const paths = [path.join(root, 'first.txt'), path.join(root, 'second.txt')];
    for (const target of paths) await fs.writeFile(target, 'kept');
    const writer = api.openSession();
    const written = await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    const wrongPaths = await writer.invoke('clipboard.acknowledge', {
      ...written, paths: [paths[0]], remainingPaths: [paths[0]]
    });
    assert.equal(wrongPaths.matched, false);
    assert.deepEqual((await writer.invoke('clipboard.readFiles', {})).paths, paths);
    const wrongMode = await writer.invoke('clipboard.cancelFiles', { ...written, mode: 'copy' });
    assert.equal(wrongMode.matched, false);
    assert.deepEqual((await writer.invoke('clipboard.readFiles', {})).paths, paths);
  `);
});

test('X11 reading after a completed move keeps the generation while remaining paths retain identity', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  await x11Fixture(t, `
    const paths = [path.join(root, 'completed.txt'), path.join(root, 'remaining.txt')];
    for (const target of paths) await fs.writeFile(target, 'kept');
    const writer = api.openSession();
    const written = await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    await fs.unlink(paths[0]);
    const afterMove = await writer.invoke('clipboard.readFiles', {});
    assert.equal(afterMove.token, written.token);
    assert.equal((await writer.invoke('clipboard.acknowledge', {
      ...written, remainingPaths: [paths[1]]
    })).matched, true);
    assert.deepEqual((await writer.invoke('clipboard.readFiles', {})).paths, [paths[1]]);
  `);
});

test('X11 large selections complete INCR transfers between clients and an independent clipboard peer', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  await x11Fixture(t, `
    const prefix = path.join(root, ...Array(4).fill('x'.repeat(180)));
    const paths = Array.from({ length: 600 }, (_, index) => path.join(prefix, 'file-' + index));
    const writer = api.openSession(), reader = api.openSession();
    await writer.invoke('clipboard.writeFiles', { paths, mode: 'move' });
    assert.deepEqual((await reader.invoke('clipboard.readFiles', {})).paths, paths);
    const peer = require('node:child_process').spawnSync('xclip', ['-selection', 'clipboard', '-out', '-target', 'x-special/gnome-copied-files'], {
      encoding: 'utf8', timeout: 8000, env: process.env, maxBuffer: 1048576
    });
    assert.ifError(peer.error);
    assert.equal(peer.status, 0, peer.stderr);
    const expected = 'cut\\n' + paths.map(value => 'file://' + encodeURI(value)).join('\\r\\n') + '\\r\\n';
    assert.equal(peer.stdout, expected);
  `);
});
