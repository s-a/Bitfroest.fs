const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('embedding diagnostics expose hidden outer containers and host obstructions without reading their contents', t => {
  const dom = new JSDOM('<html data-startup-id="start" data-document-id="view"><body></body></html>', { runScripts: 'outside-only' });
  const host = new JSDOM('<html><body><section id="host-container" style="opacity:0"><iframe id="active-frame"></iframe></section><aside id="cover">private content</aside></body></html>');
  t.after(() => { dom.window.close(); host.window.close(); });
  const { window } = dom, messages = [], frames = [], frame = host.window.document.querySelector('iframe');
  Object.defineProperty(window, 'frameElement', { value: frame });
  frame.getBoundingClientRect = () => ({ x: 10, y: 20, width: 200, height: 100 });
  host.window.document.elementFromPoint = () => host.window.document.getElementById('cover');
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.requestAnimationFrame = callback => { frames.push(callback); };
  window.eval(fs.readFileSync(path.join(__dirname, '../media/startup-diagnostics.js'), 'utf8'));
  frames.shift()();
  const embedding = messages.find(message => message.event.name === 'frame-observed').event.layout.embedding;
  assert.equal(embedding.host.connected, true);
  assert.equal(embedding.host.ancestors[0].id, 'host-container');
  assert.equal(embedding.host.ancestors[0].css.opacity, '0');
  assert.equal(embedding.host.hit.element.id, 'cover');
  assert.equal(embedding.host.hit.withinFrame, false);
  assert.equal(embedding.host.document.visibility, 'prerender');
  assert.equal(JSON.stringify(embedding).includes('private content'), false);
});

test('document diagnostics report lifecycle, resources, frames and errors after readiness', t => {
  const dom = new JSDOM('<html data-startup-id="start" data-document-id="view"><body><main>Loading</main></body></html>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [], frames = [];
  let acquired = 0;
  window.acquireVsCodeApi = () => { acquired++; return { postMessage: message => messages.push(message) }; };
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.eval(fs.readFileSync(path.join(__dirname, '../media/startup-diagnostics.js'), 'utf8'));
  window.dispatchEvent(new window.Event('bitfroest-started'));
  assert.ok(messages.some(message => message.event.name === 'document-start'));
  assert.ok(frames.length > 0);
  frames.shift()();
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'late failure', filename: 'app.js', lineno: 12 }));
  const link = window.document.createElement('link'); link.rel = 'stylesheet'; link.href = 'app.css';
  window.document.head.append(link); link.dispatchEvent(new window.Event('error'));
  const violation = new window.Event('securitypolicyviolation');
  Object.assign(violation, { effectiveDirective: 'style-src-elem', blockedURI: 'https://example.invalid/app.css?token=private', lineNumber: 1 });
  window.document.dispatchEvent(violation);
  const events = messages.map(message => message.event);
  assert.ok(events.some(event => event.name === 'document-start'));
  assert.ok(events.some(event => event.name === 'application-ready'));
  assert.ok(events.some(event => event.name === 'frame-observed' && typeof event.width === 'number'));
  assert.ok(events.some(event => event.name === 'runtime-error' && event.message === 'late failure' && event.line === 12));
  assert.ok(events.some(event => event.name === 'resource-error' && event.resource === 'app.css'));
  assert.ok(events.some(event => event.name === 'csp-violation' && event.directive === 'style-src-elem' && event.source === 'https://example.invalid/app.css'));
  assert.ok(messages.every((message, index) => message.version === 1 && message.startupId === 'start' && message.documentId === 'view' && message.sequence === index + 1));
  assert.equal(acquired, 1);
});

test('frame diagnostics distinguish populated panes, hidden lists and viewport obstructions without file contents', t => {
  const dom = new JSDOM('<html data-startup-id="start" data-document-id="view"><body><main id="panes"><section class="pane" data-pane="0"><div class="list" style="visibility:hidden"><table><tbody><tr data-id="private"><td>private-file-name</td></tr></tbody></table></div></section></main><div id="cover"></div></body></html>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [], frames = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 500, height: 400, top: 0, left: 0, right: 500, bottom: 400 });
  window.document.elementFromPoint = () => window.document.getElementById('cover');
  window.eval(fs.readFileSync(path.join(__dirname, '../media/startup-diagnostics.js'), 'utf8'));
  frames.shift()();
  const event = messages.find(message => message.event.name === 'frame-observed').event;
  assert.equal(event.layout.panes[0].rows, 1);
  assert.equal(event.layout.panes[0].list.css.visibility, 'hidden');
  assert.equal(event.layout.panes[0].pane.rect.width, 500);
  assert.equal(event.layout.panes[0].hit.element.id, 'cover');
  assert.equal(event.layout.panes[0].hit.withinPane, false);
  assert.equal(event.layout.paintVerified, false);
  assert.equal(JSON.stringify(event).includes('private-file-name'), false);
});

test('diagnostic probes acknowledge the live application even when frame callbacks never arrive', t => {
  const dom = new JSDOM('<html data-startup-id="start" data-document-id="view"><body><main id="panes"></main></body></html>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.requestAnimationFrame = () => 1;
  window.eval(fs.readFileSync(path.join(__dirname, '../media/startup-diagnostics.js'), 'utf8'));
  window.BitfroestDiagnostics.registerState(() => ({ ready: true, snapshotId: 'current' }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'diagnostic-probe', startupId: 'start', documentId: 'view', requestId: 'probe-1' } }));
  const response = messages.find(message => message.event.name === 'probe-received');
  assert.equal(response.event.requestId, 'probe-1');
  assert.equal(response.event.application.snapshotId, 'current');
  assert.equal(response.event.framePending, true);
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'late failure' }));
  assert.ok(messages.some(message => message.event.name === 'failure-context' && message.event.application.ready));
});

test('large diagnostic contexts remain deliverable and explicitly identify omitted details', t => {
  const dom = new JSDOM('<html data-startup-id="start" data-document-id="view"><body></body></html>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.requestAnimationFrame = () => 1;
  window.eval(fs.readFileSync(path.join(__dirname, '../media/startup-diagnostics.js'), 'utf8'));
  window.BitfroestDiagnostics.registerState(() => ({ repositories: Array.from({ length: 500 }, () => ({ path: 'x'.repeat(4096) })) }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'diagnostic-probe', startupId: 'start', documentId: 'view', requestId: 'large' } }));
  const response = messages.find(message => message.event.name === 'probe-received');
  assert.ok(JSON.stringify(response).length < 32000);
  assert.equal(response.event.detailsTruncated, true);
  assert.equal(response.event.requestId, 'large');
});

test('browser diagnostics capture window geometry and frame intersection independently of DOM readiness', t => {
  const dom = new JSDOM('<html data-startup-id="start" data-document-id="view"><body><main id="panes"></main></body></html>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, messages = []; let observe;
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message) });
  window.requestAnimationFrame = () => 1;
  window.IntersectionObserver = class {
    constructor(callback) { observe = callback; }
    observe() {} disconnect() {}
  };
  Object.defineProperty(window, 'outerWidth', { value: 417 });
  Object.defineProperty(window, 'outerHeight', { value: 279 });
  Object.defineProperty(window, 'screenX', { value: -5 });
  Object.defineProperty(window, 'frameElement', { value: window.document.createElement('iframe') });
  window.eval(fs.readFileSync(path.join(__dirname, '../media/startup-diagnostics.js'), 'utf8'));
  observe([{ isIntersecting: false, intersectionRatio: 0, boundingClientRect: { x: 0, y: 0, width: 406, height: 244 }, intersectionRect: { x: 0, y: 0, width: 0, height: 0 }, rootBounds: null, time: 5 }]);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'diagnostic-probe', startupId: 'start', documentId: 'view', requestId: 'window' } }));
  const event = messages.findLast(message => message.event.name === 'probe-received').event;
  assert.equal(event.layout.browserWindow.outerWidth, 417);
  assert.equal(event.layout.browserWindow.screenX, -5);
  assert.equal(event.layout.embedding.intersection.isIntersecting, false);
  assert.equal(event.layout.embedding.intersection.rootBounds, null);
  assert.equal(event.layout.embedding.embedded, true);
  assert.equal(event.layout.paintVerified, false);
});
