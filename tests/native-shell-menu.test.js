const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { createShellMenuProvider } = require('../native-shell-menu');

test('owned folder inspection is a separate menu outcome and never an arbitrary shell command', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t);
  const directory = path.join(files.root, 'inspect-folder'); await fs.mkdir(directory);
  let input;
  const provider = createShellMenuProvider({ roots: [files.root], runHelper: async value => { input = value; return { ok: true, displayed: true, invoked: true, cancelled: false, action: 'inspect-locks' }; } });
  t.after(() => provider.dispose());
  assert.equal((await provider.show([directory], { lockInspectionLabel: 'Inspect folder locks' })).action, 'inspect-locks');
  assert.equal(input.lockInspectionLabel, 'Inspect folder locks');
  await assert.rejects(provider.show([files.a]), /Ordner/);
});

test('native folder inspection enumerates the owned action without displaying or invoking it', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t), directory = path.join(files.root, 'folder'); await fs.mkdir(directory);
  const provider = createShellMenuProvider({ roots: [files.root] }); t.after(() => provider.dispose());
  const result = await provider.inspect([directory]);
  assert.equal(result.displayed, false); assert.equal(result.invoked, false);
  assert.ok(result.entries.some(entry => entry.label === 'Ordnersperren untersuchen'));
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-shell-menu-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left'), right = path.join(root, 'right'); await fs.mkdir(left); await fs.mkdir(right);
  const a = path.join(left, 'literal & Datei.txt'), b = path.join(left, 'second.txt'), other = path.join(right, 'other.txt');
  await Promise.all([fs.writeFile(a, 'ORIGINAL'), fs.writeFile(b, 'SECOND'), fs.writeFile(other, 'OTHER')]);
  return { root, a, b, other };
}
const inspected = { ok: true, displayed: false, invoked: false, entries: [{ label: 'Properties', submenu: false }], interfaces: { contextMenu2: true, contextMenu3: true } };

test('inspection passes a frozen same-parent selection to the isolated helper without displaying or invoking a menu', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t), calls = [];
  const provider = createShellMenuProvider({ roots: [files.root], runHelper: async input => { calls.push(input); return inspected; } }); t.after(() => provider.dispose());
  const selection = [files.a, files.b]; const pending = provider.inspect(selection); selection[0] = files.other; selection.length = 1; const result = await pending;
  assert.deepEqual(calls[0].paths, [files.a, files.b]); assert.equal(calls[0].mode, 'inspect');
  assert.equal(result.displayed, false); assert.equal(result.invoked, false);
  assert.equal(await fs.readFile(files.a, 'utf8'), 'ORIGINAL');
});

test('unsupported platforms fail explicitly without launching a substitute menu', async () => {
  for (const platform of ['linux', 'darwin']) {
    let calls = 0; const provider = createShellMenuProvider({ platform, roots: ['/tmp'], runHelper: async () => { calls++; } });
    await assert.rejects(provider.show(['/tmp/file']), error => error.code === 'ENOTSUPPORTED'); assert.equal(calls, 0); provider.dispose();
  }
});

test('invalid, external, traversing and mixed-parent selections cannot reach the native helper', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t); let calls = 0;
  const provider = createShellMenuProvider({ roots: [path.dirname(files.a)], runHelper: async () => { calls++; return inspected; } }); t.after(() => provider.dispose());
  for (const paths of [[], [files.a, files.a], [files.other], [files.a, files.other], ['relative.txt'], [files.a + ':stream'], [path.dirname(files.a) + '/../../outside.txt'], [files.a + '\0']]) await assert.rejects(provider.inspect(paths));
  assert.equal(calls, 0);
});

test('a busy or disposed provider cannot open overlapping native menus and malformed helper replies are rejected', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t); let finish;
  const provider = createShellMenuProvider({ roots: [files.root], runHelper: async () => new Promise(resolve => { finish = resolve; }) }); t.after(() => provider.dispose());
  const first = provider.show([files.a]); while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(provider.show([files.b]), error => error.code === 'EBUSY');
  finish({ ok: true, displayed: true, invoked: false, cancelled: true }); assert.equal((await first).cancelled, true);
  provider.dispose(); await assert.rejects(provider.inspect([files.a]), error => error.code === 'EDISPOSED');
  for (const response of ['not-json', { ok: false, message: 'native detail' }, { ok: true, displayed: true, invoked: true }]) {
    const invalid = createShellMenuProvider({ roots: [files.root], runHelper: async () => response }); t.after(() => invalid.dispose()); await assert.rejects(invalid.inspect([files.a]));
  }
});

test('native inspection enumerates the Windows shell menu for an owned fixture without a popup or invocation', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t), provider = createShellMenuProvider({ roots: [files.root] }); t.after(() => provider.dispose());
  const result = await provider.inspect([files.a, files.b]);
  assert.equal(result.displayed, false); assert.equal(result.invoked, false);
  assert.ok(result.entries.some(entry => typeof entry.label === 'string' && entry.label.trim().length));
  assert.ok(result.timing.compileMilliseconds >= 0); assert.ok(result.timing.nativeMilliseconds >= 0);
  t.diagnostic(`Native menu inspection timing: ${JSON.stringify(result.timing)}`);
  assert.equal(await fs.readFile(files.a, 'utf8'), 'ORIGINAL'); assert.equal(await fs.readFile(files.b, 'utf8'), 'SECOND');
});

test('menu display carries a host-owned window title and keyboard anchor without accepting arbitrary popup coordinates', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t); let request;
  const provider = createShellMenuProvider({ roots: [files.root], runHelper: async input => { request = input; return { ok: true, displayed: true, invoked: false, cancelled: true }; } }); t.after(() => provider.dispose());
  const settings = { keyboard: true, ownerTitle: 'File manager · Workspace', x: 90000, y: -90000 };
  const pending = provider.show([files.a], settings); settings.keyboard = false; settings.ownerTitle = 'Changed'; await pending;
  assert.equal(request.ownerTitle, 'File manager · Workspace'); assert.equal(request.keyboard, true);
  assert.equal(request.hostProcessId, process.pid, 'helper lifetime is tied to the owning extension host');
  assert.equal(request.expectedProcessPath, process.execPath); assert.equal(request.x, undefined); assert.equal(request.y, undefined);
});

test('contradictory display outcomes cannot report both cancellation and command invocation', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t);
  for (const invoked of [true, false]) {
    const provider = createShellMenuProvider({ roots: [files.root], runHelper: async () => ({ ok: true, displayed: true, invoked, cancelled: invoked }) }); t.after(() => provider.dispose());
    await assert.rejects(provider.show([files.a]), error => error.code === 'EPROTOCOL');
  }
});

test('helper pipe failure rejects once and releases the process instead of escaping as an unhandled stream error', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t); let killed = 0;
  const provider = createShellMenuProvider({ roots: [files.root], execFile(_command, args, settings, complete) {
    assert.ok(args.includes('-Sta')); assert.equal(settings.windowsHide, true); assert.equal(settings.timeout, 30000);
    const child = new EventEmitter();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = () => { killed++; queueMicrotask(() => complete(new Error('child stopped'), '', '')); };
    child.stdin.on('finish', () => queueMicrotask(() => { const error = new Error('pipe closed'); error.code = 'EPIPE'; child.stdin.emit('error', error); }));
    return child;
  } }); t.after(() => provider.dispose());
  await assert.rejects(provider.inspect([files.a]), error => error.code === 'EPIPE'); assert.equal(killed, 1);
});

test('disposing a live helper terminates it and cannot later report a successful menu invocation', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t); let complete, killed = 0;
  const provider = createShellMenuProvider({ roots: [files.root], execFile(_command, _args, _options, callback) {
    complete = callback; const child = new EventEmitter(); child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } }); child.kill = () => { killed++; queueMicrotask(() => complete(null, JSON.stringify({ ok: true, displayed: true, invoked: true, cancelled: false }))); }; return child;
  } });
  const pending = provider.show([files.a]); while (!complete) await new Promise(resolve => setImmediate(resolve));
  provider.dispose(); await assert.rejects(pending, error => error.code === 'EDISPOSED'); assert.equal(killed, 1);
});

test('directory junctions cannot redirect an allowed selection to another location', { skip: process.platform !== 'win32' }, async t => {
  const files = await fixture(t), link = path.join(path.dirname(files.a), 'redirect'); await fs.symlink(path.dirname(files.other), link, 'junction');
  let calls = 0; const provider = createShellMenuProvider({ roots: [files.root], runHelper: async () => { calls++; return inspected; } }); t.after(() => provider.dispose());
  await assert.rejects(provider.inspect([path.join(link, path.basename(files.other))]), error => error.code === 'EACCESS'); assert.equal(calls, 0);
});
