(() => {
  'use strict';
  let failed = false;
  function startupError() {
    if (failed) return;
    failed = true;
    const panes = document.querySelector('#panes');
    const status = document.querySelector('#startup-message') || document.createElement('p');
    status.id = 'startup-message'; panes.before(status);
    panes.inert = true;
    const actions = document.querySelector('#functionbar'); if (actions) actions.inert = true;
    status.textContent = decodeURIComponent(document.body.dataset.startupError || 'Unable to start the file manager. Close this tab and open it again.');
    status.setAttribute('role', 'alert');
    window.CommanderHost?.postMessage({ type: 'app-startup-error' });
  }
  window.addEventListener('error', startupError, true);
  window.addEventListener('commander-started', () => window.removeEventListener('error', startupError, true), { once: true });
  window.CommanderHost = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
})();
