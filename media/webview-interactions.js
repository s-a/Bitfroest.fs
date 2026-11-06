(function (root) {
  'use strict';

  const pathInput = 'input.path-input, input.path-field-input';
  let menuInput, pendingLeave;

  function finishMenu(next) {
    const leave = pendingLeave;
    pendingLeave = undefined;
    const input = menuInput;
    menuInput = undefined;
    if (leave && input.isConnected && next !== input) leave();
  }

  document.addEventListener('mousedown', event => {
    const input = event.target;
    finishMenu(input);
    if (event.button === 2 && input.matches(pathInput) && document.activeElement === input) {
      menuInput = input;
      event.preventDefault();
    }
  }, true);
  document.addEventListener('contextmenu', event => {
    if (event.target.matches(pathInput) && document.activeElement === event.target) menuInput = event.target;
  }, true);
  document.addEventListener('focusin', event => finishMenu(event.target), true);
  document.addEventListener('keydown', event => finishMenu(event.target), true);
  root.addEventListener('focus', () => {
    const input = menuInput;
    const restore = pendingLeave && input.isConnected && document.activeElement === document.body;
    finishMenu(restore ? input : document.activeElement);
    if (restore) input.focus({ preventScroll: true });
  });

  function leavePathEditor(event, leave) {
    // The workbench menu can move focus outside the webview without a related target.
    if (event.target === menuInput && !event.relatedTarget) pendingLeave = leave;
    else leave();
  }

  function dismissOnBackdrop(dialog, dismiss) {
    let startedOutside = false;
    const outside = event => {
      if (event.target !== dialog || event.button !== 0) return false;
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
    };
    dialog.addEventListener('pointerdown', event => { startedOutside = outside(event); });
    dialog.addEventListener('pointercancel', () => { startedOutside = false; });
    dialog.addEventListener('click', event => {
      const dismissClick = startedOutside && outside(event);
      startedOutside = false;
      if (!dismissClick || !dialog.open) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
  }

  root.BitfroestWebviewInteractions = { leavePathEditor, dismissOnBackdrop };
})(window);
