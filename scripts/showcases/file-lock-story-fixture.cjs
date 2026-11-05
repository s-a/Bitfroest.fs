const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const content = 'The preview build is using this file.\n';
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const equalPath = (a, b) => typeof a === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

async function createFileLockStoryFixture(parent, modulePath) {
  if (process.platform !== 'win32' || !path.isAbsolute(modulePath || '')) throw new Error('A prebuilt Windows file-lock fixture is required.');
  const base = await fs.realpath(parent), moduleFile = await fs.realpath(modulePath);
  if (!(await fs.stat(base)).isDirectory() || !(await fs.stat(moduleFile)).isFile()) throw new Error('Invalid fixture input.');
  const root = await fs.mkdtemp(path.join(base, 'showcase-file-lock-'));
  const workspace = path.join(root, 'workspace'), folder = path.join(workspace, 'Build-Output'), file = path.join(folder, 'Locked.txt');
  const marker = path.join(root, '.showcase-file-lock'), token = crypto.randomUUID();
  const localModule = path.join(root, 'ShowcaseLock.node');
  const executable = path.join(root, 'Preview-Build.exe'), script = path.join(root, 'Preview-Build.cjs');
  await fs.mkdir(workspace); await fs.mkdir(folder);
  await fs.writeFile(marker, token, { flag: 'wx' });
  await fs.writeFile(file, content, { flag: 'wx' });
  const moduleBytes = await fs.readFile(moduleFile);
  await fs.writeFile(localModule, moduleBytes, { flag: 'wx' });
  const digest = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const executableHash = await digest(process.execPath);
  await fs.copyFile(process.execPath, executable, require('node:fs').constants.COPYFILE_EXCL);
  if (await digest(executable) !== executableHash) throw new Error('The fixture executable copy does not match.');
  const childScript = "const a=require('./ShowcaseLock.node');const lock=a.open(process.argv[2]);process.stdout.write(JSON.stringify({ready:true,executable:process.execPath})+'\\n');process.stdin.resume();process.stdin.on('end',()=>{a.close(lock);process.exit(0)});";
  await fs.writeFile(script, childScript, { flag: 'wx' });
  const identities = new Map();
  for (const item of [root, workspace, folder, marker, file, localModule, executable, script]) identities.set(item, identity(await fs.lstat(item, { bigint: true })));
  const child = spawn(executable, ['Preview-Build.cjs', 'workspace/Build-Output/Locked.txt'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let released = false;
  let errorText = '';
  child.stderr.on('data', data => { errorText += data; });
  async function release() {
    if (released) return;
    released = true;
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    let timer;
    const exit = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The demo process did not exit.')), 5000); })]).finally(() => clearTimeout(timer));
    if (exit[0] !== 0) throw new Error(`The demo process failed: ${errorText}`);
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The demo lock did not start.')), 10000);
      child.stdout.once('data', data => {
        clearTimeout(timer);
        try { const ready = JSON.parse(data.toString().trim()); if (!ready.ready || !equalPath(ready.executable, executable)) throw new Error('Unexpected demo executable.'); resolve(); }
        catch (error) { reject(error); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`The demo process exited: ${errorText}`)); });
    });
  } catch (error) { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited.catch(() => {}); throw error; }
  async function intact(item) {
    const stat = await fs.lstat(item, { bigint: true });
    if (stat.isSymbolicLink() || identity(stat) !== identities.get(item) || !equalPath(await fs.realpath(item), item)) throw new Error('Showcase fixture identity changed.');
  }
  async function assertIntact() {
    for (const item of [root, workspace, folder, marker, file, localModule, executable, script]) await intact(item);
    if (await fs.readFile(marker, 'utf8') !== token || await fs.readFile(file, 'utf8') !== content || !(await fs.readFile(localModule)).equals(moduleBytes) || await fs.readFile(script, 'utf8') !== childScript || await digest(executable) !== executableHash) throw new Error('Showcase fixture contents changed.');
    if (released || child.exitCode !== null || child.signalCode !== null) throw new Error('The demo lock is no longer active.');
  }
  async function assertTarget(target) {
    if (!equalPath(target, file)) throw new Error('The target is not the fixture file.');
    await assertIntact();
  }
  async function dispose() {
    await release();
    for (const item of [root, workspace, folder, marker, localModule, executable, script]) await intact(item);
    if (await fs.readFile(marker, 'utf8') !== token || !(await fs.readFile(localModule)).equals(moduleBytes) || await fs.readFile(script, 'utf8') !== childScript) throw new Error('Showcase fixture marker, module or script changed.');
    if (await digest(executable) !== executableHash) throw new Error('Showcase fixture executable changed.');
    const names = await fs.readdir(folder);
    if (names.length > 1 || names.length === 1 && names[0] !== 'Locked.txt') throw new Error('Unexpected files in showcase fixture.');
    if (names.length) { await intact(file); if (await fs.readFile(file, 'utf8') !== content) throw new Error('Showcase fixture contents changed.'); await fs.unlink(file); }
    if (JSON.stringify(await fs.readdir(workspace)) !== JSON.stringify(['Build-Output']) ||
        JSON.stringify((await fs.readdir(root)).sort()) !== JSON.stringify(['.showcase-file-lock', 'ShowcaseLock.node', 'Preview-Build.exe', 'Preview-Build.cjs', 'workspace'].sort())) throw new Error('Unexpected files in showcase fixture.');
    await fs.unlink(marker); await fs.unlink(localModule); await fs.unlink(script); await fs.unlink(executable); await fs.rmdir(folder); await fs.rmdir(workspace); await fs.rmdir(root);
  }
  return { root, left: folder, right: workspace, folder, file, executable, script, pid: child.pid, assertIntact, assertTarget, release, dispose };
}

module.exports = { createFileLockStoryFixture };
