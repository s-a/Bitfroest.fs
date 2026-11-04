const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createNativeApi } = require('../native-api');

const execute = promisify(execFile);
const child = process.env.BITFROEST_MUTTER_CHILD === '1';
const kwin = process.env.NATIVE_TEST_COMPOSITOR === 'kwin';

test(kwin ? 'KWin Wayland exchanges file selections through native data control' : 'GNOME Wayland exchanges file selections with an existing XWayland connection', {
  skip: process.platform !== 'linux', timeout: 30000
}, async t => {
  if (!child) {
    const required = process.env.BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS === '1';
    const binary = kwin ? process.env.NATIVE_KWIN_BINARY || 'kwin_wayland' : process.env.NATIVE_MUTTER_BINARY || 'mutter';
    try { await execute(binary, ['--version']); }
    catch (error) { if (required) throw error; t.skip('The private test compositor is unavailable.'); return; }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-mutter-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { ...process.env, BITFROEST_MUTTER_CHILD: '1', XDG_RUNTIME_DIR: root,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
      GSETTINGS_BACKEND: 'memory', LIBGL_ALWAYS_SOFTWARE: '1', DISPLAY: '', WAYLAND_DISPLAY: 'native-compositor-test',
      QT_QPA_PLATFORM: 'offscreen', KWIN_COMPOSE: 'Q', PYTHONDONTWRITEBYTECODE: '1' };
    delete env.WAYLAND_SOCKET;
    const resultPath = path.join(root, 'child-result.json');
    const childArgs = [process.execPath, path.join(__dirname, 'support/wayland-compositor-child.cjs'), resultPath, __filename];
    const args = kwin ? ['--virtual', '--width', '800', '--height', '600', '--no-global-shortcuts', '--no-lockscreen', '--no-kactivities', '--socket', env.WAYLAND_DISPLAY,
      '--exit-with-session', childArgs.map(value => `"${value.replaceAll('"', '\\"')}"`).join(' ')] : ['--wayland', '--headless', '--virtual-monitor', '800x600', '--sm-disable', '--wayland-display', env.WAYLAND_DISPLAY,
      ...(process.env.NATIVE_MUTTER_PLUGIN ? ['--mutter-plugin', process.env.NATIVE_MUTTER_PLUGIN] : []),
      '--', ...childArgs];
    await execute('dbus-run-session', ['--', binary, ...args], { env, timeout: 25000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    return;
  }
  assert.ok(process.env.WAYLAND_DISPLAY);
  if (!kwin) {
  assert.ok(process.env.DISPLAY, 'The compositor must provide its own existing XWayland display.');
  const keyboard = spawn('python3', [path.join(__dirname, 'support/wayland-keyboard.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let keyboardErrors = '';
  keyboard.stderr.on('data', data => { keyboardErrors += data; });
  t.after(() => keyboard.stdin.end());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { keyboard.kill(); reject(new Error(`Private keyboard fixture timed out: ${keyboardErrors}`)); }, 6000);
    keyboard.stdout.once('data', data => { clearTimeout(timer); if (data.toString().trim() === 'READY') resolve(); else reject(new Error(data.toString())); });
    keyboard.once('error', error => { clearTimeout(timer); reject(error); });
    keyboard.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Private keyboard failed: ${keyboardErrors}`)); });
  });
  }
  const api = createNativeApi(require(process.env.NATIVE_BINDING_TEST_PATH || '../native/binding.node'));
  t.after(() => api.shutdownAsync());
  assert.ok(['supported', 'conditional'].includes(api.capabilities['clipboard.readFiles'].status), api.capabilities['clipboard.readFiles'].reason);
  const session = api.openSession();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-wayland-selection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first.txt'), second = path.join(root, 'second.txt'), third = path.join(root, 'foreign.txt');
  await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(second, 'second'), fs.writeFile(third, 'foreign')]);
  const uri = value => new URL(`file://${value}`).href;
  const nativeSelection = await session.invoke('clipboard.writeFiles', { paths: [first, second], mode: 'move' });
  assert.equal(nativeSelection.transport, kwin ? 'wayland-data-control' : 'xwayland');
  let pasted, pasteFailure;
  const pasteDeadline = Date.now() + 6000;
  while (Date.now() < pasteDeadline) {
    try { pasted = await execute('wl-paste', ['--no-newline', '--type', 'x-special/gnome-copied-files'], { timeout: 1500 }); break; }
    catch (error) { pasteFailure = error; await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  if (!pasted) throw pasteFailure;
  assert.equal(pasted.stdout.trim(), `cut\n${uri(first)}\n${uri(second)}`);
  assert.equal((await session.invoke('clipboard.acknowledge', { ...nativeSelection, remainingPaths: [second] })).matched, true);
  const remaining = await execute('wl-paste', ['--no-newline', '--type', 'x-special/gnome-copied-files'], { timeout: 6000 });
  assert.equal(remaining.stdout.trim(), `cut\n${uri(second)}`);
  const foreign = spawn('wl-copy', ['--foreground', '--type', 'x-special/gnome-copied-files'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  foreign.stderr.on('data', data => { errors += data; });
  t.after(() => { if (foreign.exitCode === null) foreign.kill(); });
  foreign.stdin.end(`cut\n${uri(third)}\n`);
  let selection;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    selection = await session.invoke('clipboard.readFiles', {});
    if (selection.paths?.[0] === third) break;
    if (foreign.exitCode !== null) assert.fail(`Independent Wayland owner exited: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.deepEqual(selection.paths, [third], errors);
  assert.equal(selection.mode, 'move');
  const old = await session.invoke('clipboard.cancelFiles', nativeSelection);
  assert.equal(old.matched, false);
  assert.deepEqual((await session.invoke('clipboard.readFiles', {})).paths, [third]);
});
