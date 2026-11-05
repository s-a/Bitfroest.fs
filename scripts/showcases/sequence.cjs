/* global document */
const keys = {
  Escape: ['Escape', 'Escape', 27], F2: ['F2', 'F2', 113],
  'Alt+F5': ['F5', 'F5', 116], 'Alt+F9': ['F9', 'F9', 120],
  F3: ['F3', 'F3', 114], F4: ['F4', 'F4', 115], F5: ['F5', 'F5', 116],
  F6: ['F6', 'F6', 117], F7: ['F7', 'F7', 118], F8: ['F8', 'F8', 119],
  'Shift+F4': ['F4', 'F4', 115, 8], 'Shift+F8': ['F8', 'F8', 119, 8],
  Tab: ['Tab', 'Tab', 9], ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40], ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39], NumpadAdd: ['+', 'NumpadAdd', 107],
  NumpadSubtract: ['-', 'NumpadSubtract', 109], 'Ctrl+NumpadSubtract': ['-', 'NumpadSubtract', 109],
  'Ctrl+F': ['f', 'KeyF', 70], 'Ctrl+L': ['l', 'KeyL', 76]
};

function validateSequence(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('A nonempty recording sequence is required.');
  let held;
  for (const step of steps) {
    if (!step || !['move', 'click', 'press', 'release', 'key', 'pause', 'check', 'type'].includes(step.type)) throw new Error('Unknown recording step.');
    if (step.duration !== undefined && (!Number.isFinite(step.duration) || step.duration < 1 || step.duration > 30000)) throw new Error('Invalid recording duration.');
    if (step.type === 'pause' && step.duration === undefined) throw new Error('A pause requires a duration.');
    if (step.type === 'move' || step.target) {
      const target = step.target;
      if (!target || Boolean(target.name) === Boolean(target.selector) || ![0, 1].includes(target.side ?? 0) ||
        target.name !== undefined && typeof target.name !== 'string' || target.selector !== undefined && typeof target.selector !== 'string' ||
        target.xFraction !== undefined && !(target.xFraction > 0 && target.xFraction < 1)) throw new Error('Invalid recording target.');
    }
    if (['click', 'press', 'release'].includes(step.type)) {
      const button = step.button || 'left';
      if (!['left', 'right'].includes(button)) throw new Error('Invalid mouse button.');
      if (step.type === 'release') {
        if (held !== button) throw new Error('Mouse release without matching press.');
        held = undefined;
      } else {
        if (held) throw new Error('Mouse button is already held.');
        if (step.type === 'press') held = button;
      }
    }
    if (step.type === 'key' && !Object.hasOwn(keys, step.key)) throw new Error('Unsupported or unsafe recording key.');
    if (step.effect !== undefined && (!['click', 'press', 'release', 'key'].includes(step.type) ||
      typeof step.effect !== 'string' || !step.effect.trim() || step.effect.length > 80 || /[\u0000-\u001f\u007f]/.test(step.effect))) {
      throw new Error('Invalid action caption.');
    }
    if (step.type === 'type' && (typeof step.selector !== 'string' || !step.selector.trim() || typeof step.text !== 'string' ||
      !step.text.length || step.text.length > 256 || /[\u0000-\u001f\u007f]/.test(step.text) ||
      step.value !== undefined && (typeof step.value !== 'string' || step.value.length > 512))) throw new Error('Invalid text-entry step.');
    if (step.type === 'check' && (typeof step.selector !== 'string' || !step.selector.trim() ||
      step.absent !== undefined && typeof step.absent !== 'boolean' ||
      step.absent && (step.text !== undefined || step.value !== undefined || step.focused !== undefined) ||
      step.text !== undefined && typeof step.text !== 'string' || step.value !== undefined && typeof step.value !== 'string' ||
      step.focused !== undefined && typeof step.focused !== 'boolean')) throw new Error('Invalid interface check.');
  }
  if (held) throw new Error('Recording ends with a held mouse button.');
  return steps;
}

function inspectState(step, root = document) {
  const element = root.querySelector(step.selector), rect = element?.getBoundingClientRect();
  const style = element && root.defaultView?.getComputedStyle?.(element);
  const visible = Boolean(rect?.width && rect?.height && !element.hidden && element.getAttribute('aria-hidden') !== 'true' &&
    style?.display !== 'none' && style?.visibility !== 'hidden');
  const observed = { visible, text: element?.textContent, value: element?.value, focused: Boolean(element && root.activeElement === element) };
  return { ...observed, matched: step.absent ? !visible : visible &&
    (step.text === undefined || observed.text.includes(step.text)) &&
    (step.value === undefined || observed.value === step.value) &&
    (step.focused === undefined || observed.focused === step.focused) };
}

function assertSafePointer(element) {
  if (!element) throw new Error('Recording cannot press a confirmation control.');
  const confirmation = element.closest('button[type="submit"], input[type="submit"], #modal-ok, [data-confirm-action]');
  const inDialog = element.closest('dialog, [role="dialog"], form');
  const cancellation = element.closest('#modal-cancel, [data-search-close], [data-lister-close]');
  const field = element.closest('input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), textarea, select, [contenteditable="true"]');
  const tab = element.closest('[role="tab"]:not([aria-disabled="true"])');
  if (confirmation || inDialog && !cancellation && !field && !tab) throw new Error('Recording cannot press a confirmation control.');
}

async function executeSequence(steps, driver) {
  validateSequence(steps);
  const evidence = [];
  for (const [index, step] of steps.entries()) {
    const record = { step: index + 1, action: step, startedAt: Date.now() };
    try {
      if (step.target) await driver.move(step);
      if (step.type === 'pause') await driver.pause(step.duration);
      else if (step.type === 'key') await driver.key(step.key, step.effect);
      else if (step.type === 'type') {
        const focused = await driver.check({ selector: step.selector, focused: true });
        if (!focused?.matched) throw new Error('Text entry requires the target field to be focused.');
        if (typeof driver.type !== 'function') throw new Error('The recording driver does not support text entry.');
        await driver.type(step);
        if (step.value !== undefined) {
          record.observed = await driver.check({ selector: step.selector, value: step.value, focused: true });
          if (!record.observed?.matched) throw new Error('The expected text was not observed in the focused field.');
        }
      }
      else if (step.type === 'check') {
        record.observed = await driver.check(step);
        if (!record.observed?.matched) throw new Error('Expected interface state was not observed.');
      } else if (step.type === 'click') {
        await driver.mouse('press', step.button || 'left', step.effect);
        await driver.mouse('release', step.button || 'left', step.effect);
      } else if (step.type !== 'move') await driver.mouse(step.type, step.button || 'left', step.effect);
      record.finishedAt = Date.now(); evidence.push(record);
    } catch (error) { throw new Error(`Recording step ${index + 1} (${step.type}): ${error.message}`, { cause: error }); }
  }
  return evidence;
}

module.exports = { validateSequence, executeSequence, inspectState, assertSafePointer, keys };
