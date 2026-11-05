/* global document, KeyboardEvent, window, getComputedStyle */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const output = path.join(repository, '.tmp/showcases');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const filename = (scene, capture) => `${String(capture?.sequence || 1).padStart(4, '0')}-windows-en-dark-${scene.id}${capture ? `-${capture.id}` : ''}.${capture?.format || 'png'}`;
function numberCatalog(catalog) {
  let sequence = 0;
  for (const scene of catalog) for (const capture of scene.captures) capture.sequence = ++sequence;
  return catalog;
}
function profileSettings(demo) {
  return {
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'bitfroest.language': 'en',
    'bitfroest.files.useSystemContextMenu': false, 'git.openRepositoryInParentFolders': 'never',
    'workbench.statusBar.visible': false, 'workbench.activityBar.location': 'hidden',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'window.dialogStyle': 'custom',
    'bitfroest.favorites.items': [
      ['sources', 'Project sources', 'left/bitfroest.fs'], ['documents', 'Documents', 'left/documents'], ['delivery', 'Delivery inbox', 'right/inbox']
    ].map(([id, name, folder]) => ({ id, name, type: 'favorite', parent: null, path: path.join(demo, folder) }))
  };
}
function renumberManifest(catalog, previous) {
  return { ...previous, sections: previous.sections.map(section => {
    const scene = catalog.find(scene => scene.id === section.id);
    return { ...section, images: section.images.map(image => {
      const capture = scene?.captures.find(capture => image.file.endsWith(`-${scene.id}-${capture.id}.${capture.format || 'png'}`));
      return capture ? { ...image, file: filename(scene, capture), ...(image.fallback ? { fallback: filename(scene, capture).replace(/\.webm$/, '.gif') } : {}) } : image;
    }) };
  }) };
}
function clickControl(selector, root = document) {
  const button = root.querySelector(selector);
  if (!button || !button.getBoundingClientRect().width || button.disabled || button.type === 'submit' && button.form) throw new Error(`Showcase control unavailable: ${selector}`);
  const MouseEvent = button.ownerDocument.defaultView.MouseEvent;
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
  button.focus({ preventScroll: true });
  if (!button.isConnected) throw new Error(`Showcase control replaced during focus: ${selector}`);
  button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  button.click();
}
function assertSurfaceState(state, capture) {
  if (!state.visible || !state.ready || !state.text?.includes(capture.text)) throw new Error('The requested surface is not ready.');
  if (capture.surface === 'editor' ? state.kind !== 'editor' || !state.diff : ['quickpick', 'inputbox', 'confirmation'].includes(capture.surface) ? state.kind !== capture.surface : state.owner !== 'bitfroest.bitfroest-fs-prototype') throw new Error('The requested product surface was not observed.');
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
      if (capture.format && !['png', 'gif', 'webm'].includes(capture.format)) throw new Error('Unsupported recording format.');
      if (capture.intro !== undefined && (typeof capture.intro !== 'string' || !capture.intro.trim() || capture.intro.length > 120 || /[\u0000-\u001f\u007f]/.test(capture.intro))) throw new Error('Invalid showcase introduction.');
      if (capture.steps) {
        const surfacePreparation = Boolean(capture.surface);
        const unsupportedSetup = capture.gesture || capture.action || capture.click ||
          (!surfacePreparation && (capture.select || capture.command));
        if (!['gif', 'webm'].includes(capture.format) || unsupportedSetup) throw new Error('A recording sequence requires an animation capture with only supported surface preparation.');
        require('./sequence.cjs').validateSequence(capture.steps);
      }
      if (['gif', 'webm'].includes(capture.format) && !capture.steps && !['path-copy', 'ctrl-l', 'right-selection', 'right-drag'].includes(capture.gesture)) throw new Error('An animation requires a sequence or known gesture.');
      if (!capture.expect || !capture.text) throw new Error('Capture readiness criteria are required.');
      if (capture.action && !safeActions.includes(capture.action)) throw new Error('Unsupported showcase action.');
      if (capture.lockAction && !['inspect', 'actions', 'destination', 'confirmation'].includes(capture.lockAction)) throw new Error('Unsupported lock documentation preview.');
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
        return { file: image.file, ...(image.fallback ? { fallback: image.fallback } : {}), alt: capture.alt || scene.title, width: image.width, height: image.height,
          ...(['gif', 'webm'].includes(capture.format) ? { format: capture.format, annotation: 'Documentation pointer; product response recorded live.' } : {}),
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
  const scenes = selected ? catalog.filter(scene => selected.split(',').includes(scene.id)) : catalog;
  if (!scenes.length) throw new Error(`Unknown showcase: ${selected}`);
  if (scenes.some(scene => scene.id.startsWith('quick-diff-'))) require('./quick-diff-fixture.cjs').prepareQuickDiff(demo);
  if (scenes.some(scene => scene.id === 'xray-click')) {
    const sample = path.join(demo, 'left', 'X-Ray-Sample.sql');
    const content = "-- Active demonstration projects\nSELECT project_name, owner_name, updated_at\nFROM projects\nWHERE active = 1\n  AND area = 'Demo'\nORDER BY updated_at DESC;\n";
    if (fs.existsSync(sample) && fs.readFileSync(sample, 'utf8') !== content) throw new Error('The X-Ray SQL fixture contains unexpected data.');
    if (!fs.existsSync(sample)) fs.writeFileSync(sample, content);
  }
  for (const scene of scenes.filter(item => !item.status)) for (const folder of scene.paths) if (!fs.statSync(folder).isDirectory()) throw new Error(`Missing demo directory: ${folder}`);
  if (scenes.some(scene => scene.id === 'xray-hover')) {
    const sample = path.join(demo, 'left', 'X-Ray-Sample.ps1');
    const content = '# Sample project report\nparam([string]$Project = "Demo")\n\n$files = @(\n    "Configuration.json",\n    "Readme.md",\n    "Build.ps1"\n)\n\nforeach ($file in $files) {\n    Write-Output "$Project : $file"\n}\n';
    if (fs.existsSync(sample) && fs.readFileSync(sample, 'utf8') !== content) throw new Error('The X-Ray demo fixture contains unexpected data.');
    if (!fs.existsSync(sample)) fs.writeFileSync(sample, content);
  }
  const run = path.join(output, 'runs', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(run, 'profile/User'), { recursive: true });
  fs.writeFileSync(path.join(run, 'profile/User/settings.json'), JSON.stringify(profileSettings(demo)));
  const driver = path.join(run, 'extensions/bitfroest.showcase-host');
  fs.mkdirSync(driver, { recursive: true });
  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'showcase-host', publisher: 'bitfroest', version: '0.0.1', engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs' }));
  fs.writeFileSync(path.join(driver, 'extension.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'host-tests.cjs'))}).run().catch(error=>require('node:fs').writeFileSync(${JSON.stringify(path.join(run, 'driver-error.log'))},error.stack||String(error)));};`);
  const previousFile = path.join(output, 'showcases.json');
  const original = selected && fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : undefined;
  const previous = original && renumberManifest(catalog, original);
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
  fs.writeFileSync(path.join(run, 'launch.json'), JSON.stringify({ code, repository, demo, tests: path.join(__dirname, 'host-tests.cjs'), port }));
  const log = fs.openSync(path.join(run, 'host.log'), 'w');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'desktop.ps1'), '-RunDirectory', run],
    { windowsHide: true, env: { ...process.env, BFS_SHOWCASE_RUN: run }, stdio: ['ignore', log, log] });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const connections = [];
  let lockFixture;
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
    const pointerInputs = [];
    async function xrayPointer(selector, name, click = true) {
      const point = await waitFor(() => evaluate(({ selector, name }) => {
        let element = document.querySelector(selector);
        if (name) element = [...element.querySelectorAll('[data-file-row][data-id]')].find(row => row.title === name || row.querySelector('[data-cell]')?.title === name)?.querySelector('[data-filename]');
        const rect = element?.getBoundingClientRect();
        return rect?.width && rect?.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
      }, { selector, name }));
      const position = point;
      for (const type of click ? ['mouseMoved', 'mousePressed', 'mouseReleased'] : ['mouseMoved']) {
        const event = { type, ...position, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 };
        await view.call('Input.dispatchMouseEvent', event); pointerInputs.push({ ...event, selector, name });
      }
      fs.writeFileSync(path.join(run, 'xray-pointer-inputs.json'), JSON.stringify(pointerInputs, null, 2));
      const observed = await evaluate(() => window.__showcasePointerEvents || []);
      fs.writeFileSync(path.join(run, 'pointer-events.json'), JSON.stringify(observed, null, 2));
    }
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
    if (scenes.some(scene => scene.captures.some(capture => capture.lockAction))) lockFixture = await require('./locks.cjs').createLockFixture(demo);
    for (const scene of scenes) {
      if (scene.status) continue;
      stage = `${scene.id}: navigation`;
      if (lockFixture) await invoke('showcase.close-locks');
      await invoke('showcase.focus-main');
      if (scene.captures.some(capture => ['bitfroest.gitHistory', 'bitfroest.gitDiff', 'bitfroest.showLocalBranches'].includes(capture.command))) await invoke('showcase.prepare-repository', [scene.paths[0]]);
      if (scene.captures.some(capture => capture.quickDiffMode)) await invoke('showcase.prepare-repository', [path.join(demo, 'quick-diff-list')]);
      await evaluate(() => {
        document.querySelector('dialog[open] #modal-cancel')?.click();
        for (const button of document.querySelectorAll('[data-search-close], [data-lister-close]')) button.click();
        document.querySelector('[data-xray]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.querySelector('[data-quick-diff]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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
        if (capture.steps && !capture.surface) {
          stage = `${scene.id}/${capture.id}: recording sequence`;
          const { recordGesture } = require('./gestures.cjs');
          const file = filename(scene, capture);
          const size = await recordGesture({ capture, scene, view, page, target, evaluate, invoke, run, file, waitFor });
          images.push({ scene: scene.id, capture: capture.id, file, ...size });
          console.log(`Rendered ${file}`); continue;
        }
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
        if (capture.xrayMode) {
          await xrayPointer('[data-pane="0"] [data-xray-toggle]');
          if (capture.xrayMode === 'hover') {
            await xrayPointer('[data-pane="0"] [data-xray-toggle]');
          }
          await xrayPointer('[data-pane="0"]', capture.xrayFile, capture.xrayMode === 'click');
        }
        if (capture.quickDiffMode) {
          stage = `${scene.id}/${capture.id}: first Quick Diff activation`;
          await evaluate(() => {
            window.__showcaseQuickDiffError = null;
            window.__showcasePointerEvents = [];
            for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, event => { window.__showcasePointerEvents.push({ type, tag: event.target.tagName, button: Boolean(event.target.closest('[data-quick-diff-toggle]')), target: event.target.className?.baseVal || event.target.className }); }, true);
            window.addEventListener('message', event => { if (event.data?.type === 'quick-diff-result' && !event.data.ok) window.__showcaseQuickDiffError = event.data.error; });
          });
          await xrayPointer('[data-pane="0"] [data-quick-diff-toggle]');
          const opened = await waitFor(() => evaluate(() => window.__showcaseQuickDiffError || Boolean(document.querySelector('[data-quick-diff-list] [role="grid"]'))));
          if (typeof opened === 'string') throw new Error(opened);
          if (capture.quickDiffMode === 'repository') {
            await xrayPointer('[data-pane="0"] [data-quick-diff-toggle]');
            await waitFor(() => evaluate(() => Boolean(document.querySelector('[data-quick-diff-list] [data-diff-path="src/Orders.sql"]'))));
          }
          await xrayPointer('[data-quick-diff-list] [data-diff-path="src/Orders.sql"] .quick-diff-name');
        }
        if (capture.action) await invoke(`bitfroest.${capture.action}`);
        if (capture.command) {
          stage = `${scene.id}/${capture.id}: command ${capture.command}`;
          if (capture.surface === 'quickpick') {
            await invoke('showcase.prepare-editor');
            await waitFor(() => evaluate(() => Boolean(document.querySelector('.pane.active [data-git-branch][aria-busy="false"]'))));
          }
          const args = capture.command === 'bitfroest.gitHistory' || capture.command === 'bitfroest.gitDiff'
            ? [await waitFor(() => evaluate(() => {
              const value = document.querySelector('.pane.active .list')?.dataset.vscodeContext;
              const context = value && JSON.parse(value); return context?.gitHistory ? context : false;
            }))] : [];
          await invoke(capture.command, args);
        }
        if (capture.lockAction) await require('./locks.cjs').prepareLockCapture({ capture, lockFixture, targets, connect, connections, waitFor });
        if (capture.listerAction) await invoke('bitfroest.lister-action', [capture.listerAction]);
        for (const selector of capture.click || []) await evaluate(clickControl, selector);
        if (capture.surface) {
          stage = `${scene.id}/${capture.id}: surface ${capture.surface}`;
          const { captureSurface } = require('./surfaces.cjs');
          const file = filename(scene, capture);
          const result = await captureSurface({ capture, targets, connect, connections, invoke, waitFor, run, file });
          if (['gif', 'webm'].includes(capture.format)) {
            const bytes = Buffer.from(result.data, 'base64');
            fs.writeFileSync(path.join(run, file), bytes);
            const fallback = result.fallback ? filename(scene, { ...capture, format: 'gif' }) : undefined;
            if (fallback) fs.writeFileSync(path.join(run, fallback), Buffer.from(result.fallback, 'base64'));
            images.push({ scene: scene.id, capture: capture.id, file, ...(fallback ? { fallback } : {}), width: result.width, height: result.height });
            console.log(`Rendered ${file}`); continue;
          }
          const bytes = Buffer.from(result.data, 'base64');
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
        if (capture.quickDiffMode) await waitFor(() => evaluate(mode => {
          const source = document.querySelector('.quick-diff-source'), preview = document.querySelector('[data-quick-diff]');
          const panes = [...document.querySelectorAll('#panes > .pane')], width = panes.reduce((sum, pane) => sum + pane.getBoundingClientRect().width, 0);
          const tokens = new Set([...preview.querySelectorAll('.view-line span')].flatMap(span => [...span.classList].filter(name => /^mtk\d+$/.test(name))));
          const header = source.querySelector('.quick-diff-header'), row = source.querySelector('[data-diff-path="src/Orders.sql"]');
          const info = row.querySelector('.quick-diff-info'), cells = [...info.children].map(cell => cell.getBoundingClientRect());
          const filename = row.querySelector('[data-diff-filename]'), directory = row.querySelector('[data-diff-directory]'), rect = row.getBoundingClientRect();
          const rows = [...source.querySelectorAll('.quick-diff-row')], priority = { Modified: 0, Added: 1, Deleted: 2, Conflict: 3 };
          const ordered = rows.every((item, index) => {
            if (!index) return true;
            const previous = rows[index - 1], before = priority[previous.querySelector('[data-diff-status-cell]').textContent], after = priority[item.querySelector('[data-diff-status-cell]').textContent];
            return before < after || before === after && (Date.parse(previous.querySelector('time')?.dateTime) || -Infinity) >= (Date.parse(item.querySelector('time')?.dateTime) || -Infinity);
          });
          return source.getBoundingClientRect().width / width > .39 && source.getBoundingClientRect().width / width < .41 &&
            filename.textContent === 'Orders.sql' && directory.textContent === 'src\\' && parseFloat(getComputedStyle(directory).fontSize) < parseFloat(getComputedStyle(filename).fontSize) * .8 && header.children.length === 3 && row.children.length === 2 &&
            info.children.length === 5 && info.children[0].hasAttribute('data-diff-status-cell') && info.children[2].hasAttribute('data-modified-at') && info.children[4] === directory &&
            info.children[1].textContent === '·' && info.children[3].textContent === '·' && getComputedStyle(info).display === 'flex' &&
            getComputedStyle(row.querySelector('.quick-diff-name')).color !== getComputedStyle(info.children[0]).color && getComputedStyle(info.children[2]).color === getComputedStyle(directory).color &&
            Math.abs(filename.getBoundingClientRect().left - info.children[0].getBoundingClientRect().left) < 1 &&
            !source.querySelector('[data-diff-status="ignored"]') && !row.querySelector('.quick-diff-name').style.getPropertyValue('--file-type-color') && !row.style.getPropertyValue('--git-text-color') &&
            (mode !== 'repository' || !source.querySelector('[data-diff-path="Overview.md"] [data-diff-directory]')) &&
            rect.height >= 30 && rect.height <= 34 && cells.every((cell, index) => cell.height > 0 && cell.top >= rect.top && cell.bottom <= rect.bottom && (!index || cells[index - 1].right <= cell.left)) &&
            header.querySelector('[data-diff-sort="status"]').closest('[role="columnheader"]').getAttribute('aria-sort') === 'ascending' && ordered &&
            [...source.querySelectorAll('time')].every(time => time.textContent && time.title && !time.textContent.includes('/')) &&
            source.querySelector('[data-quick-diff-toggle]').dataset.mode === mode && source.querySelector('.quick-diff-header').textContent.includes('Status') &&
            preview.querySelector('[data-diff-summary]')?.textContent.includes('(+3 · ~2 · −0)') &&
            preview.querySelector('.line-insert,.char-insert') && preview.querySelector('.line-delete,.char-delete') && tokens.size > 1 &&
            ![...preview.querySelectorAll('.minimap')].some(node => node.getBoundingClientRect().width > 0) && Boolean(preview.querySelector('.diff-hidden-lines')) &&
            !source.querySelector('.quick-diff-row .file-icon,.quick-diff-row img,.quick-diff-row svg');
        }, capture.quickDiffMode));
        if (capture.xrayMode) await waitFor(() => evaluate(() => {
          const panes = document.querySelector('#panes'), side = panes.dataset.xraySource;
          const source = panes.querySelector(`[data-pane="${side}"]`), preview = panes.querySelector('[data-xray]');
          if (!source || !preview) return false;
          const widths = [...panes.querySelectorAll(':scope > .pane')].map(pane => pane.getBoundingClientRect().width);
          const ratio = source.getBoundingClientRect().width / widths.reduce((sum, width) => sum + width, 0);
          const tokens = new Set([...preview.querySelectorAll('.view-line span')].flatMap(span => [...span.classList].filter(name => /^mtk\d+$/.test(name))));
          return ratio > .39 && ratio < .41 && source.querySelector('.pane-metrics').getBoundingClientRect().width === 0 && source.querySelector('[data-xray-toggle]').getBoundingClientRect().width > 0 && tokens.size > 1;
        }));
        await waitFor(async () => {
          const result = await page.call('Runtime.evaluate', { expression: 'JSON.stringify({status:[...document.querySelectorAll(".part.statusbar")].some(e=>e.getBoundingClientRect().height>0),sidebar:[...document.querySelectorAll(".part.sidebar")].some(e=>e.getBoundingClientRect().width>0)})', returnByValue: true });
          const chrome = JSON.parse(result.result.value); return !chrome.status && !chrome.sidebar;
        });
        await evaluate(async () => { await document.fonts.ready; await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });
        if (['gif', 'webm'].includes(capture.format)) {
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
    if (lockFixture) await lockFixture.dispose();
  }
  if (failure) throw failure;
  if (original) for (const [index, section] of original.sections.entries()) for (const [imageIndex, image] of section.images.entries()) {
    const renamed = previous.sections[index].images[imageIndex];
    for (const key of ['file', 'fallback']) if (image[key] && renamed[key] !== image[key]) fs.copyFileSync(path.join(output, image[key]), path.join(output, renamed[key]));
  }
  for (const section of manifest.sections) for (const image of section.images) {
    const fresh = path.join(run, image.file); if (fs.existsSync(fresh)) fs.copyFileSync(fresh, path.join(output, image.file));
    if (image.fallback && fs.existsSync(path.join(run, image.fallback))) fs.copyFileSync(path.join(run, image.fallback), path.join(output, image.fallback));
  }
  fs.copyFileSync(path.join(run, 'showcases.json'), path.join(output, 'showcases.json'));
  if (original) {
    const retained = new Set(manifest.sections.flatMap(section => section.images.flatMap(image => [image.file, image.fallback].filter(Boolean))));
    for (const section of original.sections) for (const image of section.images) for (const file of [image.file, image.fallback].filter(Boolean)) if (!retained.has(file)) fs.unlinkSync(path.join(output, file));
  }
  console.log(`Showcase manifest: ${path.join(output, 'showcases.json')}`);
}

module.exports = { validateCatalog, filename, numberCatalog, assertSurfaceState, assertProductState, waitFor, buildManifest, parseOptions, safeActions, safeListerActions, profileSettings, renumberManifest, clickControl };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
