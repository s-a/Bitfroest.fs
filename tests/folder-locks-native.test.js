const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createFolderLocks } = require('../folder-locks');

test('Windows adapter detects a real descendant handle and terminates only the confirmed fixture identity', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-native-'));
  const childDir = path.join(root, 'sub'); await fs.mkdir(childDir);
  const file = path.join(childDir, 'held.txt'); await fs.writeFile(file, 'UNCHANGED');
  const child = spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'r'); process.stdout.write('ready'); setInterval(()=>{},1000)", file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await fs.rm(root, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  const provider = createFolderLocks({ roots: [root] }); t.after(() => provider.dispose());
  const result = await provider.scan(root);
  const held = result.rows.filter(row => row.pid === child.pid && row.kind === 'handle');
  assert.ok(held.some(row => path.resolve(row.file).toLowerCase() === file.toLowerCase()), 'real nested file handle appears');
  assert.equal(await fs.readFile(file, 'utf8'), 'UNCHANGED');
  const exit = once(child, 'exit');
  await provider.act('terminate', held.map(row => row.id)); await exit;
  assert.equal(await fs.readFile(file, 'utf8'), 'UNCHANGED');
  assert.equal((await provider.scan(root)).rows.some(row => row.pid === child.pid), false);
});

test('native unlock releases an owned file handle and resumes the owning process', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-unlock-'));
  const file = path.join(root, 'held.txt'); await fs.writeFile(file, 'ORIGINAL');
  const child = spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'r'); process.stdout.write('ready'); process.stdin.on('data',()=>process.stdout.write('alive'))", file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await fs.rm(root, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  const provider = createFolderLocks({ roots: [root] }); t.after(() => provider.dispose());
  const result = await provider.scan(root);
  const held = result.rows.filter(row => row.pid === child.pid && row.kind === 'handle' && row.file.toLowerCase() === file.toLowerCase());
  assert.ok(held.length); await provider.act('unlock', held.map(row => row.id));
  const answer = once(child.stdout, 'data'); child.stdin.write('ping');
  assert.equal(String((await answer)[0]), 'alive');
  assert.equal((await provider.scan(root)).rows.some(row => row.pid === child.pid && row.kind === 'handle'), false);
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
});

test('native module unlock unloads a fixture DLL from its owned process', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locks-module-'));
  const dll = path.join(root, 'fixture-version.dll');
  await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'version.dll'), dll);
  const script = `Add-Type -MemberDefinition '[DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibrary(string name);' -Name ModuleFixture -Namespace Owned; if ([Owned.ModuleFixture]::LoadLibrary('${dll.replaceAll("'", "''")}') -eq [IntPtr]::Zero) { exit 2 }; [Console]::WriteLine('ready'); while ($null -ne [Console]::ReadLine()) { [Console]::WriteLine('alive') }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await fs.rm(root, { recursive: true, force: true }); });
  const ready = await Promise.race([once(child.stdout, 'data').then(([data]) => String(data)), once(child, 'exit').then(([code]) => { throw new Error(`Module fixture exited: ${code}`); })]);
  assert.match(ready, /ready/);
  const provider = createFolderLocks({ roots: [root] }); t.after(() => provider.dispose());
  const state = await provider.scan(root), modules = state.rows.filter(row => row.pid === child.pid && row.kind === 'module');
  assert.ok(modules.some(row => row.file.toLowerCase() === dll.toLowerCase()));
  await provider.act('unlock', modules.map(row => row.id));
  const response = once(child.stdout, 'data'); child.stdin.write('ping\n'); assert.match(String((await response)[0]), /alive/);
  assert.equal((await provider.scan(root)).rows.some(row => row.pid === child.pid && row.kind === 'module'), false);
});
