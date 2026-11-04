/* global document, window */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  await pageEvaluate(() => {
    const create = name => document.createElementNS('http://www.w3.org/1999/xhtml', name);
    const pointer = create('div'); pointer.id = 'showcase-pointer'; pointer.dataset.documentationAnnotation = 'pointer';
    pointer.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0';
    const ring = create('span'); ring.className = 'showcase-ring';
    const key = create('span'); key.className = 'showcase-key'; pointer.append(ring, key);
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
    style.textContent = '.showcase-ring{display:block;position:absolute;width:24px;height:24px;left:-12px;top:-12px;border:2px solid #ffc857;border-radius:50%;background:#ffc85733;box-sizing:border-box}.showcase-key{position:absolute;left:18px;top:16px;background:#202020ed;color:#fff;border:1px solid #ffc857;border-radius:4px;padding:5px 9px;font:13px "Segoe UI",sans-serif;white-space:nowrap}#showcase-pointer[data-down="true"] .showcase-ring{animation:showcase-pulse .6s ease-out infinite}#showcase-keys kbd{min-width:28px;text-align:center;padding:8px 12px;border:1px solid #888;border-bottom-width:3px;border-radius:5px;font:600 18px "Segoe UI",sans-serif;background:#ffffff0a}.screencast-keyboard{visibility:hidden}@keyframes showcase-pulse{from{transform:scale(1);opacity:1}to{transform:scale(2.2);opacity:.3}}';
    document.head.append(style); document.body.append(pointer);
  });
  let position = { x: offset.x + 30, y: offset.y + 40 }, buttons = 0;
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
    pointer.dataset.down = String(down); pointer.querySelector('.showcase-key').textContent = label;
  }, position, label, down);
  const frame = async () => {
    const timestamp = Date.now();
    const shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = `frame-${String(records.length).padStart(4, '0')}.png`;
    const bytes = Buffer.from(shot.data, 'base64'); fs.writeFileSync(path.join(frames, name), bytes);
    records.push({ name, timestamp, pointer: { ...position }, buttons, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  };
  const hold = async milliseconds => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { await frame(); await new Promise(resolve => setTimeout(resolve, 50)); }
  };
  const mouse = async (type, point = position, button = 'none', modifiers = 0) => {
    position = point;
    if (type === 'mousePressed') buttons |= button === 'right' ? 2 : 1;
    if (type === 'mouseReleased') buttons &= ~(button === 'right' ? 2 : 1);
    await page.call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
  };
  const point = async (selector, side, name, xFraction = .25) => {
    const rect = await evaluate(({ selector, side, name, xFraction }) => {
      const pane = document.querySelector(`[data-pane="${side}"]`);
      const element = name ? [...pane.querySelectorAll('[data-file-row][data-id]')].find(row => row.title === name || row.querySelector('[data-cell]')?.title === name) : pane.querySelector(selector);
      if (!element) throw new Error(`Gesture target missing: ${name || selector}`);
      const r = element.getBoundingClientRect(); return { x: r.left + r.width * xFraction, y: r.top + r.height / 2 };
    }, { selector, side, name, xFraction });
    return { x: offset.x + rect.x, y: offset.y + rect.y };
  };
  const click = async (p, button = 'left', modifiers = 0) => {
    await mouse('mouseMoved', p); await mouse('mousePressed', p, button, modifiers); await mouse('mouseReleased', p, button, modifiers);
  };
  const move = async (end, label, count = 12) => {
    const start = { ...position };
    for (let i = 1; i <= count; i++) {
      const next = { x: start.x + (end.x - start.x) * i / count, y: start.y + (end.y - start.y) * i / count };
      await mouse('mouseMoved', next, buttons & 2 ? 'right' : 'none'); await annotation(label, Boolean(buttons)); await frame();
    }
  };
  let result;
  try {
    await invoke('showcase.screencast');
    await invoke('bitfroest.clear');
    if (capture.gesture === 'path-copy') {
      await annotation('Right click'); await hold(350); await move(await point('.path-breadcrumbs', 0), 'Right click', 12); await hold(350);
      await mouse('mouseMoved'); await mouse('mousePressed', position, 'right'); await annotation('Right click', true); await frame();
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
      await annotation('Right button + drag'); await hold(300); await move(start, 'Right button + drag'); await hold(300); await mouse('mouseMoved'); await mouse('mousePressed', position, 'right');
      await move(end, 'Right button + drag'); await mouse('mouseReleased', position, 'right');
      await waitFor(() => evaluate(() => window.CommanderHost.getState().panes[0].selected.length >= 2));
      result = { selectionCount: await evaluate(() => window.CommanderHost.getState().panes[0].selected.length) }; await hold(1100);
    } else if (capture.gesture === 'right-drag') {
      const first = await point('.list', 0, 'Changes.txt'), second = await point('.list', 0, 'Colors.json');
      await click(first); await click(second, 'left', 2);
      await waitFor(() => evaluate(() => window.CommanderHost.getState().panes[0].selected.length === 2));
      await annotation('Hold right button'); await hold(300); await move(first, 'Hold right button'); await hold(300); await mouse('mouseMoved'); await mouse('mousePressed', first, 'right');
      await annotation('Hold right button', true); await hold(650);
      await waitFor(() => evaluate(() => document.body.dataset.fileDragCursor === 'ready'));
      await move(await point('.list', 1, 'inbox'), 'Drag to the target folder', 16); await hold(400);
      await mouse('mouseReleased', position, 'right');
      await waitFor(() => evaluate(() => document.querySelector('#modal[open] #modal-title')?.textContent === 'Move'));
      result = { moveDialog: true, destination: await evaluate(() => document.querySelector('#value').value) };
      if (result.destination.replace(/\\/g, '/').toLowerCase() !== `${scene.paths[1]}/inbox`.toLowerCase()) throw new Error('The actual drop target differs from the requested destination.');
      await annotation('Review the move destination'); await hold(1300);
    } else throw new Error(`Unknown gesture: ${capture.gesture}`);
  } finally {
    if (buttons) await mouse('mouseReleased', position, buttons & 2 ? 'right' : 'left');
    await pageEvaluate(() => { document.querySelector('#showcase-pointer')?.remove(); document.querySelector('#showcase-keys')?.remove(); document.querySelector('#showcase-pointer-style')?.remove(); });
    await evaluate(() => document.querySelector('dialog[open] #modal-cancel')?.click());
    await invoke('showcase.screencast');
  }
  const list = records.flatMap((record, index) => [`file '${record.name}'`, `duration ${((records[index + 1]?.timestamp || record.timestamp + 500) - record.timestamp) / 1000}`]);
  list.push(`file '${records.at(-1).name}'`); fs.writeFileSync(path.join(frames, 'frames.txt'), list.join('\n'));
  const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', 'fps=8,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', path.join(run, file)], { cwd: frames, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (encoded.status !== 0) throw new Error(`GIF encoding failed: ${encoded.error?.message || encoded.stderr}`);
  const gif = fs.readFileSync(path.join(run, file));
  fs.writeFileSync(path.join(frames, 'evidence.json'), JSON.stringify({ gesture: capture.gesture, frames: records.length, result, keyEvents,
    framesRecordedAt: records.map(record => ({ timestamp: record.timestamp, pointer: record.pointer, buttons: record.buttons })) }, null, 2));
  return { width: gif.readUInt16LE(6), height: gif.readUInt16LE(8) };
}

module.exports = { recordGesture };
