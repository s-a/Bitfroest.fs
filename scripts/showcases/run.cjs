/* global document, KeyboardEvent, window */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const output = path.join(repository, '.tmp/showcases');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const filename = (scene, capture) => `${String(capture?.sequence || 1).padStart(4, '0')}-windows-en-dark-${scene.id}${capture ? `-${capture.id}` : ''}.${capture?.format === 'gif' ? 'gif' : 'png'}`;
function numberCatalog(catalog) {
  let sequence = 0;
  for (const scene of catalog) for (const capture of scene.captures) capture.sequence = ++sequence;
  return catalog;
}
function assertSurfaceState(state, capture) {
  if (!state.visible || !state.ready || !state.text?.includes(capture.text)) throw new Error('The requested surface is not ready.');
  if (capture.surface === 'editor' ? state.kind !== 'editor' || !state.diff : state.owner !== 'bitfroest.bitfroest-fs-prototype') throw new Error('The requested product surface was not observed.');
}
const safeActions = ['mkdir', 'copy', 'move', 'rename-one', 'search', 'view', 'new-file', 'rename', 'pack', 'unpack', 'delete', 'delete-permanently', 'select-group', 'unselect-group', 'search-separate', 'clear', 'refresh'];
const safeListerActions = ['mode:text', 'mode:binary', 'mode:hex', 'mode:html', 'mode:unicode', 'mode:utf8', 'find', 'manual'];

function parseOptions(args, defaultCode, root = repository) {
  const options = { code: defaultCode, demo: path.join(root, '.tmp/demo'), selected: undefined };
  const names = { '--code': 'code', '--demo': 'demo', '--scene': 'selected' };
  for (let i = 0; i < args.length; i += 2) {
    if (!Object.hasOwn(names, args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
    options[names[args[i]]] = args[i + 1];
  }
  return options;
}

function findCode() {
  const located = spawnSync('where.exe', ['code.cmd'], { encoding: 'utf8', windowsHide: true });
  const commands = located.stdout?.trim().split(/\r?\n/).filter(Boolean) || [];
  const candidates = commands.map(command => path.resolve(path.dirname(command), '..', 'Code.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Microsoft VS Code/Code.exe'));
  return candidates.find(candidate => fs.existsSync(candidate));
}

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
    if (scene.status && !['pending', 'excluded'].includes(scene.status)) throw new Error('Invalid inventory status.');
    if (scene.status && !scene.reason?.trim()) throw new Error('An inventory status requires a reason.');
    if (scene.status && scene.captures?.length) throw new Error('Inventory-only masks cannot have active captures.');
    if (!scene.status && !scene.captures?.length) throw new Error('At least one capture is required.');
    const captures = new Set();
    for (const capture of scene.captures) {
      identifier(capture.id);
      if (captures.has(capture.id)) throw new Error('Duplicate capture identifier.');
      captures.add(capture.id);
      if (!capture.expect || !capture.text) throw new Error('Capture readiness criteria are required.');
      if (capture.action && !safeActions.includes(capture.action)) throw new Error('Unsupported showcase action.');
      if (capture.listerAction && !safeListerActions.includes(capture.listerAction)) throw new Error('Unsupported viewer action.');
      if (capture.select && (!['string'].includes(typeof capture.select.name) || ![0, 1].includes(capture.select.side ?? 0))) throw new Error('Invalid demo selection.');
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

function buildManifest(catalog, images, host, previous) {
  return {
    schemaVersion: 1, title: 'Bitfroest.fs showcases',
    description: 'The main file manager followed by its individual functions.',
    platform: 'win32', language: 'en', theme: 'Default Dark Modern', compact: true,
    host, generatedAt: new Date().toISOString(),
    sections: catalog.map(scene => {
      if (!scene.status && !images.some(image => image.scene === scene.id)) {
        const saved = previous?.sections?.find(section => section.id === scene.id && section.status === 'rendered');
        if (saved) return saved;
        return { id: scene.id, ...(scene.parentId ? { parentId: scene.parentId } : {}), title: scene.title, description: scene.description,
          status: 'unrecorded', reason: 'This scene has not been recorded in this output set.', images: [] };
      }
      return { id: scene.id, ...(scene.parentId ? { parentId: scene.parentId } : {}),
      title: scene.title, description: scene.description,
      kind: scene.kind || 'mask', ...(!scene.status ? { host, recordedAt: new Date().toISOString() } : {}),
      status: scene.status || 'rendered', ...(scene.reason ? { reason: scene.reason } : {}),
      ...(scene.sources ? { sources: scene.sources } : {}),
      images: scene.captures.map(capture => {
        const image = images.find(item => item.scene === scene.id && item.capture === capture.id);
        if (!image) throw new Error(`Missing capture: ${scene.id}/${capture.id}`);
        return { file: image.file, alt: capture.alt || scene.title, width: image.width, height: image.height,
          ...(capture.format === 'gif' ? { format: 'gif', annotation: 'Documentation pointer; product response recorded live.' } : {}),
          ...(capture.surface ? { surface: capture.surface, layout: 'native-editor' } : { layout: 'compact' }) };
      }) };
    })
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map(), contexts = [], listeners = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') contexts.push(message.params.context);
    for (const listener of listeners.get(message.method) || []) listener(message.params);
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  };
  ws.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The render connection closed.')); } pending.clear(); };
  return { contexts, close: () => ws.close(), on(method, listener) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(listener);
    return () => listeners.get(method).delete(listener);
  }, call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Render command timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Showcase rendering requires Windows.');
  const { code, demo, selected } = parseOptions(process.argv.slice(2), findCode());
  if (!code || !fs.existsSync(code) || !demo) throw new Error('Specify --code and --demo.');
  const catalog = numberCatalog(validateCatalog(JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8').replaceAll('${demo}', demo.replace(/\\/g, '/')))));
  const scenes = selected ? catalog.filter(scene => scene.id === selected) : catalog;
  if (!scenes.length) throw new Error(`Unknown showcase: ${selected}`);
  for (const scene of scenes.filter(item => !item.status)) for (const folder of scene.paths) if (!fs.statSync(folder).isDirectory()) throw new Error(`Missing demo directory: ${folder}`);
  const run = path.join(output, 'runs', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(run, 'profile/User'), { recursive: true });
  fs.writeFileSync(path.join(run, 'profile/User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'bitfroest.language': 'en',
    'bitfroest.files.useSystemContextMenu': false, 'git.openRepositoryInParentFolders': 'never',
    'workbench.statusBar.visible': false, 'workbench.activityBar.location': 'hidden',
    'workbench.secondarySideBar.defaultVisibility': 'hidden'
  }));
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
  fs.writeFileSync(path.join(run, 'launch.json'), JSON.stringify({ code, repository, tests: path.join(__dirname, 'host-tests.cjs'), port }));
  const log = fs.openSync(path.join(run, 'host.log'), 'w');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'desktop.ps1'), '-RunDirectory', run],
    { windowsHide: true, env: { ...process.env, BFS_SHOWCASE_RUN: run }, stdio: ['ignore', log, log] });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const connections = [];
  let manifest, failure, diagnostic, stage = 'startup';
  try {
    const host = await waitFor(() => fs.existsSync(path.join(run, 'ready.json')) && JSON.parse(fs.readFileSync(path.join(run, 'ready.json'), 'utf8')), 90000);
    if (normalize(host.source) !== normalize(repository) || host.platform !== 'win32') throw new Error('The wrong product host was loaded.');
    const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then(result => result.json());
    const target = await waitFor(async () => (await targets()).find(item => item.type === 'iframe' && item.url.includes('extensionId=bitfroest.bitfroest-fs-prototype')));
    const view = await connect(target.webSocketDebuggerUrl); connections.push(view); await view.call('Runtime.enable');
    let context;
    const evaluate = async (fn, ...values) => {
      const result = await view.call('Runtime.evaluate', { contextId: context.id, expression: `(${fn.toString()})(${values.map(value => JSON.stringify(value)).join(',')})`, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
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
    diagnostic = async () => {
      const state = await evaluate(() => ({ saved: window.CommanderHost?.getState?.(), contexts: [...document.querySelectorAll('.pane .list')].map(item => item.dataset.vscodeContext), names: [...document.querySelectorAll('[data-file-row][data-id]')].map(item => item.title || item.querySelector('[data-cell]')?.title) }));
      fs.writeFileSync(path.join(run, 'failure-state.json'), JSON.stringify({ stage, state }, null, 2));
      const shot = await page.call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(run, 'failure.png'), Buffer.from(shot.data, 'base64'));
    };
    let commandSequence = 0;
    const invoke = async (command, args = []) => {
      const id = String(++commandSequence);
      const commandFile = path.join(run, `command-${id}.json`), replyFile = path.join(run, `reply-${id}.json`);
      fs.writeFileSync(`${commandFile}.writing`, JSON.stringify({ command, args }));
      fs.renameSync(`${commandFile}.writing`, commandFile);
      const reply = await waitFor(() => fs.existsSync(replyFile) && JSON.parse(fs.readFileSync(replyFile, 'utf8')));
      if (reply.error) throw new Error(reply.error);
      return reply;
    };
    const images = [];
    for (const scene of scenes) {
      if (scene.status) continue;
      stage = `${scene.id}: navigation`;
      await invoke('showcase.focus-main');
      if (scene.captures.some(capture => ['bitfroest.gitHistory', 'bitfroest.gitDiff'].includes(capture.command))) await invoke('showcase.prepare-repository', [scene.paths[0]]);
      await evaluate(() => {
        document.querySelector('dialog[open] #modal-cancel')?.click();
        for (const button of document.querySelectorAll('[data-search-close], [data-lister-close]')) button.click();
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      for (const [side, directory] of scene.paths.entries()) {
        await evaluate((side, directory) => {
          const pane = document.querySelector(`[data-pane="${side}"]`); pane.querySelector('[data-path-edit]').click();
          const input = pane.querySelector('.path-input'); input.value = directory;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }, side, directory);
        await waitFor(() => evaluate((side, directory) => {
          const pane = document.querySelector(`[data-pane="${side}"]`);
          return pane.querySelector('.path-breadcrumbs')?.title.split('\n')[0].replace(/\\/g, '/').toLowerCase() === directory.replace(/\\/g, '/').toLowerCase() && !document.querySelector('[data-directory-loading], .codicon-modifier-spin');
        }, side, directory));
      }
      for (const capture of scene.captures) {
        stage = `${scene.id}/${capture.id}: selection`;
        await evaluate(() => { document.querySelector('dialog[open] #modal-cancel')?.click(); });
        if (capture.select) await waitFor(() => evaluate(({ side = 0, name }) => {
          const pane = document.querySelector(`[data-pane="${side}"]`);
          const row = [...pane.querySelectorAll('[data-file-row][data-id]')].find(item => item.title === name || item.querySelector('[data-cell]')?.title === name);
          if (!row) {
            const grid = window.agGrid.getGridApi(`files-${side}`);
            grid.forEachNodeAfterFilterAndSort(node => { if (node.data?.name === name) grid.ensureIndexVisible(node.rowIndex, 'middle'); });
            return false;
          }
          (row.querySelector('[data-filename]') || row).click(); pane.querySelector('.list').focus(); return true;
        }, capture.select));
        if (capture.action) await invoke(`bitfroest.${capture.action}`);
        if (capture.command) {
          stage = `${scene.id}/${capture.id}: command ${capture.command}`;
          const args = capture.command === 'bitfroest.gitHistory' || capture.command === 'bitfroest.gitDiff'
            ? [await waitFor(() => evaluate(() => {
              const value = document.querySelector('.pane.active .list')?.dataset.vscodeContext;
              const context = value && JSON.parse(value); return context?.gitHistory ? context : false;
            }))] : [];
          await invoke(capture.command, args);
        }
        if (capture.listerAction) await invoke('bitfroest.lister-action', [capture.listerAction]);
        for (const selector of capture.click || []) await evaluate(selector => {
          const button = document.querySelector(selector);
          if (!button || !button.getBoundingClientRect().width || button.disabled || button.type === 'submit') throw new Error(`Showcase control unavailable: ${selector}`);
          button.click();
        }, selector);
        if (capture.surface) {
          stage = `${scene.id}/${capture.id}: surface ${capture.surface}`;
          const { captureSurface } = require('./surfaces.cjs');
          const result = await captureSurface({ capture, targets, connect, connections, invoke, waitFor });
          const bytes = Buffer.from(result.data, 'base64'), file = filename(scene, capture);
          fs.writeFileSync(path.join(run, file), bytes);
          images.push({ scene: scene.id, capture: capture.id, file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
          console.log(`Rendered ${file}`); continue;
        }
        await waitFor(async () => {
          const state = await evaluate(selector => {
            const element = document.querySelector(selector), rect = element?.getBoundingClientRect();
            const saved = window.CommanderHost?.getState?.();
            return { platform: document.body.dataset.platform, realFilesystem: JSON.parse(document.body.dataset.initialState || 'null')?.realFilesystem,
              paths: saved?.panes?.map(pane => pane.tabs[pane.tab]) || [...document.querySelectorAll('.pane .path-breadcrumbs')].map(item => item.title.split('\n')[0]),
              visible: Boolean(rect?.width && rect?.height), text: selector === '.pane' ? document.body.innerText : element?.value || element?.textContent,
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
        if (capture.format === 'gif') {
          const { recordGesture } = require('./gestures.cjs');
          const file = filename(scene, capture);
          const size = await recordGesture({ capture, scene, view, page, target, evaluate, invoke, run, file, waitFor });
          images.push({ scene: scene.id, capture: capture.id, file, ...size });
          console.log(`Rendered ${file}`); continue;
        }
        const shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const bytes = Buffer.from(shot.data, 'base64'), file = filename(scene, capture);
        fs.writeFileSync(path.join(run, file), bytes);
        images.push({ scene: scene.id, capture: capture.id, file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
        console.log(`Rendered ${file}`);
      }
    }
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repository, encoding: 'utf8' });
    const previousFile = path.join(output, 'showcases.json');
    const previous = selected && fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : undefined;
    manifest = buildManifest(catalog, images, { ...host, productVersion: require('../../package.json').version,
      commit: revision.stdout?.trim(), workingTreeDirty: Boolean(status.stdout?.trim()) }, previous);
    manifest.interactions = require('./inventory.cjs').interactionInventory(manifest);
    fs.writeFileSync(path.join(run, 'showcases.json'), JSON.stringify(manifest, null, 2));
  } catch (error) {
    try { await diagnostic?.(); } catch { /* Retain the original capture failure. */ }
    failure = new Error(`${stage}: ${error.message}; details: ${run}`, { cause: error });
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
  for (const section of manifest.sections) for (const image of section.images) {
    const fresh = path.join(run, image.file); if (fs.existsSync(fresh)) fs.copyFileSync(fresh, path.join(output, image.file));
  }
  fs.copyFileSync(path.join(run, 'showcases.json'), path.join(output, 'showcases.json'));
  console.log(`Showcase manifest: ${path.join(output, 'showcases.json')}`);
}

module.exports = { validateCatalog, filename, numberCatalog, assertSurfaceState, assertProductState, waitFor, buildManifest, parseOptions, safeActions, safeListerActions };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
