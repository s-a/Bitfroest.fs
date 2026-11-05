/* global document, window */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executeSequence, inspectState, assertSafePointer, keys } = require('./sequence.cjs');

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

async function dispatchMouseInput(event, dispatch, annotate) {
  await dispatch(event);
  if (event.type === 'mousePressed' || event.type === 'mouseReleased') {
    await annotate(event.button === 'right' ? 'Right click' : 'Left click', event.type === 'mousePressed');
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

async function recordGesture({ capture, scene, page, target, evaluate, invoke, run, file, waitFor }) {
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
  const origin = { ...position };
  const records = [];
  const keyEvents = [], pressedKeys = new Set();
  const keyEvent = async (type, key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await page.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
    keyEvents.push({ type, key, code, modifiers, timestamp: Date.now() });
    if (type === 'keyDown') {
      pressedKeys.add(key === 'Control' ? 'Ctrl' : key.toUpperCase());
      await pageEvaluate(keys => {
        const panel = document.querySelector('#showcase-keys'); panel.replaceChildren(); panel.style.display = 'flex'; panel.style.opacity = '1';
        for (const [index, key] of keys.entries()) {
          if (index) { const plus = document.createElementNS('http://www.w3.org/1999/xhtml', 'span'); plus.textContent = '+'; panel.append(plus); }
          const cap = document.createElementNS('http://www.w3.org/1999/xhtml', 'kbd'); cap.textContent = key; panel.append(cap);
        }
      }, [...pressedKeys]);
    } else pressedKeys.delete(key === 'Control' ? 'Ctrl' : key.toUpperCase());
  };
  const annotation = async (label, down = false) => pageEvaluate((position, label, down) => {
    const pointer = document.querySelector('#showcase-pointer'); pointer.style.left = `${position.x}px`; pointer.style.top = `${position.y}px`;
    pointer.dataset.down = String(down); const key = pointer.querySelector('.showcase-key'); key.textContent = label; key.hidden = !label;
  }, position, label, down);
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
  const mouse = async (type, point = position, button = 'none', modifiers = 0) => {
    position = point;
    if (type === 'mousePressed') buttons |= button === 'right' ? 2 : 1;
    if (type === 'mouseReleased') buttons &= ~(button === 'right' ? 2 : 1);
    await dispatchMouseInput({ type, x: point.x, y: point.y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 }, event => page.call('Input.dispatchMouseEvent', event), annotation);
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
  const point = async (selector, side, name, xFraction = .25) => {
    const rect = await evaluate(({ selector, side, name, xFraction }) => {
      const pane = document.querySelector(`[data-pane="${side}"]`);
      const element = name ? [...pane.querySelectorAll('[data-file-row][data-id]')].find(row => row.title === name || row.querySelector('[data-cell]')?.title === name) : pane.querySelector(selector);
      if (!element) throw new Error(`Gesture target missing: ${name || selector}`);
      const r = (name && selector === '[data-filename]' ? element.querySelector('[data-filename]') || element : element).getBoundingClientRect(); return { x: r.left + r.width * xFraction, y: r.top + r.height / 2 };
    }, { selector, side, name, xFraction });
    return { x: offset.x + rect.x, y: offset.y + rect.y };
  };
  const click = async (p, button = 'left', modifiers = 0) => {
    await mouse('mouseMoved', p); await mouse('mousePressed', p, button, modifiers); await mouse('mouseReleased', p, button, modifiers);
  };
  const move = async (end, label, duration = 660) => {
    const start = { ...position };
    await animatePointer({ start, end, duration, update: async next => {
      await mouse('mouseMoved', next, buttons & 2 ? 'right' : 'none'); await annotation(label, Boolean(buttons));
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
    await annotation('');
    await page.call('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
    await waitFor(() => records.length > 0);
    if (capture.steps) {
      result = { steps: await executeSequence(capture.steps, {
        move: async step => {
          const t = step.target;
          await move(await point(t.selector || '[data-filename]', t.side ?? 0, t.name, t.xFraction ?? .25), '', step.duration || 660);
        },
        mouse: async (type, button) => {
          if (type === 'press') await evaluate(new Function('p', `(${assertSafePointer.toString()})(document.elementFromPoint(p.x, p.y));`), { x: position.x - offset.x, y: position.y - offset.y });
          await mouse(type === 'press' ? 'mousePressed' : 'mouseReleased', position, button);
        },
        pause: hold,
        key: async name => {
          if (name !== 'Escape') await evaluate(() => {
            if (document.querySelector('dialog[open], [role="dialog"]')) throw new Error('Only cancellation keys are allowed in dialogs.');
          });
          const [key, code, vk] = keys[name], control = name.startsWith('Ctrl+');
          if (control) await keyEvent('keyDown', 'Control', 'ControlLeft', 17, 2);
          try {
            await keyEvent('keyDown', key, code, vk, control ? 2 : 0);
          } finally {
            await keyEvent('keyUp', key, code, vk, control ? 2 : 0);
            if (control) await keyEvent('keyUp', 'Control', 'ControlLeft', 17);
          }
        },
        check: step => waitFor(async () => {
          const state = await evaluate(new Function('step', `return (${inspectState.toString()})(step);`), step);
          return state.matched && state;
        })
      }) };
    } else if (capture.gesture === 'path-copy') {
      await hold(350); await move(await point('.path-breadcrumbs', 0), ''); await hold(350);
      await mouse('mouseMoved'); await mouse('mousePressed', position, 'right'); await hold(20);
      await mouse('mouseReleased', position, 'right');
      await waitFor(async () => (await invoke('showcase.clipboard-check', [scene.paths[0].replace(/\//g, '\\')])).matched);
      result = { clipboardMatched: true }; await hold(1100);
    } else if (capture.gesture === 'ctrl-l') {
      await annotation('Focus the file list'); await hold(300); await move(await point('.list', 0, 'Notes.txt'), 'Focus the file list'); await click(position); await annotation('Focus the address bar'); await hold(600);
      await keyEvent('keyDown', 'Control', 'ControlLeft', 17, 2);
      await keyEvent('keyDown', 'l', 'KeyL', 76, 2);
      await keyEvent('keyUp', 'l', 'KeyL', 76, 2);
      await keyEvent('keyUp', 'Control', 'ControlLeft', 17);
      await waitFor(() => evaluate(() => { const input = document.activeElement; return input.matches('.path-input') && input.selectionStart === 0 && input.selectionEnd === input.value.length; }));
      result = { addressFocused: true, pathSelected: true }; await annotation('Keyboard shortcut'); await hold(1400);
    } else if (capture.gesture === 'right-selection') {
      const start = await point('.list', 0, 'Changes.txt', .15), end = await point('.list', 0, 'Colors.json', .65);
      await annotation(''); await hold(300); await move(start, ''); await hold(300); await mouse('mouseMoved'); await mouse('mousePressed', position, 'right');
      await move(end, 'Right button + drag'); await mouse('mouseReleased', position, 'right');
      await waitFor(() => evaluate(() => window.CommanderHost.getState().panes[0].selected.length >= 2));
      result = { selectionCount: await evaluate(() => window.CommanderHost.getState().panes[0].selected.length) }; await hold(1100);
    } else if (capture.gesture === 'right-drag') {
      const first = await point('.list', 0, 'Changes.txt');
      await annotation(''); await hold(300); await move(first, ''); await hold(300); await mouse('mouseMoved'); await mouse('mousePressed', first, 'right');
      await annotation('Hold right button', true); await hold(650);
      await waitFor(() => evaluate(() => document.body.dataset.fileDragCursor === 'ready'));
      await move(await point('.list', 1, 'inbox'), 'Drag to the target folder', 880); await hold(400);
      await mouse('mouseReleased', position, 'right');
      await waitFor(() => evaluate(() => document.querySelector('#modal[open] #modal-title')?.textContent === 'Move'));
      result = { moveDialog: true, destination: await evaluate(() => document.querySelector('#value').value) };
      if (result.destination.replace(/\\/g, '/').toLowerCase() !== `${scene.paths[1]}/inbox`.toLowerCase()) throw new Error('The actual drop target differs from the requested destination.');
      await annotation('Review the move destination'); await hold(1300);
    } else throw new Error(`Unknown gesture: ${capture.gesture}`);
    await move(origin, '');
    await hold(350);
  } finally {
    recordingEndedAt = Date.now();
    await page.call('Page.stopScreencast'); unsubscribe();
    if (buttons) await mouse('mouseReleased', position, buttons & 2 ? 'right' : 'left');
    await pageEvaluate(() => { document.querySelector('#showcase-pointer')?.remove(); document.querySelector('#showcase-keys')?.remove(); document.querySelector('#showcase-pointer-style')?.remove(); });
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
  fs.writeFileSync(path.join(frames, 'evidence.json'), JSON.stringify({ format: capture.format, codec: video ? 'vp9' : 'gif', gesture: capture.gesture, origin, frames: records.length, result, keyEvents, mouseEvents,
    framesRecordedAt: records.map(record => ({ timestamp: record.timestamp, pointer: record.pointer, buttons: record.buttons })) }, null, 2));
  return { width: gif.readUInt16LE(6), height: gif.readUInt16LE(8), ...(video ? { fallback: file.replace(/\.webm$/, '.gif') } : {}) };
}

function encodingArgs(destination, webm, duration, input) {
  return ['-hide_banner', '-loglevel', 'error', '-y', ...(input ? ['-i', input] : ['-f', 'concat', '-safe', '0', '-i', 'frames.txt']), '-vf',
    webm ? 'fps=30,scale=1280:-2:flags=lanczos' : 'fps=30,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-t', String(duration), ...(webm ? ['-an', '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p'] : ['-loop', '0']), destination];
}
module.exports = { recordGesture, animatePointer, pulsePointer, frameList, installPointer, encodingArgs, dispatchMouseInput };
