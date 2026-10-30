const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createClipboardProvider } = require('../clipboard-provider');

const contains = value => /^C:\/(tmp|temp)\//i.test(value);
function harness(platform = 'win32', response = { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'native-17' }) {
  const calls = [];
  const provider = createClipboardProvider({ platform, contains, runHelper: async (command, args, payload) => { calls.push({ command, args, payload }); return JSON.stringify(response); } });
  return { provider, calls };
}
test('Windows exports file paths and preferred copy/cut effect through a structured STA helper', async () => {
  const app = harness();
  const result = await app.provider.write({ paths: ['C:/tmp/a.txt'], mode: 'move' });
  assert.equal(result.mode, 'move');
  assert.deepEqual(result.paths, ['C:/tmp/a.txt']);
  assert.equal(app.calls[0].command, 'powershell.exe');
  assert.ok(app.calls[0].args.includes('-STA'));
  assert.deepEqual(app.calls[0].payload, { action: 'write', paths: ['C:/tmp/a.txt'], mode: 'move' });
});
test('native read distinguishes file clipboard from absent/unknown data', async () => {
  const app = harness();
  assert.equal((await app.provider.read()).token, 'native-17');
  assert.deepEqual(app.calls[0].payload, { action: 'read' });
  assert.equal(await harness('win32', { paths: [], mode: 'copy', token: 'empty' }).provider.read(), null);
});
test('unauthorized, relative, traversal, invalid mode and oversized path requests never reach native helper', async () => {
  for (const payload of [
    { paths: ['C:/outside/a'], mode: 'copy' }, { paths: ['relative'], mode: 'copy' },
    { paths: ['C:/tmp/../outside/a'], mode: 'copy' }, { paths: ['C:/tmp/a'], mode: 'link' },
    { paths: ['C:/tmp/a\0b'], mode: 'copy' }, { paths: Array(1025).fill('C:/tmp/a'), mode: 'copy' }
  ]) {
    const app = harness();
    await assert.rejects(app.provider.write(payload));
    assert.equal(app.calls.length, 0);
  }
});
test('read rejects external paths instead of pretending to support unrestricted imports', async () => {
  await assert.rejects(harness('win32', { paths: ['C:/outside/a'], mode: 'move', token: 'x' }).provider.read(), /freigegeben/);
});
test('cut acknowledgement carries token and remaining paths without running a file deletion', async () => {
  const app = harness('win32', { matched: true });
  assert.equal(await app.provider.ack({ token: 'native-17', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] }), true);
  assert.deepEqual(app.calls[0].payload, { action: 'ack', token: 'native-17', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] });
  assert.equal(await harness('win32', { matched: false }).provider.ack({ token: 'old', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] }), false);
});
test('unknown platform fails explicitly without file-name-as-text fallback', async () => {
  const app = harness('freebsd');
  await assert.rejects(app.provider.write({ paths: ['C:/tmp/a'], mode: 'copy' }), /Datei-Zwischenablage/);
  assert.equal(app.calls.length, 0);
});

test('Linux uses typed file URIs and GNOME cut data instead of ordinary clipboard text', async () => {
  const calls = [], io = { formats: 'text/uri-list\nx-special/gnome-copied-files', text: 'cut\nfile:///home/test/tmp/a%20b.txt' };
  const provider = createClipboardProvider({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, contains: value => value.startsWith('/home/test/tmp/'), runHelper: async (command, args, payload) => { calls.push({ command, args, payload }); return args.includes('--list-types') ? io.formats : args.includes('--type') && command === 'wl-paste' ? io.text : ''; } });
  assert.deepEqual((await provider.read()).paths, ['/home/test/tmp/a b.txt']);
  assert.equal((await provider.read()).mode, 'move');
  await provider.write({ paths: ['/home/test/tmp/a b.txt'], mode: 'move' });
  assert.ok(calls.some(call => call.command === 'wl-copy' && call.args.includes('x-special/gnome-copied-files') && call.payload === 'cut\nfile:///home/test/tmp/a%20b.txt'));
});
test('Linux clipboard acknowledgement never overwrites a concurrently changed owner', async () => {
  let text = 'file:///home/test/tmp/a.txt\r\n'; const calls = [];
  const provider = createClipboardProvider({ platform: 'linux', env: { WAYLAND_DISPLAY: 'one' }, contains: value => value.startsWith('/home/test/tmp/'), runHelper: async (command, args) => { calls.push(command); return args.includes('--list-types') ? 'text/uri-list' : text; } });
  const original = await provider.read(); text = 'file:///home/test/tmp/other.txt\r\n';
  assert.equal(await provider.ack({ ...original, remainingPaths: [] }), false);
  assert.ok(calls.every(command => command === 'wl-paste'));
});

test('Linux repeated paste excludes only confirmed consumed paths and recognizes recreated sources', async () => {
  let recreated = false;
  const provider = createClipboardProvider({platform:'linux',env:{WAYLAND_DISPLAY:'one'},contains:value=>value.startsWith('/tmp/'),exists:()=>recreated,runHelper:async(command,args)=>args.includes('--list-types')?'x-special/gnome-copied-files':'cut\nfile:///tmp/a\nfile:///tmp/b'});
  const before = await provider.read();
  await provider.ack({...before,remainingPaths:['/tmp/b']});
  assert.deepEqual((await provider.read()).paths,['/tmp/b']);
  recreated = true;
  assert.deepEqual((await provider.read()).paths,['/tmp/a','/tmp/b']);
});

test('native helper transport bounds output, handles process errors and never builds shell commands', async () => {
  for (const outcome of ['success', 'process-error', 'stdin-error', 'overflow', 'exit-error', 'timeout']) {
    let spawned, killed = false;
    const provider = createClipboardProvider({ platform: 'win32', contains, timeout: 2, spawn: (command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.kill = () => { killed = true; };
      child.stdin.end = input => queueMicrotask(() => {
        assert.deepEqual(JSON.parse(input), { action: 'read' });
        if (outcome === 'timeout') return;
        if (outcome === 'process-error') { child.emit('error', new Error('spawn failure')); return; }
        if (outcome === 'stdin-error') { child.stdin.emit('error', new Error('pipe failure')); return; }
        if (outcome === 'overflow') { child.stdout.emit('data', 'x'.repeat(1048577)); child.emit('close', 0); return; }
        if (outcome === 'exit-error') { child.stderr.emit('data', 'native error'); child.emit('close', 3); return; }
        child.stdout.emit('data', JSON.stringify({ paths: ['C:/tmp/a'], mode: 'copy', token: 'one' })); child.emit('close', 0);
      });
      return child;
    } });
    if (outcome === 'success') assert.equal((await provider.read()).token, 'one');
    else await assert.rejects(provider.read());
    assert.equal(spawned.command, 'powershell.exe'); assert.equal(spawned.options.windowsHide, true); assert.equal(spawned.options.shell, undefined);
    if (['overflow','timeout'].includes(outcome)) assert.equal(killed, true);
  }
});

test('malformed native responses, foreign remainder and unavailable copy tools fail explicitly', async () => {
  for (const response of ['{bad', 'null', '{}', '{"error":"native error"}', '{"paths":["C:/tmp/a"],"mode":"copy","token":""}']) {
    const provider = createClipboardProvider({ platform: 'win32', contains, runHelper: async () => response });
    await assert.rejects(provider.read());
  }
  const app = harness();
  await assert.rejects(app.provider.ack({ token: '', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: [] }));
  await assert.rejects(app.provider.ack({ token: 'x', paths: ['C:/tmp/a'], mode: 'move', remainingPaths: ['C:/tmp/b'] }));
  const unavailable = createClipboardProvider({ platform: 'linux', env: {}, contains, runHelper: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } });
  await assert.rejects(unavailable.read(), { code: 'CLIPBOARD_UNAVAILABLE' });
});

test('macOS exports file URLs through AppKit and rejects unsupported native cut interoperability', async () => {
  const calls = [];
  const provider = createClipboardProvider({ platform: 'darwin', contains: value => value.startsWith('/tmp/'), runHelper: async (command,args,payload) => { calls.push({command,args,payload}); return JSON.stringify({paths:['/tmp/a'],mode:'copy',token:'change-1'}); } });
  assert.equal((await provider.write({paths:['/tmp/a'],mode:'copy'})).token, 'change-1');
  assert.equal(calls[0].command, 'osascript'); assert.ok(calls[0].args.includes('JavaScript'));
  await assert.rejects(provider.write({paths:['/tmp/a'],mode:'move'}), { code: 'CLIPBOARD_UNAVAILABLE' });
});

test('X11 copy exposes text/uri-list and unsupported native cut does not degrade to text copy', async () => {
  const calls = [];
  const provider = createClipboardProvider({platform:'linux',env:{},contains:value=>value.startsWith('/tmp/'),runHelper:async(command,args,payload)=>{calls.push({command,args,payload});return args.includes('TARGETS')?'text/uri-list':args.includes('-o')?'file:///tmp/a\r\n':'';}});
  assert.equal((await provider.read()).mode,'copy');
  await provider.write({paths:['/tmp/a'],mode:'copy'});
  assert.ok(calls.some(call=>call.command==='xclip'&&call.args.includes('-i')&&call.args.includes('text/uri-list')));
  await assert.rejects(provider.write({paths:['/tmp/a'],mode:'move'}),{code:'CLIPBOARD_UNAVAILABLE'});
});

test('KDE cut selection is imported as move rather than silently downgraded to copy', async () => {
  const provider = createClipboardProvider({platform:'linux',env:{},contains:value=>value.startsWith('/tmp/'),runHelper:async(command,args)=>args.includes('TARGETS')?'text/uri-list\napplication/x-kde-cutselection':args.includes('application/x-kde-cutselection')?'1':'file:///tmp/a\r\n'});
  assert.equal((await provider.read()).mode,'move');
});

test('native helper transport preserves Unicode paths split across output chunks', async () => {
  const value = {paths:['C:/tmp/Größe-文件.txt'],mode:'copy',token:'unicode'};
  const encoded = Buffer.from(JSON.stringify(value)); const boundary = encoded.indexOf(Buffer.from('文')) + 1;
  const provider = createClipboardProvider({platform:'win32',contains,spawn:()=>{
    const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.stdin=new EventEmitter(); child.kill=()=>{};
    child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',encoded.subarray(0,boundary));child.stdout.emit('data',encoded.subarray(boundary));child.emit('close',0);});return child;
  }});
  assert.deepEqual((await provider.read()).paths,value.paths);
});
