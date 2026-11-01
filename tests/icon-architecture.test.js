const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectIconSource, checkProduct } = require('../scripts/check-icons.cjs');

test('direct SVG, font, native and forged approval output is rejected', () => {
  for (const source of [
    'view.innerHTML = `<svg viewBox="0 0 16 16"></svg>`;',
    'view.innerHTML = `<img class="fileicon" src="${url}">`;',
    'node.className = `codicon codicon-${name}`;',
    'node.classList.add("codicon-refresh");',
    'node.setAttribute("class", "codicon codicon-refresh");',
    'document.createElementNS("http://www.w3.org/2000/svg", "svg");',
    'document.createElement("img");',
    'new Image();',
    'view.innerHTML = window.CommanderStatusIcons.clean;',
    'view.innerHTML = `<span data-icon-reviewed="font:refresh"></span>`;'
  ]) assert.ok(inspectIconSource(source).length, source);
  assert.ok(inspectIconSource('<span class="codicon codicon-refresh"></span>', 'media/new.html').length);
  assert.ok(inspectIconSource('.indicator::before{content:"✓"}', 'media/new.css').length);
  assert.ok(inspectIconSource('view.innerHTML = `<button>×</button>`;').length);
  assert.deepEqual(inspectIconSource('view.innerHTML = window.CommanderIcons.font("refresh");'), []);
});

test('every product icon output uses the central renderer', () => {
  checkProduct();
});
