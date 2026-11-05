const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { animatePointer, frameList, installPointer, encodingArgs } = require('./gestures.cjs');
const { installPresentation, createPacing, presentationTiming } = require('./presentation.cjs');
const { keys } = require('./sequence.cjs');

function assertSafeSurfaceTarget(element, { allowDialogContent = false } = {}) {
  if (!element) throw new Error('Recording target is missing.');
  const dialog = element.closest('dialog, [role="dialog"], form');
  const cancellation = element.closest('#modal-cancel, [data-search-close], [data-lister-close]');
  const field = element.closest('input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), textarea, select, [contenteditable="true"]');
  const tab = element.closest('[role="tab"]:not([aria-disabled="true"]):not(:disabled)');
  if (dialog && !allowDialogContent && !cancellation && !field && !tab) {
    throw new Error('Recording cannot press a confirmation control.');
  }
  if (element.closest('button[type="submit"], input[type="submit"], #modal-ok, [data-confirm-action]')) {
    throw new Error('Recording cannot press a confirmation control.');
  }
}

function validateEffect(effect) {
  if (effect !== undefined && (typeof effect !== 'string' || !effect.trim() || effect.length > 80 || /[\u0000-\u001f\u007f]/.test(effect))) {
    throw new Error('Invalid action caption.');
  }
}

function targetRect(selector, allowDialogContent = false, root = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Recording target missing: ${selector}`);
  const dialog = element.closest('dialog, [role="dialog"], form');
  const cancellation = element.closest('#modal-cancel, [data-search-close], [data-lister-close]');
  const field = element.closest('input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), textarea, select, [contenteditable="true"]');
  const tab = element.closest('[role="tab"]:not([aria-disabled="true"]):not(:disabled)');
  if (dialog && !allowDialogContent && !cancellation && !field && !tab) throw new Error('Recording cannot press a confirmation control.');
  if (element.closest('button[type="submit"], input[type="submit"], #modal-ok, [data-confirm-action]')) throw new Error('Recording cannot press a confirmation control.');
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) throw new Error(`Recording target missing: ${selector}`);
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function focusedTextInput(root = document) {
  const element = root.activeElement;
  return Boolean(element?.matches('input:not([type="button"]):not([type="submit"]):not([type="checkbox"]), textarea, [contenteditable="true"]') &&
    !element.disabled && !element.readOnly);
}

function expressionFor(fn, args) {
  return `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`;
}

async function createSurfaceRecorder({
  page, target, targetClient = page, contextId, pageEvaluate, targetEvaluate,
  frameDirectory, outputFile, format, encode = spawnSync,
  now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  maxWidth = 1280, maxHeight = 900, firstFrameTimeout = 5000
}) {
  if (!page?.call || !page?.on || !target?.type || !frameDirectory || !outputFile) {
    throw new TypeError('A page connection, target, frame directory and output file are required.');
  }
  const outputFormat = format || path.extname(outputFile).slice(1);
  if (!['gif', 'webm'].includes(outputFormat) || path.extname(outputFile) !== `.${outputFormat}`) {
    throw new Error('Surface recording requires a matching GIF or WebM output path.');
  }
  fs.mkdirSync(frameDirectory, { recursive: true });
  const evalPage = pageEvaluate || (async (fn, ...args) => {
    const result = await page.call('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expressionFor(fn, args) });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  });
  const evalTarget = targetEvaluate || (async (fn, ...args) => {
    const result = await targetClient.call('Runtime.evaluate', { ...(contextId ? { contextId } : {}), returnByValue: true,
      awaitPromise: true, expression: expressionFor(fn, args) });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  });
  let offset = { x: 0, y: 0 };
  if (target.type === 'iframe') {
    await page.call('DOM.enable');
    const owner = await page.call('DOM.getFrameOwner', { frameId: target.id });
    const model = await page.call('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
    offset = { x: model.model.content[0], y: model.model.content[1] };
  }
  let position = await evalPage(installPointer);
  await evalPage(installPresentation, presentationTiming);
  const origin = { ...position }, records = [], events = [];
  const pacing = createPacing({ now, sleep });
  let recordingError, finished = false, buttons = 0, resolveFrame;
  const firstFrame = new Promise(resolve => { resolveFrame = resolve; });
  const onFrame = event => {
    try {
      const name = `frame-${String(records.length).padStart(4, '0')}.png`;
      fs.writeFileSync(path.join(frameDirectory, name), Buffer.from(event.data, 'base64'));
      records.push({ name, timestamp: event.metadata.timestamp * 1000, pointer: { ...position }, buttons });
      resolveFrame?.(); resolveFrame = null;
    } catch (error) { recordingError = error; }
    page.call('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => { recordingError = error; });
  };
  const onResult = page.on('Page.screencastFrame', onFrame);
  const unsubscribe = typeof onResult === 'function' ? onResult : () => page.off?.('Page.screencastFrame', onFrame);
  const cleanOverlay = async () => evalPage(() => {
    window.__showcasePresentation?.dispose();
    document.querySelector('#showcase-pointer')?.remove(); document.querySelector('#showcase-keys')?.remove();
    document.querySelector('#showcase-pointer-style')?.remove();
  });
  try {
    await page.call('Page.startScreencast', { format: 'png', maxWidth, maxHeight, everyNthFrame: 1 });
    let frameTimer;
    try {
      await Promise.race([firstFrame, new Promise((_, reject) => { frameTimer = setTimeout(() => reject(new Error('The surface recording produced no CDP frame.')), firstFrameTimeout); })]);
    } finally { clearTimeout(frameTimer); }
  } catch (error) {
    unsubscribe(); await cleanOverlay(); throw error;
  }
  await pacing.begin();

  async function moveTo(selector, duration = 660, { allowDialogContent = false } = {}) {
    if (finished) throw new Error('The surface recording has finished.');
    await pacing.beforeInput();
    const local = await evalTarget(targetRect, selector, allowDialogContent);
    const end = { x: local.x + offset.x, y: local.y + offset.y }, start = { ...position };
    await animatePointer({ start, end, duration, now: () => now(), sleep, update: async point => {
      position = point;
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons });
      await evalPage((point, button) => window.__showcasePresentation.pointer('mouseMoved', point, button), point, buttons & 2 ? 'right' : buttons & 1 ? 'left' : 'none');
    } });
  }

  async function click(selector, button = 'left', { allowDialogContent = false, effect } = {}) {
    validateEffect(effect);
    if (!['left', 'right'].includes(button)) throw new Error('Only left and right button clicks can be recorded.');
    await moveTo(selector, 440, { allowDialogContent });
    const local = await evalTarget(targetRect, selector, allowDialogContent);
    const point = { x: local.x + offset.x, y: local.y + offset.y };
    const mask = button === 'right' ? 2 : 1;
    buttons |= mask; position = point;
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, buttons, clickCount: 1 });
    await evalPage((type, point, button, effect) => window.__showcasePresentation.pointer(type, point, button, effect), 'mousePressed', point, button, effect);
    await evalPage(() => { const ring = document.querySelector('.showcase-ring'); ring?.animate?.([{ transform: 'scale(.7)', opacity: 1 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 380, iterations: 1, easing: 'ease-out' }); });
    await sleep(180);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, buttons: buttons & ~mask, clickCount: 1 });
    buttons &= ~mask;
    await evalPage((type, point, button, effect) => window.__showcasePresentation.pointer(type, point, button, effect), 'mouseReleased', point, button, effect);
    events.push({ type: 'click', selector, button, point, ...(effect ? { effect } : {}), timestamp: now() });
  }

  async function key(name, effect) {
    validateEffect(effect);
    if (!Object.hasOwn(keys, name)) throw new Error(`Unsupported or unsafe recording key: ${name}`);
    const [keyName, code, vk, keyModifiers = 0] = keys[name], chord = name.startsWith('Ctrl+'), shift = name.startsWith('Shift+'), alt = name.startsWith('Alt+');
    const send = async (type, value, keyCode, virtualKey, modifiers = 0, actionEffect) => {
      if (type === 'keyDown' && !buttons) await pacing.beforeInput();
      await page.call('Input.dispatchKeyEvent', { type, key: value, code: keyCode, windowsVirtualKeyCode: virtualKey, modifiers });
      await evalPage((type, value, actionEffect) => window.__showcasePresentation.key(type, value, actionEffect), type, value, actionEffect);
      events.push({ type, key: value, code: keyCode, modifiers, ...(actionEffect ? { effect: actionEffect } : {}), timestamp: now() });
      await sleep(type === 'keyDown' ? presentationTiming.keyHold : presentationTiming.keyRelease);
    };
    if (chord) await send('keyDown', 'Control', 'ControlLeft', 17, 2);
    if (shift) await send('keyDown', 'Shift', 'ShiftLeft', 16, 8);
    if (alt) await send('keyDown', 'Alt', 'AltLeft', 18, 1);
    try { await send('keyDown', keyName, code, vk, chord ? 2 : shift ? 8 : alt ? 1 : keyModifiers, effect); }
    finally {
      await send('keyUp', keyName, code, vk, chord ? 2 : shift ? 8 : alt ? 1 : keyModifiers);
      if (alt) await send('keyUp', 'Alt', 'AltLeft', 18);
      if (shift) await send('keyUp', 'Shift', 'ShiftLeft', 16, 8);
      if (chord) await send('keyUp', 'Control', 'ControlLeft', 17);
    }
  }

  async function typeText(text) {
    if (typeof text !== 'string' || !text.length || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error('Surface text must be printable and no longer than 128 characters.');
    }
    const focused = await evalTarget(focusedTextInput);
    if (!focused) throw new Error('Text can only be inserted into a focused editable text field.');
    await pacing.beforeInput();
    await page.call('Input.insertText', { text });
    events.push({ type: 'insertText', length: text.length, timestamp: now() });
  }

  async function verified() { pacing.verified(); }
  async function intro(text) {
    await evalPage(text => window.__showcasePresentation.intro(text), text);
    await sleep(2200);
    await evalPage(() => window.__showcasePresentation.intro(''));
  }
  async function pause(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 30000) throw new Error('Invalid surface recording pause.');
    await sleep(milliseconds);
  }

  async function finish() {
    if (finished) throw new Error('The surface recording has already finished.');
    finished = true;
    let recordingEndedAt;
    try {
      await pacing.end(); recordingEndedAt = now();
    } finally {
      await page.call('Page.stopScreencast'); unsubscribe(); await cleanOverlay();
    }
    if (recordingError) throw recordingError;
    if (!records.length) throw new Error('No live CDP frames were recorded.');
    fs.writeFileSync(path.join(frameDirectory, 'frames.txt'), frameList(records, recordingEndedAt).join('\n'));
    const webm = outputFormat === 'webm', duration = Math.max(.001, (recordingEndedAt - records[0].timestamp) / 1000);
    const runEncoder = (destination, asWebm, input) => encode('ffmpeg', encodingArgs(destination, asWebm, duration, input), {
      cwd: frameDirectory, windowsHide: true, encoding: 'utf8', timeout: 60000
    });
    const primary = runEncoder(outputFile, webm);
    if (primary.status !== 0) throw new Error(`Surface recording encoding failed: ${primary.error?.message || primary.stderr}`);
    const gifFile = webm ? outputFile.replace(/\.webm$/, '.gif') : outputFile;
    if (webm) {
      const fallback = runEncoder(gifFile, false, outputFile);
      if (fallback.status !== 0) throw new Error(`Surface GIF fallback encoding failed: ${fallback.error?.message || fallback.stderr}`);
    }
    const gif = fs.readFileSync(gifFile);
    if (gif.toString('ascii', 0, 3) !== 'GIF') throw new Error('The encoded surface fallback is not a GIF.');
    fs.writeFileSync(path.join(frameDirectory, 'evidence.json'), JSON.stringify({
      presentation: { version: 1, timing: presentationTiming }, target: target.type,
      format: outputFormat, frames: records.length, events, origin,
      framesRecordedAt: records.map(record => ({ timestamp: record.timestamp, pointer: record.pointer, buttons: record.buttons }))
    }, null, 2));
    return { width: gif.readUInt16LE(6), height: gif.readUInt16LE(8), frames: records.length,
      ...(webm ? { fallback: path.basename(gifFile) } : {}) };
  }

  async function cancel() {
    if (finished) return;
    finished = true;
    try { await page.call('Page.stopScreencast'); }
    finally { unsubscribe(); await cleanOverlay(); }
  }

  return { origin, offset, moveTo, click, key, typeText, verified, intro, pause, finish, cancel };
}

module.exports = { createSurfaceRecorder, assertSafeSurfaceTarget, targetRect, focusedTextInput };
