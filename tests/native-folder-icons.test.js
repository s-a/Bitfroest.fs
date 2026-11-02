const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const posix = { skip: !['linux', 'darwin'].includes(process.platform) };

test('native folder icon batches reject invalid requests before filesystem access', posix, () => {
  const session = require(binary).openSession();
  const valid = { key: 'folder', path: '/tmp', type: 'folder', name: 'tmp' };
  try {
    for (const request of [null, {}, { requests: Array(25).fill(valid) }, { requests: [null] },
      { requests: [{ ...valid, key: 'x'.repeat(301) }] }, { requests: [{ ...valid, path: 'relative' }] },
      { requests: [{ ...valid, path: '/bad\0path' }] }, { requests: [{ ...valid, type: 'other' }] }]) {
      assert.throws(() => session.invoke('icons.resolve', request), { code: 'InvalidRequest' });
    }
  } finally { session.close(); }
});

test('Linux renders relative KDE icons, inherited theme SVGs and missing folders without a display', { skip: process.platform !== 'linux' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-icons-'));
  const folder = path.join(root, 'folder'), config = path.join(root, 'config'), data = path.join(root, 'data');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>';
  try {
    await fs.mkdir(folder);
    await fs.mkdir(config);
    await fs.mkdir(path.join(data, 'icons/Parent/scalable/places'), { recursive: true });
    await fs.mkdir(path.join(data, 'icons/Child'), { recursive: true });
    await fs.writeFile(path.join(folder, '.directory'), '[Desktop Entry]\nIcon=./custom.svg\n');
    await fs.writeFile(path.join(folder, 'custom.svg'), svg);
    await fs.writeFile(path.join(config, 'kdeglobals'), '[Icons]\nTheme=Child\n');
    await fs.writeFile(path.join(data, 'icons/Child/index.theme'), '[Icon Theme]\nName=Child\nInherits=Parent\n');
    await fs.writeFile(path.join(data, 'icons/Parent/index.theme'), '[Icon Theme]\nName=Parent\nDirectories=scalable/places\n[scalable/places]\nSize=32\nType=Scalable\nMinSize=16\nMaxSize=256\n');
    await fs.writeFile(path.join(data, 'icons/Parent/scalable/places/custom-folder.svg'), svg);
    const script = `const assert=require('node:assert/strict');(async()=>{const b=require(process.argv[1]);assert.notEqual(b.capabilities['icons.resolve'].status,'unsupported');const s=b.openSession();try{const path=process.argv[2];const result=await s.invoke('icons.resolve',{requests:[{key:'folder',path,type:'folder',name:'folder'},{key:'theme',path:'',type:'folder',name:'folder',iconResource:'custom-folder'},{key:'missing',path:path+'/missing',type:'folder',name:'missing'}]});assert.equal(result.icons.length,3);for(const row of result.icons.slice(0,2)){assert.ok(Buffer.isBuffer(row.png));assert.equal(row.png.subarray(0,8).toString('hex'),'89504e470d0a1a0a')}assert.ok(result.icons[0].png.equals(result.icons[1].png));assert.equal(result.icons[2].png,null)}finally{s.close();await s.whenClosed()}})().catch(e=>{console.error(e);process.exitCode=1})`;
    execFileSync(process.execPath, ['-e', script, binary, folder], { env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, timeout: 15000 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('macOS resolves a real directory through Finder without altering its metadata', { skip: process.platform !== 'darwin' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'finder-icons-'));
  const session = require(binary).openSession();
  try {
    const before = await fs.stat(root);
    const result = await session.invoke('icons.resolve', { requests: [{ key: 'finder', path: root, type: 'folder', name: 'folder' }] });
    assert.equal(result.icons[0].png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const after = await fs.stat(root);
    assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { session.close(); await session.whenClosed(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Linux reads GNOME custom icon metadata in an isolated desktop session', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnome-folder-icons-'));
  const folder = path.join(root, 'folder'), icon = path.join(root, 'custom.svg');
  try {
    await fs.mkdir(folder);
    await fs.writeFile(icon, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>');
    const script = `const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');(async()=>{const folder=process.argv[2],icon=process.argv[3];const set=spawnSync('gio',['set',folder,'metadata::custom-icon',pathToFileURL(icon).href],{encoding:'utf8'});if(set.status!==0){process.stderr.write(set.stderr||String(set.error));process.exit(77)}const session=require(process.argv[1]).openSession();try{const result=await session.invoke('icons.resolve',{requests:[{key:'metadata',path:folder,name:'folder',type:'folder'},{key:'resource',path:'',name:'folder',type:'folder',iconResource:icon}]});assert.ok(Buffer.isBuffer(result.icons[0].png));assert.ok(result.icons[0].png.equals(result.icons[1].png))}finally{session.close();await session.whenClosed()}})().catch(error=>{console.error(error);process.exitCode=1})`;
    const result = spawnSync('dbus-run-session', ['--', process.execPath, '-e', script, binary, folder, icon], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', XDG_CURRENT_DESKTOP: 'GNOME', XDG_DATA_HOME: path.join(root, 'data') }
    });
    if (result.error?.code === 'ENOENT' || result.status === 77) { t.skip('A GIO metadata service and an isolated D-Bus session are required.'); return; }
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('closing a native icon session rejects outstanding work and confirms resource cleanup', posix, async () => {
  const session = require(binary).openSession();
  const pending = session.invoke('icons.resolve', { requests: [{ key: 'folder', path: os.tmpdir(), name: 'folder', type: 'folder' }] });
  session.close();
  await assert.rejects(pending, { code: 'SessionClosed' });
  await session.whenClosed();
});
