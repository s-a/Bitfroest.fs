(() => {
  const { computePosition, offset, flip, shift } = window.FloatingUIDOM;
  let active;
  let tooltip;

  function close() {
    if (!active) return;
    active.removeAttribute('aria-describedby');
    tooltip.remove();
    active = undefined;
    tooltip = undefined;
  }

  function open(target) {
    const text = target.dataset.tabTooltip;
    if (!text || active === target) return;
    close();
    active = target;
    tooltip = document.createElement('div');
    tooltip.id = 'bitfroest-tab-tooltip';
    tooltip.className = 'tab-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = text;
    target.setAttribute('aria-describedby', tooltip.id);
    document.body.append(tooltip);
    computePosition(target, tooltip, {
      strategy: 'fixed',
      placement: 'bottom',
      middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })]
    }).then(({ x, y }) => {
      if (active !== target) return;
      Object.assign(tooltip.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' });
    });
  }

  document.addEventListener('pointerover', event => {
    const target = event.target.closest('[data-tab-tooltip]');
    if (target && !target.contains(event.relatedTarget)) open(target);
  });
  document.addEventListener('pointerout', event => {
    if (active && !active.contains(event.relatedTarget)) close();
  });
  document.addEventListener('focusin', event => {
    const target = event.target.closest('[data-tab-tooltip]');
    if (target) open(target);
  });
  document.addEventListener('focusout', event => {
    if (active && !active.contains(event.relatedTarget)) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
})();
