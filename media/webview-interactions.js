(function (root) {
  'use strict';

  let pathEditor;

  function leaveOnOutsideInteraction(event) {
    if (!pathEditor || event.target === pathEditor.input) return;
    const { input, leave } = pathEditor;
    pathEditor = undefined;
    if (input.isConnected) leave();
  }

  document.addEventListener('pointerdown', leaveOnOutsideInteraction, true);
  document.addEventListener('focusin', leaveOnOutsideInteraction, true);

  function watchPathEditor(input, leave) {
    const editor = { input, leave };
    pathEditor = editor;
    return () => { if (pathEditor === editor) pathEditor = undefined; };
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

  root.BitfroestWebviewInteractions = { watchPathEditor, dismissOnBackdrop };
})(window);
