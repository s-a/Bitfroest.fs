/* global document */
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function createLockFixture(demo) {
  const moduleFixture = process.env.NATIVE_LOCKS_MODULE_FIXTURE;
  if (!moduleFixture || !path.isAbsolute(moduleFixture)) throw new Error('A prebuilt lock documentation module is required.');
  const folder = path.join(demo, 'left', 'Build-Output');
  const destination = path.join(demo, 'right', 'Build-Output-Copy');
  const tools = path.resolve(demo, '../showcases/lock-tools');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(tools, { recursive: true });
  const node = path.join(tools, 'node.exe'), script = path.join(tools, 'Preview-Build.cjs');
  await fs.copyFile(process.execPath, node);
  await fs.copyFile(moduleFixture, path.join(tools, 'LockFixture.node'));
  await fs.copyFile(path.join(process.env.SystemRoot, 'System32/version.dll'), path.join(folder, 'Preview-Plugin.dll'));
  await fs.writeFile(path.join(folder, 'Build.log'), 'Preview build is waiting for review.\n');
  await fs.writeFile(script, "const fs=require('node:fs');const path=require('node:path');require('./LockFixture.node').load(path.resolve('Preview-Plugin.dll'));const file=fs.openSync('Build.log','r');process.stdin.resume();process.stdin.on('end',()=>{fs.closeSync(file);process.exit(0)});process.stdout.write('READY\\n');\n");
  const child = spawn(node, [script], { cwd: folder, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const dispose = async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 5000); })]);
    clearTimeout(timer);
    await exited;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The lock documentation process did not start: ${errors}`)), 10000);
      child.stdout.once('data', data => { clearTimeout(timer); if (data.toString().trim() === 'READY') resolve(); else reject(new Error(data.toString())); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`The lock documentation process exited with ${code}: ${errors}`)); });
    });
  } catch (error) { await dispose(); throw error; }
  return { folder, destination, pid: child.pid, dispose: async () => {
    const before = await fs.readFile(path.join(folder, 'Build.log'), 'utf8');
    const healthy = child.exitCode === null && child.signalCode === null;
    await dispose();
    if (!healthy || before !== 'Preview build is waiting for review.\n') throw new Error('The lock documentation process or its file was changed.');
    try { await fs.stat(destination); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('A lock documentation file operation was unexpectedly performed.');
  } };
}

async function prepareLockCapture({ capture, lockFixture, targets, connect, connections, waitFor }) {
  if (!lockFixture || !['inspect', 'actions', 'destination', 'confirmation'].includes(capture.lockAction)) throw new Error('A controlled lock documentation preview is required.');
  const clients = new Map();
  const clientFor = async target => {
    if (!clients.has(target.id)) {
      const client = await connect(target.webSocketDebuggerUrl);
      connections.push(client); clients.set(target.id, client);
      await client.call('Runtime.enable');
    }
    return clients.get(target.id);
  };
  const found = await waitFor(async () => {
    for (const target of await targets()) {
      if (target.type !== 'iframe' || !target.url.includes('extensionId=bitfroest.bitfroest-fs-prototype')) continue;
      const client = await clientFor(target);
      for (const context of client.contexts) {
        const result = await client.call('Runtime.evaluate', { contextId: context.id, returnByValue: true,
          expression: `JSON.stringify({path:document.querySelector('#target')?.textContent,ready:!!document.querySelector('#processes[aria-busy="false"] .process'),text:document.querySelector('#processes')?.textContent,files:document.querySelector('#processes .files')?.textContent})` });
        const state = JSON.parse(result.result.value);
        if (state.ready && state.path?.replace(/\\/g, '/').toLowerCase() === lockFixture.folder.replace(/\\/g, '/').toLowerCase() && state.text.includes(`PID ${lockFixture.pid}`) && state.files.includes('Preview-Plugin.dll')) return { target, client, context };
      }
    }
    return false;
  });
  const click = async selector => {
    const result = await found.client.call('Runtime.evaluate', { contextId: found.context.id, returnByValue: true,
      expression: `(${((selector) => { const node = document.querySelector(selector); if (!node || node.disabled) throw new Error('The lock preview control is unavailable.'); node.click(); }).toString()})(${JSON.stringify(selector)})` });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  };
  await click('#details');
  if (capture.lockAction === 'inspect') return;
  await click(capture.lockAction === 'confirmation' ? '[data-action="unlock"]' : '[data-action="other"]');
  if (capture.lockAction !== 'destination') return;
  const target = (await targets()).find(target => target.id === found.target.parentId);
  const page = await clientFor(target);
  await waitFor(async () => {
    const result = await page.call('Runtime.evaluate', { returnByValue: true, expression: "Boolean(document.querySelector('.quick-input-widget .monaco-list-row'))" });
    return result.result.value;
  });
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(async () => {
    const result = await page.call('Runtime.evaluate', { returnByValue: true, expression: "document.querySelector('.quick-input-widget')?.textContent.includes('Full destination path')" });
    return result.result.value;
  });
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.call('Input.insertText', { text: lockFixture.destination });
  await waitFor(async () => {
    const result = await page.call('Runtime.evaluate', { returnByValue: true, expression: `document.querySelector('.quick-input-widget input')?.value === ${JSON.stringify(lockFixture.destination)}` });
    return result.result.value;
  });
}

module.exports = { createLockFixture, prepareLockCapture };
