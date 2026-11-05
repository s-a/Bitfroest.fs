/* global document, window */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executeSequence, inspectState, assertSafePointer, keys } = require('./sequence.cjs');
const { installPresentation, createPacing, presentationTiming } = require('./presentation.cjs');

async function animatePointer({ start, end, duration, update, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const began = now();
  for (;;) {
    const t = Math.min(1, (now() - began) / duration), eased = t * t * (3 - 2 * t);
    await update({ x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased });
    if (t === 1) return;
    await sleep(Math.max(1, 1000 / 60 - (now() - began) % (1000 / 60)));
  }
}

function pulsePointer(ring, now = performance.now()) {
  const delay = Math.max(0, Number(ring.dataset.pulseUntil || 0) - now);
  ring.dataset.pulseUntil = String(now + delay + 380);
  ring.animate([{ transform: 'scale(.7)', opacity: 1 }, { transform: 'scale(2.2)', opacity: 0 }],
    { duration: 380, delay, iterations: 1, easing: 'ease-out', fill: 'none' });
}

function frameList(records, endedAt) {
  const lines = records.flatMap((record, index) => [`file '${record.name}'`, 'option framerate 1000',
    `duration ${Math.max(.001, ((records[index + 1]?.timestamp || endedAt) - record.timestamp) / 1000)}`]);
  lines.push(`file '${records.at(-1).name}'`, 'option framerate 1000');
  return lines;
}

async function dispatchMouseInput(event, dispatch, annotate, effect) {
  await dispatch(event);
  if (event.type === 'mousePressed' || event.type === 'mouseReleased') {
    await annotate(event.button === 'right' ? 'Right click' : 'Left click', event.type === 'mousePressed', effect);
  }
}

function installPointer() {
    const position = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const create = name => document.createElementNS('http://www.w3.org/1999/xhtml', name);
    const pointer = create('div'); pointer.id = 'showcase-pointer'; pointer.dataset.documentationAnnotation = 'pointer';
    pointer.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${position.x}px;top:${position.y}px`;
    const ring = create('span'); ring.className = 'showcase-ring';
    const key = create('span'); key.className = 'showcase-key'; key.hidden = true; pointer.append(ring, key);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('width', '24'); arrow.setAttribute('height', '30'); arrow.setAttribute('viewBox', '0 0 24 30');
    arrow.style.cssText = 'position:absolute;left:0;top:0;filter:drop-shadow(1px 1px 2px #0008)';
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', 'M2 1 L2 23 L8 18 L13 28 L17 26 L12 16 L21 16 Z');
    shape.setAttribute('fill', 'white'); shape.setAttribute('stroke', '#111'); shape.setAttribute('stroke-width', '1.5'); arrow.append(shape); pointer.append(arrow);
    const keyboard = create('div'); keyboard.id = 'showcase-keys'; keyboard.dataset.documentationAnnotation = 'keystrokes';
    keyboard.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:50%;bottom:28px;transform:translateX(-50%);display:none;gap:10px;align-items:center;padding:12px 18px;border:1px solid;border-radius:8px;box-shadow:0 5px 18px #0005;font:16px "Segoe UI",sans-serif;transition:opacity .2s';
    const theme = window.getComputedStyle(document.querySelector('.monaco-workbench'));
    keyboard.style.backgroundColor = theme.getPropertyValue('--vscode-editorWidget-background') || '#252526';
    keyboard.style.color = theme.getPropertyValue('--vscode-foreground') || '#ddd';
    keyboard.style.borderColor = theme.getPropertyValue('--vscode-focusBorder') || '#007fd4';
    document.body.append(keyboard);
    const style = create('style'); style.id = 'showcase-pointer-style';
    style.textContent = '.showcase-ring{opacity:0;display:block;position:absolute;width:24px;height:24px;left:-12px;top:-12px;border:2px solid #ffc857;border-radius:50%;background:#ffc85733;box-sizing:border-box}.showcase-key{position:absolute;left:18px;top:16px;background:#202020ed;color:#fff;border:1px solid #ffc857;border-radius:4px;padding:5px 9px;font:13px "Segoe UI",sans-serif;white-space:nowrap}#showcase-keys kbd{min-width:28px;text-align:center;padding:8px 12px;border:1px solid #888;border-bottom-width:3px;border-radius:5px;font:600 18px "Segoe UI",sans-serif;background:#ffffff0a}.screencast-keyboard{visibility:hidden}';
    document.head.append(style); document.body.append(pointer);
    return position;
}

function findTargetPoint({ selector, side = 0, name, xFraction }, root = document) {
  const pane = root.querySelector(`[data-pane="${side}"]`);
  const findRow = () => name && pane ? [...pane.querySelectorAll('[data-file-row][data-id]')]
    .find(item => item.title === name || item.querySelector('[data-cell]')?.title === name) : null;
  let row = findRow();
  if (name && pane && !row) {
    const grid = root.defaultView?.agGrid?.getGridApi(`files-${side}`);
    let rowIndex = -1;
    grid?.forEachNodeAfterFilterAndSort(node => { if (node.data?.name === name) rowIndex = node.rowIndex; });
    if (rowIndex >= 0) { grid.ensureIndexVisible(rowIndex, 'middle'); row = findRow(); }
  }
  const element = name ? row && (selector === '[data-filename]' ? row.querySelector('[data-filename]') || row : row)
    : pane?.querySelector(selector) || root.querySelector(selector);
  const rect = element?.getBoundingClientRect();
  if (!rect?.width || !rect.height) throw new Error(`Recording target missing: ${name || selector}`);
  const fraction = xFraction ?? (name ? .25 : .5);
  return { x: rect.left + rect.width * fraction, y: rect.top + rect.height / 2 };
}

function fixtureSnapshot(action, root = document) {
  const state = root.defaultView.CommanderHost.getState(), pane = state.panes[state.active];
  const activeDirectory = pane.tabs[pane.tab], other = state.panes[1 - state.active], otherDirectory = other.tabs[other.tab], rows = state.folders[activeDirectory] || [];
  const selected = pane.selected.map(id => rows.find(row => row.id === id)?.fsSource || '');
  if (action === 'lock-inspect') {
    const item = root.querySelector('[data-context-menu] [data-context-action="inspect-folder-locks"]');
    const rect = item?.getBoundingClientRect();
    return { activeDirectory, selected, dialog: 'folder-context-menu', realFilesystem: state.realFilesystem === true,
      controlReady: Boolean(item && !item.disabled && !item.hidden && rect?.width && rect.height) };
  }
  if (action === 'lock-delete') action = 'delete-permanent';
  if (action === 'open') {
    return { activeDirectory, otherDirectory, selected, entryType: rows.find(row => row.id === pane.selected[0])?.type,
      dialog: root.querySelector('dialog[open]') ? 'dialog' : 'folder-list', controlReady: Boolean(root.activeElement?.closest('.pane.active .list')) };
  }
  const modal = root.querySelector('dialog[open]#modal'), field = action === 'rename' ? root.querySelector('.inline-rename') : modal?.querySelector('#value');
  const control = action === 'rename' ? field : modal?.querySelector('#modal-confirm');
  const deleteList = ['trash', 'delete-permanent'].includes(action) ? modal?.querySelector('#modal-body > p:last-child') : null;
  return { activeDirectory, otherDirectory, selected, dialog: action === 'rename' && !modal ? 'inline-rename' : modal?.querySelector('#modal-title')?.textContent,
    input: field?.value, controlReady: Boolean(control && !control.disabled && !control.hidden && (action !== 'rename' || root.activeElement === field)),
    ...(['mkdir', 'create-notes'].includes(action) ? { targetDirectory: modal?.querySelector('#modal-body strong')?.textContent } : {}),
    ...(['trash', 'delete-permanent'].includes(action) ? { dialogFiles: deleteList && deleteList.children.length === 0 ? [deleteList.textContent.trim()] : [] } : {}),
    ...(['copy', 'move-notes'].includes(action) ? { filter: modal?.querySelector('#transfer-filter')?.value, policy: modal?.querySelector('#transfer-policy')?.value,
      transferSource: modal?.querySelector('[data-transfer-source]')?.textContent, individualNames: modal?.querySelector('#transfer-individual')?.checked } : {}),
    ...(action === 'batch-rename' ? { mask: modal?.querySelector('#mask')?.value, counter: modal?.querySelector('#counter')?.value,
      search: modal?.querySelector('#search')?.value, replacement: modal?.querySelector('#replacement')?.value, casing: modal?.querySelector('#casing')?.value,
      preview: [...(modal?.querySelectorAll('#rename-preview tr') || [])].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)) } : {}) };
}

function installLockObservation(kind, root = document) {
  const host = root.defaultView, events = [];
  if (host.__showcaseLockObservation) throw new Error('A lock observation is already active.');
  const listener = event => { if ((kind === 'delete' ? ['filesystem-task-progress', 'filesystem-result'] : ['locks-busy', 'locks-state']).includes(event.data?.type)) events.push(event.data); };
  host.addEventListener('message', listener);
  host.__showcaseLockObservation = { events, dispose() { host.removeEventListener('message', listener); delete host.__showcaseLockObservation; } };
}

function inspectLockProgress(file, root = document) {
  const same = value => typeof value === 'string' && value.replace(/\\/g, '/').toLowerCase() === file.replace(/\\/g, '/').toLowerCase();
  const events = root.defaultView.__showcaseLockObservation.events.filter(event => event.type === 'filesystem-task-progress' && event.progress?.phase === 'deleting' && same(event.progress?.path));
  if (new Set(events.map(event => event.operationId)).size > 1) throw new Error('Multiple deletion operations observed.');
  return events[0] || false;
}

function inspectLockResult(id, root = document) {
  return root.defaultView.__showcaseLockObservation.events.find(event => event.type === 'filesystem-result' && event.operationId === id) || false;
}

function inspectLockScan(root = document) {
  const events = root.defaultView.__showcaseLockObservation.events, busy = events.findIndex(event => event.type === 'locks-busy' && event.busy === true);
  return busy < 0 ? false : events.slice(busy + 1).find(event => event.type === 'locks-state') || false;
}

function inspectLockFailureView(root = document) {
  const status = root.querySelector('#status-message');
  const text = status?.querySelector('[data-status-text]');
  const rect = text?.getBoundingClientRect();
  if (status?.dataset.outcome !== 'error' || !rect?.width || !rect.height) return false;
  return { statusText: text.textContent, dialogOpen: Boolean(root.querySelector('dialog[open], .operation-error')) };
}

function installFixtureCompletion(root = document) {
  const host = root.defaultView;
  host.__showcaseCompletion?.dispose();
  const events = [];
  const listener = event => {
    const data = event.data;
    if (data?.type === 'filesystem-result' && !data.navigationRequestId && !data.refreshRequestId) events.push(data);
  };
  host.addEventListener('message', listener);
  host.__showcaseCompletion = { events, dispose() { host.removeEventListener('message', listener); delete host.__showcaseCompletion; } };
}

function inspectFixtureCompletion(action, fixture, root = document) {
  const events = root.defaultView.__showcaseCompletion?.events;
  if (!events) return { error: 'Fixture completion observer is unavailable.' };
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  for (const event of events) {
    if (event.ok === false || event.cancelled || event.operationOutcome?.cancelled || event.operationOutcome?.errors?.length) return { error: String(event.error || event.operationOutcome?.errors?.join(', ') || 'Fixture operation failed or was cancelled.') };
  }
  const deletion = ['trash', 'delete-permanent'].includes(action);
  const directory = action === 'mkdir' ? fixture.right : deletion ? fixture.left : fixture.folder;
  const expected = action === 'mkdir' ? 'Handover' : action === 'copy' ? 'Project-Plan.md' : 'Handover-Plan.md';
  const success = events.some(event => {
    if (event.ok !== true || event.state?.realFilesystem !== true || !event.state.folders) return false;
    const rows = Object.entries(event.state.folders).find(([name]) => same(name, directory))?.[1];
    if (deletion) return /^delete-/.test(event.operationId || '') && Array.isArray(rows) && Array.isArray(fixture.remainingNames) &&
      !rows.some(row => row.name === (action === 'trash' ? 'Recycle.tmp' : 'Discard.tmp')) &&
      rows.length === fixture.remainingNames.length && fixture.remainingNames.every(name => rows.some(row => row.name === name && row.type === 'text'));
    return Array.isArray(rows) && rows.some(row => row.name === expected && row.type === (action === 'mkdir' ? 'folder' : 'markdown')) &&
      (action !== 'rename' || !rows.some(row => row.name === 'Project-Plan.md'));
  });
  const idle = root.querySelector('#status-progress-area')?.classList.contains('is-idle') && root.querySelector('#status-activity')?.hidden &&
    !root.querySelector('#panes')?.inert && !root.querySelector('#functionbar')?.inert;
  const message = root.querySelector('#status-message');
  const expectedStatus = action === 'mkdir' ? /^Folder created$/ : action === 'copy' ? /^1 file copied, 0 skipped$/ : deletion ? /^File operation completed$/ : /^Entry renamed\.$/;
  const visibleSuccess = message?.dataset.outcome === 'success' && expectedStatus.test(message.textContent.trim());
  return { complete: Boolean(success && idle && visibleSuccess) };
}

function inspectNotesCompletion(action, fixture, root = document) {
  const events = root.defaultView.__showcaseCompletion?.events;
  if (!events) return { error: 'Fixture completion observer is unavailable.' };
  for (const event of events) if (event.ok === false || event.cancelled || event.operationOutcome?.cancelled || event.operationOutcome?.errors?.length) return { error: String(event.error || 'The notes operation failed or was cancelled.') };
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const names = action === 'batch-rename' ? ['Draft-A_1.txt', 'Draft-B_2.txt'] : ['Draft-A.txt', 'Draft-B.txt'];
  const left = action === 'create-notes' ? names : [], right = action === 'create-notes' ? [] : names;
  const matches = (folders, directory, expected) => { const rows = Object.entries(folders || {}).find(([key]) => same(key, directory))?.[1];
    return Array.isArray(rows) && rows.length === expected.length && expected.every(name => rows.some(row => row.name === name && row.type === 'text')); };
  const success = events.some(event => event.ok === true && event.state?.realFilesystem === true &&
    (action !== 'move-notes' || /^transfer-\d+-\d+$/.test(event.operationId || '')) && matches(event.state.folders, fixture.left, left) && matches(event.state.folders, fixture.right, right));
  const idle = root.querySelector('#status-progress-area')?.classList.contains('is-idle') && root.querySelector('#status-activity')?.hidden && !root.querySelector('#panes')?.inert && !root.querySelector('#functionbar')?.inert;
  const message = root.querySelector('#status-message'), expected = action === 'create-notes' ? /^Files created$/ : action === 'move-notes' ? /^2 files moved, 0 skipped$/ : /^2 entries renamed$/;
  return { complete: Boolean(success && idle && message?.dataset.outcome === 'success' && expected.test(message.textContent.trim())) };
}

async function recordGesture({ capture, scene, page, target, evaluate, invoke, run, file, fixture, waitFor: poll, targets, connect, connections }) {
  const frames = path.join(run, path.parse(file).name);
  fs.mkdirSync(frames, { recursive: true });
  const pageEvaluate = async (fn, ...args) => {
    const result = await page.call('Runtime.evaluate', { returnByValue: true, awaitPromise: true,
      expression: `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})` });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const owner = await page.call('DOM.getFrameOwner', { frameId: target.id });
  const model = await page.call('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
  const offset = { x: model.model.content[0], y: model.model.content[1] };
  let position = await pageEvaluate(installPointer), buttons = 0;
  await pageEvaluate(installPresentation, presentationTiming);
  const origin = { ...position };
  const records = [];
  const pacing = createPacing();
  let recording = false;
  const refreshProtection = async () => {
    const rectangles = await evaluate(() => [...new Set([document.activeElement, ...document.querySelectorAll('.inline-rename, dialog[open] input:focus')])]
      .filter(element => element?.matches('input,textarea,select,[contenteditable="true"]'))
      .map(element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));
    await pageEvaluate((rectangles, offset) => window.__showcasePresentation.protect(rectangles.map(r => ({
      left: r.left + offset.x, right: r.right + offset.x, top: r.top + offset.y, bottom: r.bottom + offset.y
    }))), rectangles, offset);
  };
  const waitFor = async read => {
    const value = await poll(read);
    await refreshProtection();
    if (recording && !buttons) pacing.verified();
    return value;
  };
  const keyEvents = [];
  const keyEvent = async (type, key, code, windowsVirtualKeyCode, modifiers = 0, effect) => {
    if (type === 'keyDown' && !buttons) await pacing.beforeInput();
    await page.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
    keyEvents.push({ type, key, code, modifiers, timestamp: Date.now() });
    await refreshProtection();
    await pageEvaluate((type, key, effect) => window.__showcasePresentation.key(type, key, effect), type, key, effect);
    await hold(type === 'keyDown' ? presentationTiming.keyHold : presentationTiming.keyRelease);
  };
  let recordingError;
  const unsubscribe = page.on('Page.screencastFrame', event => {
    try {
      const name = `frame-${String(records.length).padStart(4, '0')}.png`;
      fs.writeFileSync(path.join(frames, name), Buffer.from(event.data, 'base64'));
      records.push({ name, timestamp: event.metadata.timestamp * 1000, pointer: { ...position }, buttons });
    } catch (error) { recordingError = error; }
    page.call('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => { recordingError = error; });
  });
  const hold = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const mouseEvents = [];
  const mouse = async (type, point = position, button = 'none', modifiers = 0, effect) => {
    if (type === 'mousePressed' && !buttons) await pacing.beforeInput();
    position = point;
    if (type === 'mousePressed') buttons |= button === 'right' ? 2 : 1;
    if (type === 'mouseReleased') buttons &= ~(button === 'right' ? 2 : 1);
    const update = () => pageEvaluate((type, point, button, effect) => window.__showcasePresentation.pointer(type, point, button, effect), type, point, button, effect);
    await dispatchMouseInput({ type, x: point.x, y: point.y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 }, event => page.call('Input.dispatchMouseEvent', event), update, effect);
    if (type === 'mouseMoved') await update();
    else await refreshProtection();
    mouseEvents.push({ type, ...point, button, buttons, timestamp: Date.now() });
    if (type === 'mousePressed') {
      await pageEvaluate(point => {
        const pointer = document.querySelector('#showcase-pointer');
        pointer.style.left = `${point.x}px`; pointer.style.top = `${point.y}px`;
      }, position);
      const result = await page.call('Runtime.evaluate', { expression: `(${pulsePointer.toString()})(document.querySelector('.showcase-ring'))` });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    }
  };
  const point = async (selector, side, name, xFraction) => {
    const rect = await evaluate(new Function('target', `return (${findTargetPoint.toString()})(target, document);`), { selector, side, name, xFraction });
    return { x: offset.x + rect.x, y: offset.y + rect.y };
  };
  const click = async (p, button = 'left', modifiers = 0, effect) => {
    await mouse('mouseMoved', p); await mouse('mousePressed', p, button, modifiers, effect); await mouse('mouseReleased', p, button, modifiers, effect);
  };
  const clearSelection = async () => {
    await move(await point('[data-main-menu] > button:nth-of-type(2)', 0));
    await click(position, 'left', 0, 'Open selection menu');
    await waitFor(() => evaluate(() => Boolean(document.querySelector('#main-menu-popup [data-menu-action="clear"]'))));
    await move(await point('[data-menu-action="clear"]', 0));
    await click(position, 'left', 0, 'Clear current selection');
    await waitFor(() => evaluate(() => window.CommanderHost.getState().panes[0].selected.length === 0));
  };
  const move = async (end, duration = 660) => {
    if (!buttons) await pacing.beforeInput();
    await refreshProtection();
    const start = { ...position };
    await animatePointer({ start, end, duration, update: async next => {
      await mouse('mouseMoved', next, buttons & 2 ? 'right' : buttons & 1 ? 'left' : 'none');
    } });
  };
  let result, recordingEndedAt;
  try {
    await invoke('showcase.screencast');
    await invoke('bitfroest.clear');
    await waitFor(() => evaluate(() => { const state = window.CommanderHost.getState(); return state.panes[state.active].selected.length === 0; }));
    if (capture.gesture === 'right-drag') {
      await click(await point('.list', 0, 'Changes.txt'));
      await click(await point('.list', 0, 'Colors.json'), 'left', 2);
      await waitFor(() => evaluate(() => window.CommanderHost.getState().panes[0].selected.length === 2));
    }
    await mouse('mouseMoved', origin);
    await pageEvaluate(() => window.__showcasePresentation.reset());
    await page.call('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
    await waitFor(() => records.length > 0);
    recording = true;
    await pacing.begin();
    if (capture.intro) {
      await pageEvaluate(text => window.__showcasePresentation.intro(text), capture.intro);
      await hold(2200);
      await pageEvaluate(() => window.__showcasePresentation.intro(''));
    }
    if (capture.steps) {
      let searchController;
      if (scene.fixture === 'search-story') {
        const searchState = require('./search-story-state.cjs');
        const readSearch = action => evaluate(new Function('action', `return (${searchState.searchSnapshot.toString()})(action, document);`), action);
        const isolated = action => evaluate(new Function('action', `return (${searchState.searchIsolation.toString()})(action, document);`), action);
        const events = () => evaluate(new Function(`return (${searchState.inspectSearchObservation.toString()})(document);`));
        const viewer = () => evaluate(new Function(`return (${require('./lister-observation.cjs').viewerEvidence.toString()})(document);`));
        const idle = () => evaluate(() => document.querySelector('#status-progress-area')?.classList.contains('is-idle') && document.querySelector('#status-activity')?.hidden && !document.querySelector('#panes')?.inert && !document.querySelector('#functionbar')?.inert);
        searchController = require('./search-story-controller.cjs').createSearchStoryController({
          fixture, readSnapshot: readSearch, ensureIsolation: isolated,
          observe: async () => {
            await evaluate(new Function(`(${searchState.installSearchObservation.toString()})(document);`));
            return {
              waitProgress: () => waitFor(async () => {
                const seen = await events();
                const errors = seen.filter(item => item.type === 'search-error' || item.type === 'search-complete' && (item.ok === false || item.error));
                if (errors.length) throw new Error(errors[0].error || 'Search failed.');
                const same = value => typeof value === 'string' && value.replace(/\\/g, '/').toLowerCase() === fixture.left.replace(/\\/g, '/').toLowerCase();
                const progress = seen.filter(item => item.type === 'search-progress' && same(item.path));
                if (new Set(progress.map(item => item.searchId)).size > 1) throw new Error('More than one search was observed.');
                return progress[0] || false;
              }),
              waitComplete: id => waitFor(async () => {
                const seen = await events(), completion = seen.find(item => item.type === 'search-complete' && item.searchId === id);
                if (seen.some(item => item.type === 'search-error' && item.searchId === id)) throw new Error('The search reported an error.');
                if (!completion) return false;
                if (completion.ok === false || completion.cancelled || completion.error || completion.errors?.length) return completion;
                const snapshot = await readSearch('view');
                const visible = await evaluate(new Function(`return (${searchState.searchCompletedVisible.toString()})(document);`));
                return snapshot.ready && snapshot.paths.length === 1 && visible && await idle() ? completion : false;
              }),
              waitOpen: () => waitFor(async () => { const seen = await events(), view = await viewer();
                return seen.some(item => item.type === 'lister-result') && view.visible && view.focused && await idle() ? { events: seen, viewer: view } : false; }),
              waitMatch: () => waitFor(async () => { const seen = await events(), view = await viewer();
                return seen.some(item => item.type === 'lister-result' && item.match) && view.visible && view.focused && view.selection === fixture.findText && await idle() ? { events: seen, viewer: view } : false; }),
              dispose: () => evaluate(() => window.__showcaseSearchObservation?.dispose())
            };
          },
          activate: async (action, snapshot, effect) => {
            const selector = { start: 'dialog[data-file-search][open] [data-search-start]', view: 'dialog[data-file-search][open] [data-search-view]', find: 'dialog[open]#modal #modal-confirm' }[action];
            if (!selector) throw new Error('Invalid search activation.');
            if (action === 'view') {
              const geometry = () => evaluate(new Function(`return (${searchState.searchViewGeometry.toString()})(document);`));
              let observed = await geometry();
              for (let count = 0; !observed.visible && count < 8; count++) {
                if (!observed.scroll || !await isolated(action) || JSON.stringify(await readSearch(action)) !== JSON.stringify(snapshot)) throw new Error('The search dialog cannot be scrolled safely.');
                await move({ x: offset.x + observed.scroll.x, y: offset.y + observed.scroll.y });
                await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: position.x, y: position.y, deltaX: 0, deltaY: 300 });
                await hold(180);
                observed = await geometry();
              }
              if (!observed.visible) throw new Error('The search viewer button is not visible after scrolling.');
            }
            await move(await point(selector, 0));
            if (!await isolated(action) || JSON.stringify(await readSearch(action)) !== JSON.stringify(snapshot)) throw new Error('Search activation state changed.');
            const valid = await evaluate(({ selector, x, y }) => { const button = document.querySelector(selector);
              return Boolean(button && !button.disabled && !button.hidden && document.elementFromPoint(x, y)?.closest(selector) === button); }, { selector, x: position.x - offset.x, y: position.y - offset.y });
            if (!valid) throw new Error('The search activation target changed.');
            await mouse('mousePressed', position, 'left', 0, effect); await mouse('mouseReleased', position, 'left', 0, effect);
          }
        });
      }
      let lockController;
      if (scene.fixture === 'file-lock') {
        const readLock = action => evaluate(new Function('action', `return (${fixtureSnapshot.toString()})(action, document);`), action);
        const clients = new Map();
        let inspector;
        const inspectorEval = async (fn, ...args) => {
          const response = await inspector.client.call('Runtime.evaluate', { contextId: inspector.context.id, returnByValue: true, awaitPromise: true,
            expression: `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})` });
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
          return response.result.value;
        };
        const findInspector = async () => waitFor(async () => {
          for (const candidate of await targets()) {
            if (candidate.type !== 'iframe' || candidate.parentId !== target.parentId || !candidate.url.includes('extensionId=bitfroest.bitfroest-fs-prototype')) continue;
            let client = clients.get(candidate.id);
            if (!client) { client = await connect(candidate.webSocketDebuggerUrl); connections.push(client); clients.set(candidate.id, client); await client.call('Runtime.enable'); }
            for (const context of client.contexts) {
              const response = await client.call('Runtime.evaluate', { contextId: context.id, returnByValue: true,
                expression: `({path:document.querySelector('#target')?.textContent,ready:!!document.querySelector('#processes[aria-busy="false"] .process')})` });
              const state = response.result?.value;
              if (state?.ready && state.path?.replace(/\\/g, '/').toLowerCase() === fixture.folder.replace(/\\/g, '/').toLowerCase()) return { target: candidate, client, context };
            }
          }
          return false;
        });
        const inspectorClick = async (selector, effect) => {
          const frame = await page.call('DOM.getFrameOwner', { frameId: inspector.target.id });
          const box = await page.call('DOM.getBoxModel', { backendNodeId: frame.backendNodeId });
          const rect = await inspectorEval(selector => { const node = document.querySelector(selector), r = node?.getBoundingClientRect();
            return node && !node.disabled && r?.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, selector);
          if (!rect) throw new Error('The lock inspector control is unavailable.');
          await move({ x: box.model.content[0] + rect.x, y: box.model.content[1] + rect.y });
          const valid = await inspectorEval(({ selector, rect }) => document.elementFromPoint(rect.x, rect.y)?.closest(selector) === document.querySelector(selector), { selector, rect });
          if (!valid) throw new Error('The lock inspector control changed.');
          await mouse('mousePressed', position, 'left', 0, effect); await mouse('mouseReleased', position, 'left', 0, effect);
        };
        lockController = require('./lock-story-controller.cjs').createLockStoryController({
          fixture, readSnapshot: readLock,
          observeDelete: async () => {
            await evaluate(new Function(`(${installLockObservation.toString()})('delete', document);`));
            return {
              waitStarted: () => waitFor(() => evaluate(new Function('file', `return (${inspectLockProgress.toString()})(file, document);`), fixture.file)),
              wait: async id => {
                const event = await waitFor(() => evaluate(new Function('id', `return (${inspectLockResult.toString()})(id, document);`), id));
                const view = await waitFor(() => evaluate(new Function(`return (${inspectLockFailureView.toString()})(document);`)));
                return { event, view };
              }, dispose: () => evaluate(() => window.__showcaseLockObservation?.dispose())
            };
          },
          clickConfirm: async (effect, snapshot) => {
            await move(await point('#modal-confirm', 0));
            if (JSON.stringify(await readLock('lock-delete')) !== JSON.stringify(snapshot)) throw new Error('Lock deletion state changed.');
            await require('./lock-story-checks.cjs').validateLockDeleteSnapshot(fixture, snapshot);
            const valid = await evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('#modal-confirm')?.matches('button:not(:disabled):not([hidden])'), { x: position.x - offset.x, y: position.y - offset.y });
            if (!valid) throw new Error('The lock deletion target changed.');
            await mouse('mousePressed', position, 'left', 0, effect); await mouse('mouseReleased', position, 'left', 0, effect);
          },
          openInspector: async (effect, snapshot) => {
            const selector = '[data-context-menu] [data-context-action="inspect-folder-locks"]';
            await move(await point(selector, 0));
            if (JSON.stringify(await readLock('lock-inspect')) !== JSON.stringify(snapshot)) throw new Error('Lock inspector selection changed.');
            await fixture.assertIntact();
            const valid = await evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('[data-context-action="inspect-folder-locks"]') === document.querySelector('[data-context-menu] [data-context-action="inspect-folder-locks"]'), { x: position.x - offset.x, y: position.y - offset.y });
            if (!valid) throw new Error('The lock inspector target changed.');
            await mouse('mousePressed', position, 'left', 0, effect); await mouse('mouseReleased', position, 'left', 0, effect);
            inspector = await findInspector();
            await inspectorClick('#details', 'Show process details');
          },
          observeInspector: async () => {
            await inspectorEval(new Function(`(${installLockObservation.toString()})('scan', document);`));
            return { wait: () => waitFor(async () => { const event = await inspectorEval(new Function(`return (${inspectLockScan.toString()})(document);`));
              return event && await inspectorEval(event => { const region = document.querySelector('#processes');
              const detail = region?.querySelector('.detail'), files = region?.querySelector('.files'), a = detail?.getBoundingClientRect(), b = files?.getBoundingClientRect();
              return event && region?.getAttribute('aria-busy') === 'false' && a?.width && a.height && b?.width && b.height
                ? { event, view: { ready: true, detailsVisible: Boolean(document.querySelector('#details')?.checked), text: region.textContent } } : false; }, event); }),
              dispose: () => inspectorEval(() => window.__showcaseLockObservation?.dispose()) };
          },
          refreshInspector: async effect => { await keyEvent('keyDown', 'F5', 'F5', 116, 0, effect); await keyEvent('keyUp', 'F5', 'F5', 116); }
        });
      }
      let archiveController;
      if (scene.fixture === 'archive-story') {
        const archiveState = require('./archive-state.cjs');
        const readArchive = action => evaluate(new Function('action', `return (${archiveState.archiveSnapshot.toString()})(action, document);`), action);
        const archiveFixture = { source: fixture.source, right: fixture.right, archive: fixture.archive, unpacked: fixture.unpacked, extracted: fixture.extracted };
        const inspect = (fn, ...args) => evaluate(new Function('fixture', `return (${fn.toString()})(fixture, document);`), ...args);
        const waitView = fn => waitFor(async () => { const state = await inspect(fn, archiveFixture); return state.complete && state; });
        const progress = action => evaluate(new Function('action', 'fixture', `return (${archiveState.inspectArchiveProgress.toString()})(action, fixture, document);`), action, archiveFixture);
        archiveController = require('./archive-controller.cjs').createArchiveController({
          fixture, readSnapshot: readArchive,
          observe: async action => {
            await evaluate(new Function(`(${archiveState.installArchiveCompletion.toString()})(document);`));
            return { wait: async operationId => waitFor(async () => {
              const identity = await progress(action); if (identity.error) return identity;
              const state = await evaluate(new Function('action', 'fixture', `return (${archiveState.inspectArchiveCompletion.toString()})(action, fixture, document);`), action, { ...archiveFixture, operationId });
              return (state.complete || state.error) && state;
            }), dispose: () => evaluate(() => window.__showcaseArchiveCompletion?.dispose()) };
          },
          clickConfirm: async (effect, snapshot, action) => {
            await move(await point('#modal-confirm', 0));
            if (JSON.stringify(await readArchive(action)) !== JSON.stringify(snapshot)) throw new Error('Archive confirmation state changed.');
            const valid = await evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('#modal-confirm')?.matches('button:not(:disabled):not([hidden])'), { x: position.x - offset.x, y: position.y - offset.y });
            if (!valid) throw new Error('Archive confirmation target changed.');
            await mouse('mousePressed', position, 'left', 0, effect); await mouse('mouseReleased', position, 'left', 0, effect);
            const observed = await waitFor(async () => { const value = await progress(action); return (value.operationId || value.error) && value; });
            if (observed.error) throw new Error(observed.error);
            return observed.operationId;
          },
          pressEnter: async effect => { await keyEvent('keyDown', 'Enter', 'Enter', 13, 0, effect); await keyEvent('keyUp', 'Enter', 'Enter', 13); },
          waitOpened: () => waitView(archiveState.inspectArchiveOpened), waitLeft: () => waitView(archiveState.inspectArchiveLeft),
          waitExtracted: () => waitView(archiveState.inspectArchiveExtracted)
        });
      }
      result = { steps: await executeSequence(capture.steps, {
        confirm: async (action, effect) => {
          if (!fixture) throw new Error('Fixture confirmation is unavailable.');
          if (searchController) return searchController.execute({ 'search-start': 'start', 'search-view': 'view', 'search-find': 'find' }[action], effect);
          if (lockController) return lockController.confirm(action, effect);
          if (archiveController) return archiveController.confirm(action, effect);
          if (!['rename', 'open'].includes(action)) await move(await point('#modal-confirm', 0));
          const read = () => evaluate(new Function('action', `return (${fixtureSnapshot.toString()})(action, document);`), action);
          const snapshot = await read();
          if (action !== 'open') await evaluate(new Function(`(${installFixtureCompletion.toString()})(document);`));
          try { await fixture.confirm(action, snapshot, async () => {
            if (JSON.stringify(await read()) !== JSON.stringify(snapshot)) throw new Error('Fixture confirmation state changed.');
            if (action === 'rename' || action === 'open') {
              await keyEvent('keyDown', 'Enter', 'Enter', 13, 0, effect);
              await keyEvent('keyUp', 'Enter', 'Enter', 13);
              if (action === 'open') return await waitFor(async () => {
                const observed = await read();
                return observed.activeDirectory.replace(/\\/g, '/').toLowerCase() === fixture.folder.replace(/\\/g, '/').toLowerCase() && observed;
              });
            } else {
              const valid = await evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('#modal-confirm')?.matches('button:not(:disabled):not([hidden])'), { x: position.x - offset.x, y: position.y - offset.y });
              if (!valid) throw new Error('Fixture confirmation target changed.');
              await mouse('mousePressed', position, 'left', 0, effect);
              await mouse('mouseReleased', position, 'left', 0, effect);
            }
          });
          if (action !== 'open') {
            const completion = await waitFor(async () => {
              const inspect = scene.fixture === 'organize-notes' ? inspectNotesCompletion : inspectFixtureCompletion;
              const observed = await evaluate(new Function('action', 'fixture', `return (${inspect.toString()})(action, fixture, document);`), action, { left: fixture.left, right: fixture.right, folder: fixture.folder, remainingNames: fixture.remainingNames });
              return (observed.complete || observed.error) && observed;
            });
            if (completion.error) throw new Error(completion.error);
          }
          } finally { if (action !== 'open') await evaluate(() => window.__showcaseCompletion?.dispose()); }
        },
        fixturePath: async step => {
          if (!archiveController || step.path !== 'unpacked') throw new Error('Fixture path entry is unavailable.');
          const isDialog = step.selector === 'dialog[open] #value';
          const read = action => evaluate(new Function('action', `return (${require('./archive-state.cjs').archiveSnapshot.toString()})(action, document);`), action);
          const snapshot = await read(isDialog ? 'unpack' : 'show-unpacked-folder');
          if (isDialog) await fixture.validateUnpackInput(snapshot); else await fixture.validatePathEdit(snapshot);
          const focused = await evaluate(selector => document.querySelector(selector) === document.activeElement, step.selector);
          if (!focused) throw new Error('Fixture path input is not focused.');
          await keyEvent('keyDown', 'Control', 'ControlLeft', 17, 2);
          await keyEvent('keyDown', 'a', 'KeyA', 65, 2, 'Select the existing path');
          await keyEvent('keyUp', 'a', 'KeyA', 65, 2); await keyEvent('keyUp', 'Control', 'ControlLeft', 17);
          await page.call('Input.insertText', { text: fixture.unpacked }); await refreshProtection();
          const typed = await evaluate(selector => ({ focused: document.querySelector(selector) === document.activeElement, value: document.querySelector(selector)?.value }), step.selector);
          if (!typed.focused || typed.value.replace(/\\/g, '/').toLowerCase() !== fixture.unpacked.replace(/\\/g, '/').toLowerCase()) throw new Error('Fixture destination was not entered.');
        },
        move: async step => {
          const t = step.target;
          await move(await point(t.selector || '[data-filename]', t.side ?? 0, t.name, t.xFraction), step.duration || 660);
        },
        mouse: async (type, button, effect) => {
          if (type === 'press') await evaluate(new Function('p', `(${assertSafePointer.toString()})(document.elementFromPoint(p.x, p.y));`), { x: position.x - offset.x, y: position.y - offset.y });
          await mouse(type === 'press' ? 'mousePressed' : 'mouseReleased', position, button, 0, effect);
        },
        pause: hold,
        key: async (name, effect) => {
          if (name !== 'Escape') await evaluate(() => {
            if (document.querySelector('dialog[open], [role="dialog"]')) throw new Error('Only cancellation keys are allowed in dialogs.');
          });
          const [key, code, vk, modifiers = 0] = keys[name], control = name.startsWith('Ctrl+'), shift = name.startsWith('Shift+'), alt = name.startsWith('Alt+');
          if (control) await keyEvent('keyDown', 'Control', 'ControlLeft', 17, 2);
          if (shift) await keyEvent('keyDown', 'Shift', 'ShiftLeft', 16, 8);
          if (alt) await keyEvent('keyDown', 'Alt', 'AltLeft', 18, 1);
          try {
            await keyEvent('keyDown', key, code, vk, control ? 2 : shift ? 8 : alt ? 1 : modifiers, effect);
          } finally {
            await keyEvent('keyUp', key, code, vk, control ? 2 : shift ? 8 : alt ? 1 : modifiers);
            if (alt) await keyEvent('keyUp', 'Alt', 'AltLeft', 18);
            if (shift) await keyEvent('keyUp', 'Shift', 'ShiftLeft', 16, 8);
            if (control) await keyEvent('keyUp', 'Control', 'ControlLeft', 17);
          }
        },
        type: async step => {
          const safe = await evaluate(step => {
            const field = document.querySelector(step.selector);
            return field && document.activeElement === field && field.matches('input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]),textarea,[contenteditable="true"]') &&
              !field.closest('button[type="submit"],input[type="submit"],#modal-ok,[data-confirm-action]');
          }, step);
          if (!safe) throw new Error('Text entry requires a focused, nonconfirming text field.');
          await page.call('Input.insertText', { text: step.text });
          await refreshProtection();
        },
        check: step => waitFor(async () => {
          const state = await evaluate(new Function('step', `return (${inspectState.toString()})(step);`), step);
          return state.matched && state;
        })
      }) };
    } else if (capture.gesture === 'path-copy') {
      await move(await point('.path-breadcrumbs', 0)); await hold(350);
      await mouse('mouseMoved'); await mouse('mousePressed', position, 'right', 0, 'Copy folder path'); await hold(20);
      await mouse('mouseReleased', position, 'right', 0, 'Copy folder path');
      await waitFor(async () => (await invoke('showcase.clipboard-check', [scene.paths[0].replace(/\//g, '\\')])).matched);
      result = { clipboardMatched: true };
    } else if (capture.gesture === 'ctrl-l') {
      await move(await point('.list', 0, 'Notes.txt')); await click(position, 'left', 0, 'Focus file list'); await hold(600);
      await keyEvent('keyDown', 'Control', 'ControlLeft', 17, 2);
      await keyEvent('keyDown', 'l', 'KeyL', 76, 2, 'Edit folder path');
      await keyEvent('keyUp', 'l', 'KeyL', 76, 2);
      await keyEvent('keyUp', 'Control', 'ControlLeft', 17);
      await waitFor(() => evaluate(() => { const input = document.activeElement; return input.matches('.path-input') && input.selectionStart === 0 && input.selectionEnd === input.value.length; }));
      result = { addressFocused: true, pathSelected: true };
      await keyEvent('keyDown', 'Escape', 'Escape', 27, 0, 'Exit path editing');
      await keyEvent('keyUp', 'Escape', 'Escape', 27);
      await clearSelection();
      result.selectionCleared = true;
    } else if (capture.gesture === 'right-selection') {
      const start = await point('.list', 0, 'Changes.txt', .15), end = await point('.list', 0, 'Colors.json', .65);
      await move(start); await hold(300); await mouse('mouseMoved'); await mouse('mousePressed', position, 'right', 0, 'Select files');
      await move(end); await mouse('mouseReleased', position, 'right');
      await waitFor(() => evaluate(() => window.CommanderHost.getState().panes[0].selected.length >= 2));
      result = { selectionCount: await evaluate(() => window.CommanderHost.getState().panes[0].selected.length) };
      await clearSelection();
      result.selectionCleared = true;
    } else if (capture.gesture === 'right-drag') {
      const first = await point('.list', 0, 'Changes.txt');
      await move(first); await hold(300); await mouse('mouseMoved'); await mouse('mousePressed', first, 'right', 0, 'Drag selected files');
      await hold(650);
      await waitFor(() => evaluate(() => document.body.dataset.fileDragCursor === 'ready'));
      await move(await point('.list', 1, 'inbox'), 880); await hold(400);
      await mouse('mouseReleased', position, 'right');
      await waitFor(() => evaluate(() => document.querySelector('#modal[open] #modal-title')?.textContent === 'Move'));
      result = { moveDialog: true, destination: await evaluate(() => document.querySelector('#value').value) };
      if (result.destination.replace(/\\/g, '/').toLowerCase() !== `${scene.paths[1]}/inbox`.toLowerCase()) throw new Error('The actual drop target differs from the requested destination.');
      await keyEvent('keyDown', 'Escape', 'Escape', 27, 0, 'Cancel move');
      await keyEvent('keyUp', 'Escape', 'Escape', 27);
      await waitFor(() => evaluate(() => !document.querySelector('dialog[open]')));
      await clearSelection();
      result.selectionCleared = true;
    } else throw new Error(`Unknown gesture: ${capture.gesture}`);
    await move(origin);
    await pacing.end();
  } finally {
    recordingEndedAt = Date.now();
    await page.call('Page.stopScreencast'); unsubscribe();
    if (buttons) await mouse('mouseReleased', position, buttons & 2 ? 'right' : 'left');
    await pageEvaluate(() => { window.__showcasePresentation?.dispose(); document.querySelector('#showcase-pointer')?.remove(); document.querySelector('#showcase-keys')?.remove(); document.querySelector('#showcase-pointer-style')?.remove(); });
    await evaluate(() => document.querySelector('dialog[open] #modal-cancel')?.click());
    await invoke('showcase.screencast');
  }
  if (recordingError) throw recordingError;
  fs.writeFileSync(path.join(frames, 'frames.txt'), frameList(records, recordingEndedAt).join('\n'));
  if (!records.length) throw new Error('No live frames were recorded.');
  const video = capture.format === 'webm';
  const encode = (destination, webm, input) => spawnSync('ffmpeg', encodingArgs(destination, webm, (recordingEndedAt - records[0].timestamp) / 1000, input), { cwd: frames, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const encoded = encode(path.join(run, file), video);
  if (encoded.status !== 0) throw new Error(`GIF encoding failed: ${encoded.error?.message || encoded.stderr}`);
  if (video) {
    const fallback = encode(path.join(run, file.replace(/\.webm$/, '.gif')), false, path.join(run, file));
    if (fallback.status !== 0) throw new Error(`GIF fallback encoding failed: ${fallback.error?.message || fallback.stderr}`);
  }
  const gif = fs.readFileSync(path.join(run, video ? file.replace(/\.webm$/, '.gif') : file));
  fs.writeFileSync(path.join(frames, 'evidence.json'), JSON.stringify({ presentation: { version: 1, timing: presentationTiming }, format: capture.format, codec: video ? 'vp9' : 'gif', gesture: capture.gesture, origin, frames: records.length, result, keyEvents, mouseEvents,
    framesRecordedAt: records.map(record => ({ timestamp: record.timestamp, pointer: record.pointer, buttons: record.buttons })) }, null, 2));
  return { width: gif.readUInt16LE(6), height: gif.readUInt16LE(8), ...(video ? { fallback: file.replace(/\.webm$/, '.gif') } : {}) };
}

function encodingArgs(destination, webm, duration, input) {
  return ['-hide_banner', '-loglevel', 'error', '-y', ...(input ? ['-i', input] : ['-f', 'concat', '-safe', '0', '-i', 'frames.txt']), '-vf',
    webm ? 'fps=30,scale=1280:-2:flags=lanczos' : 'fps=30,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-t', String(duration), ...(webm ? ['-an', '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p'] : ['-loop', '0']), destination];
}
module.exports = { recordGesture, animatePointer, pulsePointer, frameList, installPointer, findTargetPoint, fixtureSnapshot, installFixtureCompletion, inspectFixtureCompletion, inspectNotesCompletion, installLockObservation, inspectLockProgress, inspectLockResult, inspectLockScan, inspectLockFailureView, encodingArgs, dispatchMouseInput };
