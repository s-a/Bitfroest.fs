(() => {
  'use strict';
  const started = performance.now();
  const startupId = document.documentElement.dataset.startupId;
  const documentId = document.documentElement.dataset.documentId;
  window.BitfroestHost = window.BitfroestHost || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  let sequence = 0, framePending = false, frameRequestedAt = 0, applicationState = () => null;
  const recentMessages = [];
  let intersection = null, intersectionObserver = null, visibilityTracking = false;
  const rectangle = rect => rect && ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  function embedding() {
    let frame = null, access;
    try { frame = window.frameElement; access = frame ? 'same-origin-frame' : window.parent === window ? 'top-level' : 'cross-origin-parent'; }
    catch (error) { access = error.name; }
    let host = null;
    if (frame) try {
      const owner = frame.ownerDocument, view = owner.defaultView, ancestors = [];
      for (let parent = frame.parentElement; parent && ancestors.length < 4; parent = parent.parentElement) ancestors.push(geometry(parent));
      const rect = frame.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = owner.elementFromPoint?.(x, y);
      let boundary;
      try { boundary = view.frameElement ? 'accessible-parent' : view.parent === view ? 'top-level' : 'cross-origin-parent'; } catch (error) { boundary = error.name; }
      host = { connected: frame.isConnected, boundary,
        document: { readyState: owner.readyState, visibility: owner.visibilityState, focused: owner.hasFocus() },
        browserWindow: { outerWidth: view.outerWidth, outerHeight: view.outerHeight, innerWidth: view.innerWidth, innerHeight: view.innerHeight, screenX: view.screenX, screenY: view.screenY },
        ancestors, ancestorsTruncated: ancestors.length === 4 && Boolean(frame.parentElement?.parentElement?.parentElement?.parentElement?.parentElement),
        hit: { x, y, supported: typeof owner.elementFromPoint === 'function', element: describe(hit), withinFrame: Boolean(hit && (hit === frame || frame.contains(hit))) } };
    } catch (error) { host = { error: error.name }; }
    return { access, embedded: Boolean(frame || window.parent !== window || window.location.ancestorOrigins?.length), parentReferenceIsSelf: window.parent === window, frame: geometry(frame),
      host,
      ancestorOrigins: Array.from(window.location.ancestorOrigins || []).slice(0, 8),
      observerSupported: typeof window.IntersectionObserver === 'function', visibilityTracking, intersection };
  }
  function bounded(value, budget, depth = 0, key = '') {
    budget.remaining -= 16;
    if (budget.remaining < 0 || depth > 9) { budget.truncated = true; return null; }
    if (typeof value === 'string') {
      const limit = key === 'stack' ? 16000 : key === 'message' ? 8000 : 2000;
      const text = value.slice(0, Math.max(0, Math.min(limit, budget.remaining)));
      budget.remaining -= JSON.stringify(text).length;
      if (text.length !== value.length) budget.truncated = true;
      return text;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 32) budget.truncated = true;
      return value.slice(0, 32).map(item => bounded(item, budget, depth + 1));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value); if (entries.length > 32) budget.truncated = true;
      return Object.fromEntries(entries.slice(0, 32).map(([name, item]) => { budget.remaining -= name.length; return [name, bounded(item, budget, depth + 1, name)]; }));
    }
    return null;
  }
  function application() { try { return applicationState(); } catch (error) { return { diagnosticError: String(error.message) }; } }
  function describe(element) {
    if (!element) return null;
    return { tag: element.tagName, id: element.id, classes: String(element.className || '').slice(0, 256) };
  }
  function geometry(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element), css = {};
    for (const key of ['display', 'visibility', 'opacity', 'backgroundColor', 'color', 'position', 'zIndex', 'overflow', 'transform', 'filter', 'clipPath', 'contentVisibility', 'contain']) css[key] = style[key] || '';
    return { ...describe(element), hidden: element.hidden, inert: Boolean(element.inert), ariaHidden: element.getAttribute('aria-hidden'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, css };
  }
  function layout() {
    const panes = [...document.querySelectorAll('#panes > .pane')].slice(0, 2).map(pane => {
      const list = pane.querySelector('.list'), rect = (list || pane).getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint?.(x, y);
      const ancestors = [];
      for (let parent = list?.parentElement; parent && ancestors.length < 8; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        ancestors.push({ ...describe(parent), hidden: parent.hidden, inert: Boolean(parent.inert), display: style.display, visibility: style.visibility, opacity: style.opacity });
      }
      return { side: pane.dataset.pane, pane: geometry(pane), list: geometry(list), table: geometry(pane.querySelector('table')),
        firstRow: geometry(pane.querySelector('tbody tr')), firstCell: geometry(pane.querySelector('tbody td')),
        rows: pane.querySelectorAll('tr[data-id]').length, columns: pane.querySelectorAll('thead th').length,
        textLength: list?.textContent?.length || 0, scrollTop: list?.scrollTop, scrollHeight: list?.scrollHeight,
        clientHeight: list?.clientHeight, ancestors, hit: { x, y, supported: typeof document.elementFromPoint === 'function', element: describe(hit), withinPane: Boolean(hit && pane.contains(hit)) } };
    });
    return { paintVerified: false, frameEvidence: 'layout-and-hit-testing-only', devicePixelRatio, fonts: document.fonts?.status || 'unavailable',
      browserWindow: { outerWidth, outerHeight, innerWidth, innerHeight, screenX, screenY,
        screen: { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight },
        visualViewport: window.visualViewport && { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop } },
      embedding: embedding(),
      lifecycle: { wasDiscarded: Boolean(document.wasDiscarded), prerendering: Boolean(document.prerendering),
        serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
        paintEntries: (performance.getEntriesByType?.('paint') || []).map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })),
        navigation: (performance.getEntriesByType?.('navigation') || []).map(entry => ({ type: entry.type, domComplete: entry.domComplete, loadEventEnd: entry.loadEventEnd, activationStart: entry.activationStart })) },
      root: geometry(document.documentElement), body: geometry(document.body), container: geometry(document.getElementById('panes')),
      header: geometry(document.querySelector('.bitfroest-header')), statusbar: geometry(document.getElementById('statusbar')),
      paneCount: document.querySelectorAll('#panes > .pane').length, panes,
      stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].slice(0, 32).map(link => {
        const result = { resource: resource(link), disabled: Boolean(link.disabled), present: Boolean(link.sheet), media: link.media };
        try { result.ruleCount = link.sheet?.cssRules.length ?? null; } catch { result.rulesUnavailable = true; }
        return result;
      }) };
  }
  function report(name, detail = {}) {
    if (!startupId || !documentId || !window.BitfroestHost) return;
    try {
      const budget = { remaining: 24000, truncated: false }, payload = bounded(detail, budget);
      window.BitfroestHost.postMessage({ type: 'startup-diagnostic', version: 1, startupId, documentId, sequence: ++sequence,
        event: { ...payload, detailsTruncated: budget.truncated, name, elapsed: Math.max(0, performance.now() - started), readyState: document.readyState,
          visibility: document.visibilityState, focused: document.hasFocus() } });
      if (name === 'git-protocol-error') failureContext();
    } catch { /* Diagnostics must not interrupt document initialization. */ }
  }
  function frame() {
    if (framePending || typeof requestAnimationFrame !== 'function') return;
    framePending = true;
    frameRequestedAt = performance.now();
    requestAnimationFrame(() => {
      framePending = false;
      const element = document.querySelector('#host-startup, #startup-indicator, #panes') || document.body;
      const rect = element?.getBoundingClientRect();
      const style = element && getComputedStyle(element);
      report('frame-observed', { width: innerWidth, height: innerHeight, region: element?.id || 'body',
        regionWidth: rect?.width || 0, regionHeight: rect?.height || 0, display: style?.display || '',
        cssVisibility: style?.visibility || '', opacity: style?.opacity || '', background: style?.backgroundColor || '',
        frameDelayMs: Math.max(0, performance.now() - frameRequestedAt), layout: layout(), application: application() });
    });
  }
  window.BitfroestDiagnostics = { report, registerState(read) { if (typeof read === 'function') applicationState = read; } };
  function failureContext() { report('failure-context', { relatedSequence: sequence, layout: layout(), application: application(), recentMessages: recentMessages.slice(-12) }); }
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type === 'diagnostic-probe' && data.startupId === startupId && data.documentId === documentId) {
      report('probe-received', { requestId: data.requestId, framePending, frameAgeMs: framePending ? performance.now() - frameRequestedAt : 0,
        layout: layout(), application: application(), recentMessages: recentMessages.slice(-12) });
      frame(); return;
    }
    if (!/^(?:filesystem-|git-|icons$|restore$)/.test(data?.type || '')) return;
    const protocol = { type: data.type, requestId: data.requestId, snapshotId: data.snapshotId, partial: data.partial, ok: data.ok };
    if (data.directories) protocol.directories = Object.entries(data.directories).slice(0, 2).map(([directory, info]) => ({ directory,
      phase: info?.phase, stage: info?.stage, loading: info?.loading, ok: info?.ok,
      checks: info?.repositoryChecks && { ...info.repositoryChecks, paths: info.repositoryChecks.paths?.slice(0, 16), pathsCount: info.repositoryChecks.paths?.length },
      result: info?.repositoryResult && { path: info.repositoryResult.path, ok: info.repositoryResult.ok, error: info.repositoryResult.error } }));
    recentMessages.push(protocol); if (recentMessages.length > 32) recentMessages.shift();
    report('protocol-message', { protocol });
    if (!data.partial || data.type !== 'git-status-result') frame();
  });
  report('document-start', { timeOrigin: performance.timeOrigin, diagnosticRevision: 5 });
  if (typeof window.IntersectionObserver === 'function') {
    try {
      visibilityTracking = Boolean(window.IntersectionObserverEntry && 'isVisible' in window.IntersectionObserverEntry.prototype);
      intersectionObserver = new window.IntersectionObserver(entries => {
        const entry = entries.at(-1); if (!entry) return;
        intersection = { isIntersecting: entry.isIntersecting, ratio: entry.intersectionRatio, isVisible: typeof entry.isVisible === 'boolean' ? entry.isVisible : null,
          rect: rectangle(entry.boundingClientRect), intersectionRect: rectangle(entry.intersectionRect), rootBounds: rectangle(entry.rootBounds), observedAt: entry.time };
        report('frame-intersection', { intersection }); frame();
      }, { root: null, threshold: [0, .01, 1], ...(visibilityTracking ? { trackVisibility: true, delay: 250 } : {}) });
      intersectionObserver.observe(document.documentElement);
    } catch (error) { report('observer-unavailable', { message: error.message }); }
  }
  window.addEventListener('pagehide', event => { if (!event.persisted) intersectionObserver?.disconnect(); });
  for (const name of ['DOMContentLoaded', 'readystatechange', 'visibilitychange']) document.addEventListener(name, () => { report(name); frame(); });
  for (const name of ['load', 'pageshow', 'pagehide', 'focus', 'blur', 'resize']) window.addEventListener(name, event => {
    if (event.target !== window && event.target !== document && name === 'load') return;
    report(name); frame();
  });
  window.addEventListener('bitfroest-started', () => { report('application-ready'); frame(); });
  document.addEventListener('load', event => {
    const target = event.target;
    if (target instanceof Element && target.matches('script[src],link[rel="stylesheet"]')) report('resource-loaded', { resource: resource(target) });
  }, true);
  function resource(target) {
    return String(target.getAttribute('src') || target.getAttribute('href') || '').split(/[\\/]/).pop().split(/[?#]/)[0].slice(0, 256);
  }
  window.addEventListener('error', event => {
    if (event.target instanceof Element) report('resource-error', { resource: resource(event.target), tag: event.target.tagName });
    else { report('runtime-error', { message: String(event.message || event.error || '').slice(0, 8000),
      source: String(event.filename || '').slice(0, 2000), line: event.lineno || 0, column: event.colno || 0, stack: String(event.error?.stack || '').slice(0, 16000) }); failureContext(); }
  }, true);
  window.addEventListener('unhandledrejection', event => { report('unhandled-rejection', {
    message: String(event.reason?.message || event.reason || '').slice(0, 8000), stack: String(event.reason?.stack || '').slice(0, 16000) }); failureContext(); });
  document.addEventListener('securitypolicyviolation', event => report('csp-violation', {
    directive: String(event.effectiveDirective || '').slice(0, 256), source: String(event.blockedURI || '').split(/[?#]/)[0].slice(0, 2000),
    line: event.lineNumber || 0, column: event.columnNumber || 0 }));
  frame();
})();
