/* global window, document */
const presentationTiming = Object.freeze({ hint: 1000, fade: 180, reading: 1100, opening: 650, ending: 900, keyHold: 180, keyRelease: 180 });

function createPacing({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let readUntil = 0;
  const wait = async ms => { if (ms > 0) await sleep(ms); };
  return {
    begin: async () => { readUntil = 0; await wait(presentationTiming.opening); },
    verified: () => { readUntil = now() + presentationTiming.reading; },
    beforeInput: async () => { await wait(readUntil - now()); readUntil = 0; },
    end: async () => { await wait(Math.max(presentationTiming.ending, readUntil - now())); readUntil = 0; }
  };
}

function installPresentation(timing) {
  window.__showcasePresentation?.dispose();
  const pointer = document.querySelector('#showcase-pointer'), label = pointer.querySelector('.showcase-key');
  const panel = document.querySelector('#showcase-keys');
  const create = tag => document.createElementNS('http://www.w3.org/1999/xhtml', tag);
  const held = create('span'); held.className = 'showcase-held'; pointer.append(held);
  const intro = create('div'); intro.dataset.showcaseIntro = ''; intro.hidden = true;
  intro.style.cssText = 'position:fixed;z-index:2147483646;left:50%;top:12%;transform:translateX(-50%);max-width:75%;padding:14px 22px;border:1px solid var(--vscode-widget-border,#666);border-radius:6px;background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-foreground,#ddd);box-shadow:0 3px 14px #0008;font:600 20px "Segoe UI",sans-serif;text-align:center;pointer-events:none';
  document.body.append(intro);
  const style = create('style'); style.id = 'showcase-presentation-style';
  style.textContent = `
    .showcase-held{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border:2px solid currentColor;border-radius:50%;opacity:0;box-sizing:border-box}
    #showcase-pointer[data-down="true"] .showcase-held{opacity:.7}
    #showcase-pointer .showcase-ring{border-color:currentColor;background:transparent}
    #showcase-pointer .showcase-key{border-color:var(--vscode-widget-border,#666);background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-foreground,#ddd);border-radius:5px;box-shadow:0 2px 8px #0004;transition:opacity ${timing.fade}ms}
    #showcase-keys{transition:opacity ${timing.fade}ms;border-radius:5px;gap:8px;padding:10px 14px;box-shadow:0 2px 8px #0004}
    #showcase-keys kbd{font-size:16px;border-radius:4px;transition:background-color 100ms,transform 100ms,box-shadow 100ms}
    #showcase-keys kbd[data-state="pressed"]{background:var(--vscode-toolbar-activeBackground,#ffffff18);border-color:var(--vscode-focusBorder,#007fd4);transform:translateY(2px);box-shadow:inset 0 1px 3px #0005}
    #showcase-keys kbd[data-state="released"]{background:transparent;border-color:var(--vscode-widget-border,#666);transform:translateY(0);box-shadow:0 1px 1px #0003}
    #showcase-keys .showcase-key-effect{font:13px "Segoe UI",sans-serif;opacity:.9;margin-left:5px;white-space:nowrap}
  `;
  document.head.append(style);
  pointer.style.color = 'var(--vscode-focusBorder,#007fd4)';
  label.hidden = true; pointer.dataset.down = 'false';
  let position = { x: window.innerWidth / 2, y: window.innerHeight / 2 }, protectedRects = [];
  const timers = new Map(), pressed = new Set();
  const cancel = element => {
    for (const timer of timers.get(element) || []) window.clearTimeout(timer);
    timers.delete(element);
  };
  const show = element => {
    cancel(element); element.hidden = false; element.style.opacity = '1';
    if (element === panel) element.style.display = 'flex';
  };
  const expire = element => {
    cancel(element);
    const fade = window.setTimeout(() => {
      element.style.opacity = '0';
      const hide = window.setTimeout(() => {
        element.hidden = true;
        if (element === panel) element.style.display = 'none';
        timers.delete(element);
      }, timing.fade);
      timers.set(element, [hide]);
    }, timing.hint);
    timers.set(element, [fade]);
  };
  const layout = () => {
    const active = document.activeElement;
    const local = active?.matches('input,textarea,[contenteditable="true"]') ? [active.getBoundingClientRect()] : [];
    const avoid = [...protectedRects, ...local].filter(r => r.right > r.left && r.bottom > r.top);
    const place = (element, candidates, relative) => {
      const r = element.getBoundingClientRect(), w = r.width, h = r.height, margin = 12;
      if (!w || !h) return;
      const choices = [...candidates, [margin, margin], [window.innerWidth - w - margin, margin],
        [margin, window.innerHeight - h - margin], [window.innerWidth - w - margin, window.innerHeight - h - margin]];
      const boxes = choices.map(([x, y]) => ({
        x: Math.max(margin, Math.min(x, window.innerWidth - w - margin)),
        y: Math.max(margin, Math.min(y, window.innerHeight - h - margin))
      }));
      const overlaps = p => avoid.some(a => p.x < a.right + 8 && p.x + w > a.left - 8 && p.y < a.bottom + 8 && p.y + h > a.top - 8);
      const p = boxes.find(p => !overlaps(p)) || boxes[0];
      element.style.left = `${p.x - (relative ? position.x : 0)}px`;
      element.style.top = `${p.y - (relative ? position.y : 0)}px`;
      element.style.bottom = 'auto'; element.style.transform = 'none';
      avoid.push({ left: p.x, top: p.y, right: p.x + w, bottom: p.y + h });
    };
    if (!label.hidden) {
      const r = label.getBoundingClientRect();
      place(label, [[position.x + 20, position.y + 22], [position.x + 20, position.y - r.height - 16],
        [position.x - r.width - 16, position.y + 22], [position.x - r.width - 16, position.y - r.height - 16]], true);
    }
    if (!panel.hidden && panel.style.display !== 'none') {
      const r = panel.getBoundingClientRect();
      place(panel, [[(window.innerWidth - r.width) / 2, window.innerHeight - r.height - 28], [(window.innerWidth - r.width) / 2, 54]], false);
    }
  };
  const reset = () => {
    cancel(label); cancel(panel); pressed.clear();
    label.hidden = true; label.style.opacity = '0'; panel.hidden = true; panel.style.display = 'none';
    pointer.dataset.down = 'false';
    const ring = pointer.querySelector('.showcase-ring');
    for (const animation of ring.getAnimations?.() || []) animation.cancel();
    delete ring.dataset.pulseUntil;
  };
  window.__showcasePresentation = {
    intro(text) { intro.textContent = text; intro.hidden = !text; },
    pointer(type, point, button, effect) {
      position = point; pointer.style.left = `${point.x}px`; pointer.style.top = `${point.y}px`;
      if (type === 'mousePressed') {
        pointer.dataset.down = 'true'; label.textContent = `${button === 'right' ? 'Right click' : 'Left click'}${effect ? ` (${effect})` : ''}`;
        show(label); expire(label);
      } else if (type === 'mouseReleased') { pointer.dataset.down = 'false'; if (!label.hidden) expire(label); }
      else if (type === 'mouseMoved' && pointer.dataset.down === 'true' && !label.hidden) { show(label); expire(label); }
      layout();
    },
    key(type, key, effect) {
      const name = key === 'Control' ? 'Ctrl' : key.length === 1 ? key.toUpperCase() : key;
      if (type === 'keyDown') {
        pressed.add(name); show(panel); panel.replaceChildren(); delete panel.dataset.effect;
        for (const [index, value] of [...pressed].entries()) {
          if (index) { const plus = create('span'); plus.textContent = '+'; panel.append(plus); }
          const cap = create('kbd'); cap.textContent = value; cap.dataset.pressed = 'true'; cap.dataset.state = 'pressed'; panel.append(cap);
        }
        if (effect) {
          panel.dataset.effect = effect;
          const caption = create('span'); caption.className = 'showcase-key-effect'; caption.textContent = `(${effect})`; panel.append(caption);
        }
      } else {
        pressed.delete(name);
        for (const cap of panel.querySelectorAll('kbd')) {
          cap.dataset.pressed = String(pressed.has(cap.textContent));
          cap.dataset.state = pressed.has(cap.textContent) ? 'pressed' : 'released';
        }
        if (!pressed.size) expire(panel);
      }
      layout();
    },
    protect(rects) { protectedRects = rects; layout(); },
    reset,
    dispose() { reset(); intro.remove(); held.remove(); style.remove(); delete window.__showcasePresentation; }
  };
  reset();
}

module.exports = { installPresentation, createPacing, presentationTiming };
