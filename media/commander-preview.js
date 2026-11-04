(function (root) {
  'use strict';
  root.CommanderPreview = { create() {
    const container = document.querySelector('#panes');
    let active = null, previous = '';
    return {
      activate(kind, stop) { if (active?.kind === kind) return; active?.stop(); previous = container.style.gridTemplateColumns; active = { kind, stop }; },
      layout(side) { container.style.gridTemplateColumns = side === 0 ? 'minmax(0, 2fr) minmax(0, 3fr)' : 'minmax(0, 3fr) minmax(0, 2fr)'; },
      release(kind) { if (active?.kind !== kind) return; active = null; container.style.gridTemplateColumns = previous; },
      stop() { active?.stop(); }
    };
  } };
})(globalThis);
