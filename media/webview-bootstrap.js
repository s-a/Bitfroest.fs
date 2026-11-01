(() => {
  'use strict';
  let failed = false;
  let lastResource = '';
  const startTime = performance.now();
  const pendingLog = [];
  const settledStyles = new WeakSet();
  function writeLog(kind, name) {
    window.CommanderDiagnostics?.report(kind, { resource: String(name || '').slice(0, 256) });
    pendingLog.push({ kind, name, elapsed: Math.max(0, performance.now() - startTime) });
    flushLog();
  }
  function flushLog() {
    const log = document.querySelector('#startup-log');
    if (!log || !document.body) return;
    const labels = JSON.parse(decodeURIComponent(document.body.dataset.startupLogLabels || '{}'));
    const fallback = { webviewStarted: 'Webview initialization is running', waitingStyle: 'Waiting for stylesheet: {resource}', requestedScript: 'Script requested: {resource}', loadedScript: 'Script loaded: {resource}', loadedStyle: 'Stylesheet loaded: {resource}', failedScript: 'Script failed to load: {resource}', failedStyle: 'Stylesheet failed to load: {resource}', initializing: 'Initializing the file manager', settings: 'Reading settings and configuring file icons', restore: 'Restoring directories and entries', controls: 'Registering keyboard controls', rendering: 'Building the file lists' };
    const hostElapsed = Number(document.body.dataset.startupElapsed) || 0;
    for (const entry of pendingLog.splice(0)) {
      const row = document.createElement('li');
      row.textContent = `[${((hostElapsed + entry.elapsed) / 1000).toFixed(3)} s] ${(labels[entry.kind] || fallback[entry.kind]).replace('{resource}', entry.name)}`;
      log.append(row);
      const detail = document.querySelector('#startup-detail'); if (detail) detail.textContent = row.textContent;
    }
    log.scrollTop = log.scrollHeight;
  }
  function resourceName(target) {
    return (target.getAttribute('src') || target.getAttribute('href') || '').split(/[\\/]/).pop().split(/[?#]/)[0];
  }
  window.CommanderStartupResource = { start(name) { writeLog('requestedScript', name); }, step(name) { if (['initializing', 'settings', 'restore', 'controls', 'rendering'].includes(name)) writeLog(name, ''); } };
  function updateStartupStatus() {
    const status = document.querySelector('#startup-detail');
    if (!status || !lastResource || failed) return;
    const label = decodeURIComponent(document.body.dataset.startupResource || 'Loaded resource: {resource}');
    status.textContent = label.replace('{resource}', lastResource);
  }
  function resourceLoaded(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches('script[src], link[rel="stylesheet"]')) return;
    if (target.matches('link')) settledStyles.add(target);
    lastResource = resourceName(target);
    writeLog(target.matches('script') ? 'loadedScript' : 'loadedStyle', lastResource);
    updateStartupStatus();
  }
  function startupError(event) {
    if (event?.target instanceof Element && !event.target.matches('script, link[rel="stylesheet"]')) return;
    if (failed) return;
    if (event?.target instanceof Element && event.target.matches('link')) settledStyles.add(event.target);
    if (event?.target instanceof Element) writeLog(event.target.matches('script') ? 'failedScript' : 'failedStyle', resourceName(event.target));
    failed = true;
    const error = event?.error || event?.reason;
    const diagnostic = {
      message: String(error?.message || error || event?.message || `Unable to load ${event?.target?.src || event?.target?.href || 'application'}`).slice(0, 8000),
      source: String(event?.filename || event?.target?.src || event?.target?.href || '').slice(0, 2000),
      line: event?.lineno || 0, column: event?.colno || 0,
      stack: String(error?.stack || '').slice(0, 16000)
    };
    window.CommanderHost?.postMessage({ type: 'app-startup-error', diagnostic });
    if (!document.querySelector('#panes')) {
      document.addEventListener('DOMContentLoaded', () => showStartupError(diagnostic), { once: true });
      return;
    }
    showStartupError(diagnostic);
  }
  function showStartupError(diagnostic) {
    const panes = document.querySelector('#panes');
    const progress = document.querySelector('#startup-progress'); if (progress) progress.hidden = true;
    const status = document.querySelector('#startup-message') || document.createElement('p');
    status.id = 'startup-message'; panes.before(status);
    panes.inert = true;
    const actions = document.querySelector('#functionbar'); if (actions) actions.inert = true;
    status.textContent = decodeURIComponent(document.body.dataset.startupError || 'Unable to start the file manager. Close this tab and open it again.');
    status.setAttribute('role', 'alert');
    const labels = JSON.parse(decodeURIComponent(document.body.dataset.startupLabels || '{}'));
    const dialog = document.querySelector('#modal');
    document.querySelector('#modal-title').textContent = status.textContent;
    document.querySelector('#modal-eyebrow').textContent = '';
    document.querySelector('#modal-confirm').hidden = true;
    document.querySelector('#modal-cancel').textContent = labels.close || 'Close';
    document.querySelector('#modal-close').setAttribute('aria-label', labels.close || 'Close');
    const area = document.createElement('section'); area.className = 'operation-error'; area.setAttribute('role', 'alert');
    area.append(document.querySelector('#operation-error-art').content.cloneNode(true));
    const details = document.createElement('details'); details.className = 'operation-error-details';
    const summary = document.createElement('summary'); summary.textContent = labels.details || 'Details';
    const text = document.createElement('textarea'); text.className = 'operation-error-text'; text.readOnly = true; text.rows = 6;
    text.setAttribute('aria-label', labels.details || 'Details');
    text.value = `${diagnostic.message}\n${diagnostic.source}:${diagnostic.line}:${diagnostic.column}\n${diagnostic.stack}`;
    const select = document.createElement('button'); select.type = 'button'; select.textContent = labels.select || 'Select details';
    select.onclick = () => { text.focus(); text.select(); };
    details.append(summary, text, select); area.append(details);
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = labels.copy || 'Copy error details';
    copy.onclick = async () => {
      details.open = true; text.focus(); text.select();
      try {
        if (window.CommanderHost) window.CommanderHost.postMessage({ type: 'startup-log-copy' });
        else await navigator.clipboard?.writeText(text.value);
      } catch { /* The selected text remains available for manual copying. */ }
    };
    area.append(copy);
    document.querySelector('#modal-body').replaceChildren(area);
    for (const id of ['modal-cancel', 'modal-close']) document.getElementById(id).addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation(); dialog.close();
    }, true);
    dialog.showModal();
  }
  window.addEventListener('error', startupError, true);
  window.addEventListener('unhandledrejection', startupError);
  document.addEventListener('load', resourceLoaded, true);
  document.addEventListener('DOMContentLoaded', updateStartupStatus, { once: true });
  document.addEventListener('DOMContentLoaded', flushLog, { once: true });
  window.addEventListener('commander-started', () => {
    window.removeEventListener('error', startupError, true);
    window.removeEventListener('unhandledrejection', startupError);
    document.removeEventListener('load', resourceLoaded, true);
    delete window.CommanderStartupResource;
  }, { once: true });
  window.CommanderHost = window.CommanderHost || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  let observer;
  function showEarlyStatus() {
    if (!document.querySelector('#startup-log')) return;
    observer?.disconnect();
    const copy = document.querySelector('#startup-log-copy');
    if (copy) copy.onclick = () => window.CommanderHost?.postMessage({ type: 'startup-log-copy' });
    writeLog('webviewStarted', '');
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      if (!settledStyles.has(link)) writeLog('waitingStyle', resourceName(link));
    }
    flushLog();
  }
  observer = new MutationObserver(showEarlyStatus);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  showEarlyStatus();
})();
