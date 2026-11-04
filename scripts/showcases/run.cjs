/* global document, KeyboardEvent */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const output = path.join(repository, 'TMP/showcases');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const filename = (scene, capture) => `windows-en-dark-${scene.id}${capture ? `-${capture.id}` : ''}.png`;

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('The showcase catalog is empty.');
  const ids = new Set();
  const identifier = id => { if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid showcase identifier.'); };
  for (const scene of catalog) {
    identifier(scene.id);
    if (ids.has(scene.id)) throw new Error(`Duplicate showcase: ${scene.id}`);
    if (scene.parentId && !ids.has(scene.parentId)) throw new Error('A parent must precede its subsections.');
    ids.add(scene.id);
    if (!scene.title?.trim() || !scene.description?.trim()) throw new Error('A title and description are required.');
    if (scene.paths?.length !== 2 || scene.paths.some(p => !path.win32.isAbsolute(p))) throw new Error('Two absolute demo paths are required.');
    if (!scene.captures?.length) throw new Error('At least one capture is required.');
    const captures = new Set();
    for (const capture of scene.captures) {
      identifier(capture.id);
      if (captures.has(capture.id)) throw new Error('Duplicate capture identifier.');
      captures.add(capture.id);
      if (!capture.expect || !capture.text) throw new Error('Capture readiness criteria are required.');
      if (capture.action && !['mkdir', 'copy', 'move', 'rename-one', 'search', 'view'].includes(capture.action)) throw new Error('Unsupported showcase action.');
    }
  }
  return catalog;
}

function assertProductState(state, scene, capture = scene) {
  if (state.platform !== 'win32' || state.realFilesystem !== true) throw new Error('A real Windows product view is required.');
  if (state.iconsReady !== true) throw new Error('Native Windows file icons are not ready.');
  if (state.pending || !state.visible || !state.text?.includes(capture.text)) throw new Error('The expected mask is not ready.');
  if (!state.paths || scene.paths.some((p, i) => normalize(p) !== normalize(state.paths[i] || ''))) throw new Error('The expected directories are not loaded.');
}

async function waitFor(read, timeout = 30000, interval = 100) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try { const value = await read(); if (value) return value; } catch (failure) { error = failure; }
    await delay(interval);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for the showcase state.${error ? ` ${error.message}` : ''}`);
}

function buildManifest(catalog, images, host) {
  return {
    schemaVersion: 1, title: 'Bitfroest.fs showcases',
    description: 'The main file manager followed by its individual functions.',
    platform: 'win32', language: 'en', theme: 'Default Dark Modern', compact: true,
    host, generatedAt: new Date().toISOString(),
    sections: catalog.map(scene => ({ id: scene.id, ...(scene.parentId ? { parentId: scene.parentId } : {}),
      title: scene.title, description: scene.description,
      images: scene.captures.map(capture => {
        const image = images.find(item => item.scene === scene.id && item.capture === capture.id);
        if (!image) throw new Error(`Missing capture: ${scene.id}/${capture.id}`);
        return { file: image.file, alt: capture.alt || scene.title, width: image.width, height: image.height };
      }) }))
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map(), contexts = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') contexts.push(message.params.context);
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  };
  ws.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The render connection closed.')); } pending.clear(); };
  return { contexts, close: () => ws.close(), call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Render command timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Showcase rendering requires Windows.');
  const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const code = option('--code'), demo = option('--demo');
  if (!code || !fs.existsSync(code) || !demo) throw new Error('Specify --code and --demo.');
  const catalog = validateCatalog(JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8').replaceAll('${demo}', demo.replace(/\\/g, '/'))));
  const selected = option('--scene');
  const included = new Set();
  for (let scene = catalog.find(item => item.id === selected); scene; scene = catalog.find(item => item.id === scene.parentId)) included.add(scene.id);
  const scenes = selected ? catalog.filter(scene => included.has(scene.id)) : catalog;
  if (!scenes.length) throw new Error(`Unknown showcase: ${selected}`);
  for (const scene of scenes) for (const folder of scene.paths) if (!fs.statSync(folder).isDirectory()) throw new Error(`Missing demo directory: ${folder}`);
  const run = path.join(output, 'runs', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(run, 'profile/User'), { recursive: true });
  fs.writeFileSync(path.join(run, 'profile/User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'bitfroest.language': 'en'
  }));
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
  fs.writeFileSync(path.join(run, 'launch.json'), JSON.stringify({ code, repository, tests: path.join(__dirname, 'host-tests.cjs'), port }));
  const log = fs.openSync(path.join(run, 'host.log'), 'w');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'desktop.ps1'), '-RunDirectory', run],
    { windowsHide: true, env: { ...process.env, BFS_SHOWCASE_RUN: run }, stdio: ['ignore', log, log] });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const connections = [];
  let manifest, failure;
  try {
    const host = await waitFor(() => fs.existsSync(path.join(run, 'ready.json')) && JSON.parse(fs.readFileSync(path.join(run, 'ready.json'), 'utf8')), 90000);
    if (normalize(host.source) !== normalize(repository) || host.platform !== 'win32') throw new Error('The wrong product host was loaded.');
    const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then(result => result.json());
    const target = await waitFor(async () => (await targets()).find(item => item.type === 'iframe' && item.url.includes('extensionId=bitfroest.bitfroest-fs-prototype')));
    const view = await connect(target.webSocketDebuggerUrl); connections.push(view); await view.call('Runtime.enable');
    let context;
    const evaluate = async (fn, ...values) => {
      const result = await view.call('Runtime.evaluate', { contextId: context.id, expression: `(${fn.toString()})(${values.map(value => JSON.stringify(value)).join(',')})`, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor(async () => {
      for (const candidate of view.contexts) {
        context = candidate;
        if (await evaluate(() => Boolean(document.querySelector('[data-path-edit]')))) return true;
      }
      return false;
    });
    const pageTarget = await waitFor(async () => (await targets()).find(item => item.type === 'page' && item.id === target.parentId));
    const page = await connect(pageTarget.webSocketDebuggerUrl); connections.push(page);
    const images = [];
    for (const scene of scenes) {
      await evaluate(() => { document.querySelector('dialog[open] #modal-cancel')?.click(); });
      for (const [side, directory] of scene.paths.entries()) {
        await evaluate((side, directory) => {
          const pane = document.querySelector(`[data-pane="${side}"]`); pane.querySelector('[data-path-edit]').click();
          const input = pane.querySelector('.path-input'); input.value = directory;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }, side, directory);
        await waitFor(() => evaluate((side, directory) => {
          const pane = document.querySelector(`[data-pane="${side}"]`);
          return pane.querySelector('.path-breadcrumbs')?.title.split('\n')[0].replace(/\\/g, '/').toLowerCase() === directory.replace(/\\/g, '/').toLowerCase() && !pane.querySelector('[data-directory-loading]');
        }, side, directory));
      }
      for (const capture of scene.captures) {
        await evaluate(() => { document.querySelector('dialog[open] #modal-cancel')?.click(); });
        if (capture.action) await evaluate(action => {
          const button = document.querySelector(`[data-action="${action}"]`);
          if (!button) throw new Error(`Showcase control missing: ${action}`);
          button.click();
        }, capture.action);
        await waitFor(async () => {
          const state = await evaluate(selector => {
            const element = document.querySelector(selector), rect = element?.getBoundingClientRect();
            return { platform: document.body.dataset.platform, realFilesystem: JSON.parse(document.body.dataset.initialState || 'null')?.realFilesystem,
              paths: [...document.querySelectorAll('.pane .path-breadcrumbs')].map(item => item.title.split('\n')[0]),
              visible: Boolean(rect?.width && rect?.height), text: selector === '.pane' ? document.body.innerText : element?.textContent,
              iconsReady: !document.querySelector('[data-file-row][data-id] .fileicon:not(.native-icon)') &&
                [...document.querySelectorAll('img.native-icon')].every(image => image.complete && image.naturalWidth > 0),
              pending: Boolean(document.querySelector('[data-directory-loading], .codicon-modifier-spin')) };
          }, capture.expect);
          assertProductState(state, scene, capture); return true;
        });
        await waitFor(async () => {
          const result = await page.call('Runtime.evaluate', { expression: 'JSON.stringify({status:[...document.querySelectorAll(".part.statusbar")].some(e=>e.getBoundingClientRect().height>0),sidebar:[...document.querySelectorAll(".part.sidebar")].some(e=>e.getBoundingClientRect().width>0)})', returnByValue: true });
          const chrome = JSON.parse(result.result.value); return !chrome.status && !chrome.sidebar;
        });
        await evaluate(async () => { await document.fonts.ready; });
        const shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const bytes = Buffer.from(shot.data, 'base64'), file = filename(scene, capture);
        fs.writeFileSync(path.join(run, file), bytes);
        images.push({ scene: scene.id, capture: capture.id, file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
        console.log(`Rendered ${file}`);
      }
    }
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repository, encoding: 'utf8' });
    manifest = buildManifest(scenes, images, { ...host, productVersion: require('../../package.json').version,
      commit: revision.stdout?.trim(), workingTreeDirty: Boolean(status.stdout?.trim()) });
    fs.writeFileSync(path.join(run, 'showcases.json'), JSON.stringify(manifest, null, 2));
  } catch (error) {
    failure = error;
  } finally {
    for (const connection of connections) connection.close();
    fs.writeFileSync(path.join(run, 'stop'), '');
    let cleanupTimer;
    const exitCode = await Promise.race([exited, new Promise(resolve => { cleanupTimer = setTimeout(() => resolve('timeout'), 20000); })]);
    clearTimeout(cleanupTimer);
    fs.closeSync(log);
    if (exitCode !== 0) failure = new Error(`Showcase desktop cleanup failed (${exitCode}); inspect ${run}`, { cause: failure });
  }
  if (failure) throw failure;
  for (const section of manifest.sections) for (const image of section.images) fs.copyFileSync(path.join(run, image.file), path.join(output, image.file));
  fs.copyFileSync(path.join(run, 'showcases.json'), path.join(output, 'showcases.json'));
  console.log(`Showcase manifest: ${path.join(output, 'showcases.json')}`);
}

module.exports = { validateCatalog, filename, assertProductState, waitFor, buildManifest };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
