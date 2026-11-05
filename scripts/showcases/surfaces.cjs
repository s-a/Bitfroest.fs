/* global document, location */
const fs = require('node:fs');
const path = require('node:path');
const { assertSurfaceState } = require('./run.cjs');
const { createSurfaceRecorder } = require('./surface-recorder.cjs');
const { executeSequence, inspectState, validateSequence } = require('./sequence.cjs');

function visibleInputRects(root = document) {
  return [...root.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
    .filter(element => !element.disabled && !element.readOnly && !element.matches('input[type="hidden"], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="file"]'))
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
}

async function captureSurface({ capture, targets, connect, connections, invoke, waitFor, run, file, encode }) {
  const cache = new Map();
  async function connection(target) {
    if (!cache.has(target.id)) {
      const client = await connect(target.webSocketDebuggerUrl); connections.push(client); cache.set(target.id, client);
      await client.call('Runtime.enable');
    }
    return cache.get(target.id);
  }
  const inspect = async () => {
    for (const target of await targets()) {
      const native = ['editor', 'markdown', 'quickpick', 'inputbox', 'confirmation'].includes(capture.surface);
      if (target.type !== (native ? 'page' : 'iframe') || !target.webSocketDebuggerUrl || !native && !target.url.includes('extensionId=bitfroest.bitfroest-fs-prototype')) continue;
      const client = await connection(target);
      for (const context of client.contexts) {
        let result;
        try { result = await client.call('Runtime.evaluate', { contextId: context.id, returnByValue: true,
          expression: `(${(({ expect, ready, text }) => {
            const element = document.querySelector(expect), rect = element?.getBoundingClientRect();
            const readyRect = ready && document.querySelector(ready)?.getBoundingClientRect();
            return { visible: Boolean(rect?.width && rect?.height), ready: !ready || Boolean(readyRect?.width && readyRect?.height),
              text: element?.textContent || '', owner: location.href.includes('extensionId=bitfroest.bitfroest-fs-prototype') ? 'bitfroest.bitfroest-fs-prototype' : '',
              expected: text };
          }).toString()})(${JSON.stringify(capture)})` }); } catch { continue; }
        const state = result.result.value;
        if (!state?.visible || !state.ready || !state.text.includes(capture.text)) continue;
        return { target, client, context, state };
      }
    }
    return false;
  };
  const initial = await waitFor(inspect);
  const initialPage = initial.target.type === 'page' ? initial.target : (await targets()).find(item => item.id === initial.target.parentId);
  await (await connection(initialPage)).call('Page.bringToFront');
  if (!['quickpick', 'inputbox', 'confirmation'].includes(capture.surface)) await invoke('showcase.prepare-editor');
  const found = await waitFor(inspect);
  if (capture.surface === 'editor') {
    const tab = await invoke('showcase.inspect-editor');
    assertSurfaceState({ ...found.state, kind: 'editor', diff: tab.diff }, capture);
  } else if (['quickpick', 'inputbox', 'confirmation'].includes(capture.surface)) assertSurfaceState({ ...found.state, kind: capture.surface }, capture);
  else if (capture.surface !== 'markdown') assertSurfaceState({ ...found.state, kind: 'webview' }, capture);
  const pageTarget = found.target.type === 'page' ? found.target : (await targets()).find(item => item.id === found.target.parentId);
  const page = await connection(pageTarget);
  await page.call('Runtime.evaluate', { awaitPromise: true, expression: `document.fonts.ready.then(()=>Promise.all((document.querySelector(${JSON.stringify(capture.expect)})?.getAnimations({subtree:true})||[]).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))` });
  let shot;
  if (['gif', 'webm'].includes(capture.format)) {
    if (!capture.steps) throw new Error('Animated surface captures require a real interaction sequence.');
    if (!run || !file) throw new Error('Animated surface captures require a showcase run directory and output filename.');
    validateSequence(capture.steps);
    if (capture.steps.some(step => ['press', 'release'].includes(step.type))) {
      throw new Error('Surface sequences require complete click steps; held mouse interactions are not supported.');
    }
    const outputFile = path.join(run, file), frameDirectory = path.join(run, path.parse(file).name);
    const recorder = await createSurfaceRecorder({ page, target: found.target, targetClient: found.client, contextId: found.context.id,
      frameDirectory, outputFile, format: capture.format, encode });
    try {
      let lastTarget, lastAllowDialogContent = false;
      const refreshProtection = async () => {
        const inspected = await found.client.call('Runtime.evaluate', { contextId: found.context.id, returnByValue: true,
          expression: `(${visibleInputRects.toString()})()` });
        if (inspected.exceptionDetails) throw new Error(inspected.exceptionDetails.exception?.description || inspected.exceptionDetails.text);
        const protectedRects = (inspected.result.value || []).map(rect => ({ left: rect.left + recorder.offset.x,
          right: rect.right + recorder.offset.x, top: rect.top + recorder.offset.y, bottom: rect.bottom + recorder.offset.y }));
        await page.call('Runtime.evaluate', { returnByValue: true,
          expression: `(rects => window.__showcasePresentation?.protect(rects))(${JSON.stringify(protectedRects)})` });
      };
      const readState = async step => {
        const result = await found.client.call('Runtime.evaluate', { contextId: found.context.id, returnByValue: true,
          expression: `(${inspectState.toString()})(${JSON.stringify(step)})` });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      await executeSequence(capture.steps, {
        move: async step => {
          const selector = step.target.selector;
          if (!selector) throw new Error('Surface sequence targets require a CSS selector.');
          lastTarget = selector; lastAllowDialogContent = Boolean(step.allowDialogContent);
          await refreshProtection();
          await recorder.moveTo(selector, step.duration || 660, { allowDialogContent: lastAllowDialogContent });
        },
        mouse: async (type, button, effect) => {
          if (type === 'press') {
            if (!lastTarget) throw new Error('A surface click requires a preceding target.');
            await recorder.click(lastTarget, button, { allowDialogContent: lastAllowDialogContent, effect });
            await refreshProtection();
          } else if (type !== 'release') throw new Error(`Unsupported surface mouse event: ${type}`);
        },
        key: async (key, effect) => { await refreshProtection(); await recorder.key(key, effect); await refreshProtection(); },
        type: async step => { await refreshProtection(); await recorder.typeText(step.text); await refreshProtection(); },
        pause: milliseconds => recorder.pause(milliseconds),
        check: async step => {
          const state = await readState(step);
          await refreshProtection();
          if (state.matched) await recorder.verified();
          return state;
        }
      });
      const encoded = await recorder.finish();
      const data = fs.readFileSync(outputFile).toString('base64');
      const fallback = encoded.fallback ? fs.readFileSync(path.join(run, encoded.fallback)).toString('base64') : undefined;
      shot = { data, width: encoded.width, height: encoded.height, format: capture.format, ...(fallback ? { fallback } : {}) };
    } catch (error) {
      await recorder.cancel(); throw error;
    }
  } else {
    shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  }
  if (['quickpick', 'inputbox', 'confirmation'].includes(capture.surface)) await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  return shot;
}

module.exports = { captureSurface, visibleInputRects };
