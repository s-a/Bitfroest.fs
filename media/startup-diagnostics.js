(() => {
  'use strict';
  const started = performance.now();
  const startupId = document.documentElement.dataset.startupId;
  const documentId = document.documentElement.dataset.documentId;
  window.CommanderHost = window.CommanderHost || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  let sequence = 0, framePending = false;
  function report(name, detail = {}) {
    if (!startupId || !documentId || !window.CommanderHost) return;
    try {
      window.CommanderHost.postMessage({ type: 'startup-diagnostic', version: 1, startupId, documentId, sequence: ++sequence,
        event: { ...detail, name, elapsed: Math.max(0, performance.now() - started), readyState: document.readyState,
          visibility: document.visibilityState, focused: document.hasFocus() } });
    } catch { /* Diagnostics must not interrupt document initialization. */ }
  }
  function frame() {
    if (framePending || typeof requestAnimationFrame !== 'function') return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      const element = document.querySelector('#host-startup, #startup-indicator, #panes') || document.body;
      const rect = element?.getBoundingClientRect();
      const style = element && getComputedStyle(element);
      report('frame-observed', { width: innerWidth, height: innerHeight, region: element?.id || 'body',
        regionWidth: rect?.width || 0, regionHeight: rect?.height || 0, display: style?.display || '',
        cssVisibility: style?.visibility || '', opacity: style?.opacity || '', background: style?.backgroundColor || '' });
    });
  }
  window.CommanderDiagnostics = { report };
  report('document-start', { timeOrigin: performance.timeOrigin });
  for (const name of ['DOMContentLoaded', 'readystatechange', 'visibilitychange']) document.addEventListener(name, () => { report(name); frame(); });
  for (const name of ['load', 'pageshow', 'pagehide', 'focus', 'blur', 'resize']) window.addEventListener(name, event => {
    if (event.target !== window && name === 'load') return;
    report(name); frame();
  });
  window.addEventListener('commander-started', () => { report('application-ready'); frame(); });
  document.addEventListener('load', event => {
    const target = event.target;
    if (target instanceof Element && target.matches('script[src],link[rel="stylesheet"]')) report('resource-loaded', { resource: resource(target) });
  }, true);
  function resource(target) {
    return String(target.getAttribute('src') || target.getAttribute('href') || '').split(/[\\/]/).pop().split(/[?#]/)[0].slice(0, 256);
  }
  window.addEventListener('error', event => {
    if (event.target instanceof Element) report('resource-error', { resource: resource(event.target), tag: event.target.tagName });
    else report('runtime-error', { message: String(event.message || event.error || '').slice(0, 8000),
      source: String(event.filename || '').slice(0, 2000), line: event.lineno || 0, column: event.colno || 0, stack: String(event.error?.stack || '').slice(0, 16000) });
  }, true);
  window.addEventListener('unhandledrejection', event => report('unhandled-rejection', {
    message: String(event.reason?.message || event.reason || '').slice(0, 8000), stack: String(event.reason?.stack || '').slice(0, 16000) }));
  document.addEventListener('securitypolicyviolation', event => report('csp-violation', {
    directive: String(event.effectiveDirective || '').slice(0, 256), source: String(event.blockedURI || '').split(/[?#]/)[0].slice(0, 2000),
    line: event.lineNumber || 0, column: event.columnNumber || 0 }));
  frame();
})();
