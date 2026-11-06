(function (root) {
  'use strict';

  let pathEditor;

  function leaveOnOutsideInteraction(event) {
    if (!pathEditor || event.target === pathEditor.input || event.target.closest?.('[data-text-menu]')) return;
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

  function installTextMenu(t, runFieldCommand) {
    let menu, input;
    const isTextField = field => field === document.activeElement && !field.disabled && !field.closest('.monaco-editor') &&
      (field.matches('textarea') || field.matches('input') && ['text', 'search', 'url', 'tel', 'email', 'number'].includes(field.type));
    function close(restoreFocus = false) {
      menu?.remove();
      menu = undefined;
      if (restoreFocus && input?.isConnected && document.activeElement !== input) input.focus({ preventScroll: true });
      input = undefined;
    }

    function open(field, x) {
      close();
      input = field;
      const selected = field.selectionStart === null ? Boolean(field.value) : field.selectionStart !== field.selectionEnd;
      const entries = [
        ['cut', 'Text ausschneiden', field.readOnly || !selected], ['copy', 'Text kopieren', !selected],
        ['paste', 'Text einfügen', field.readOnly], ['selectAll', 'Gesamten Text auswählen', !field.value]
      ];
      menu = root.BitfroestMenus.create({
        items: entries.map(([id, label, disabled]) => ({ id, label: t(label), disabled, icon: null, attrs: { 'data-text-command': id } })),
        label: t('Text bearbeiten'), focusOnHover: false, onClose: close,
        onAction: ({ id }) => {
          close(true);
          if (runFieldCommand?.(field, id)) return;
          if (id === 'selectAll' && field.selectionStart !== null) field.select();
          else if (!document.execCommand(id) && id === 'paste' && navigator.clipboard) {
            const value = field.value, start = field.selectionStart, end = field.selectionEnd;
            navigator.clipboard.readText().then(text => {
              if (document.activeElement === field && field.value === value && field.selectionStart === start && field.selectionEnd === end) {
                document.execCommand('insertText', false, text);
              }
            }).catch(() => {});
          }
        }
      });
      menu.dataset.textMenu = '';
      menu.setAttribute('popover', 'manual');
      menu.addEventListener('pointerdown', press => press.preventDefault());
      menu.addEventListener('contextmenu', secondary => secondary.preventDefault());
      (field.closest('dialog') || document.body).append(menu);
      menu.showPopover?.();
      root.BitfroestMenus.place(menu, { anchor: field, x });
      if (x === undefined) (menu.querySelector('button:not(:disabled)') || menu).focus();
    }
    document.addEventListener('contextmenu', event => {
      if (event.defaultPrevented || !isTextField(event.target)) return;
      event.preventDefault();
      open(event.target, event.button === 2 ? event.clientX : undefined);
    });
    document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) close(); }, true);
    document.addEventListener('focusin', event => { if (menu && event.target !== input && !menu.contains(event.target)) close(); }, true);
    document.addEventListener('keydown', event => {
      if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && !event.ctrlKey && !event.altKey && !event.metaKey &&
          event.target.id !== 'shortcut-capture' && isTextField(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        open(event.target);
        return;
      }
      if (!menu || event.target !== input) return;
      if (['Escape', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') close();
        else {
          const items = menu.querySelectorAll('button:not(:disabled)');
          (items[event.key === 'ArrowDown' ? 0 : items.length - 1] || menu).focus();
        }
      } else close();
    }, true);
    root.addEventListener('blur', () => close());
    root.addEventListener('resize', () => close());
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

  root.BitfroestWebviewInteractions = { watchPathEditor, installTextMenu, dismissOnBackdrop };
})(window);
