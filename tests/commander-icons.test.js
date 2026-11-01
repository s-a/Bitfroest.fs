const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function renderer(t) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.document, 'fonts', { get() { throw new Error('Runtime font measurement is not allowed.'); } });
  dom.window.HTMLCanvasElement.prototype.getContext = () => { throw new Error('Runtime glyph measurement is not allowed.'); };
  for (const file of ['icon-font-metrics.js', 'workbench-icons.js', 'git-status-icons.js', 'commander-icons.js']) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../media', file), 'utf8'));
  }
  return dom.window;
}

test('central icon output rejects unmeasured fonts and unknown or untrusted sources', t => {
  const w = renderer(t), icons = w.CommanderIcons;
  assert.throws(() => icons.font('unknown'), /unmeasured|unknown/i);
  assert.throws(() => icons.svg('workbench', 'unknown'), /unknown/i);
  assert.throws(() => icons.native('https://example.invalid/icon.png'), /native/i);
  assert.throws(() => icons.theme('x" onclick="bad'), /theme/i);
  assert.throws(() => icons.theme('undeclared-theme'), /theme/i);
  assert.throws(() => icons.font('refresh', { class: 'codicon codicon-unknown' }), /central renderer/i);
  w.CommanderWorkbenchIcons.injected = '<svg viewBox="0 0 16 16"><script>bad()</script></svg>';
  assert.throws(() => icons.svg('workbench', 'injected'), /invalid|unknown/i);
});

test('approved fonts, vectors and native images pass through one dimensioned output contract', t => {
  const w = renderer(t), icons = w.CommanderIcons;
  const font = icons.element('refresh', { 'data-refresh-icon': '', class: 'refresh-test' });
  assert.equal(font.dataset.iconReviewed, 'font:refresh');
  assert.ok(font.classList.contains('codicon-refresh'));
  icons.setFont(font, 'loading', true);
  assert.equal(font.dataset.iconReviewed, 'font:loading');
  assert.equal(font.hasAttribute('data-refresh-icon'), true);
  assert.ok(font.classList.contains('codicon-modifier-spin'));
  assert.equal(font.classList.contains('codicon-refresh'), false);
  const template = w.document.createElement('template');
  template.innerHTML = icons.svg('status', 'clean') + icons.native('data:image/png;base64,AAAA');
  for (const element of template.content.children) {
    assert.ok(element.dataset.iconReviewed);
    assert.equal(element.getAttribute('width'), '16');
    assert.equal(element.getAttribute('height'), '16');
  }
  assert.match(icons.svg('workbench', 'git'), /currentColor/);
  assert.match(icons.svg('workbench', 'file-zip'), /preserveAspectRatio="xMidYMid meet"/);
});

test('all bundled SVG resources are accepted and retain their shape geometry', t => {
  const w = renderer(t), icons = w.CommanderIcons;
  for (const [collection, registry] of [['workbench', w.CommanderWorkbenchIcons], ['status', w.CommanderStatusIcons]]) {
    for (const [name, source] of Object.entries(registry)) {
      const original = w.document.createElement('template'), result = w.document.createElement('template');
      original.innerHTML = source; result.innerHTML = icons.svg(collection, name);
      assert.equal(result.content.firstElementChild.innerHTML, original.content.firstElementChild.innerHTML, name);
      assert.equal(result.content.firstElementChild.getAttribute('viewBox'), original.content.firstElementChild.getAttribute('viewBox'));
    }
  }
});

test('static and spinning icons share text alignment and rotate around their own center', t => {
  const w = renderer(t), style = w.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/icon-metrics.css'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '../media/codicons.css'), 'utf8').replace(/@import[^;]+;/, '');
  w.document.head.append(style);
  const icon = w.CommanderIcons.element('refresh'); w.document.body.append(icon);
  const initial = w.getComputedStyle(icon);
  assert.equal(initial.verticalAlign, 'middle');
  const size = [initial.width, initial.height, initial.lineHeight];
  w.CommanderIcons.setFont(icon, 'loading', true);
  const spinning = w.getComputedStyle(icon);
  assert.equal(spinning.verticalAlign, 'middle');
  assert.deepEqual([spinning.width, spinning.height, spinning.lineHeight], size);
  assert.equal(spinning.transformOrigin, '50% 50%');
  const vector = w.document.createElement('span'); vector.innerHTML = w.CommanderIcons.svg('workbench', 'loading'); w.document.body.append(vector);
  assert.equal(w.getComputedStyle(vector.firstElementChild).verticalAlign, 'middle');
});

test('unapproved font, SVG and file icons remain invisible', t => {
  const w = renderer(t), style = w.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/icon-metrics.css'), 'utf8'); w.document.head.append(style);
  const host = w.document.createElement('div');
  host.innerHTML = '<span class="codicon codicon-refresh"></span><span class="icon-font"></span><span class="fileicon"></span><svg viewBox="0 0 16 16"></svg>';
  w.document.body.append(host);
  for (const icon of host.children) assert.equal(w.getComputedStyle(icon).visibility, 'hidden');
  const approved = w.CommanderIcons.element('refresh'); host.append(approved);
  assert.equal(w.getComputedStyle(approved).visibility, 'visible');
});

test('icons from different fonts use their own measurements through the same output function', t => {
  const { generateFontSet } = require('../scripts/generate-icon-metrics.cjs');
  const font = fs.readFileSync(path.join(__dirname, '../media/codicon.ttf'));
  const second = Buffer.from(font);
  for (let index = 0; index < second.readUInt16BE(4); index++) {
    const offset = 12 + index * 16;
    if (second.toString('ascii', offset, offset + 4) === 'head') {
      const head = second.readUInt32BE(offset + 8); second.writeUInt16BE(second.readUInt16BE(head + 18) * 2, head + 18);
    }
  }
  const result = generateFontSet([
    { id: 'first', file: 'first.ttf', glyphs: { sample: 0xea6a }, font },
    { id: 'second', file: 'second.ttf', glyphs: { sample: 0xea6a }, font: second }
  ]);
  const w = renderer(t);
  w.eval(result.catalog);
  w.eval(fs.readFileSync(path.join(__dirname, '../media/commander-icons.js'), 'utf8'));
  const first = w.CommanderIcons.element('first:sample'), other = w.CommanderIcons.element('second:sample');
  assert.ok(first.classList.contains('icon-font-first--sample'));
  assert.ok(other.classList.contains('icon-font-second--sample'));
  assert.equal(first.dataset.iconReviewed, 'font:first:sample');
  assert.equal(other.dataset.iconReviewed, 'font:second:sample');
  assert.equal(w.CommanderIconFontMetrics['second:sample'].fontScale, 1);
  assert.equal(w.CommanderIconFontMetrics['first:sample'].fontScale, 1);
  assert.notEqual(w.CommanderIconFontMetrics['second:sample'].left, w.CommanderIconFontMetrics['first:sample'].left);
  w.CommanderIcons.setFont(first, 'second:sample');
  assert.equal(first.classList.contains('icon-font-first--sample'), false);
  assert.equal(first.classList.contains('icon-font-first'), false);
  assert.ok(first.classList.contains('icon-font-second--sample'));
  assert.match(result.css, /font-family:commander-first-metrics/);
  assert.match(result.css, /font-family:commander-second-metrics/);
});

test('font and glyph names cannot collide across registered families', t => {
  const { generateFontSet } = require('../scripts/generate-icon-metrics.cjs');
  const font = fs.readFileSync(path.join(__dirname, '../media/codicon.ttf'));
  const result = generateFontSet([
    { id: 'a', file: 'a.ttf', glyphs: { 'b-c': 0xea6a }, font },
    { id: 'a-b', file: 'ab.ttf', glyphs: { c: 0xeb37 }, font }
  ]);
  const w = renderer(t); w.eval(result.catalog);
  assert.notEqual(w.CommanderIconFontMetrics['a:b-c'].classes.at(-1), w.CommanderIconFontMetrics['a-b:c'].classes.at(-1));
});

test('location compositions contain exactly one filled star within the shared address icon area', t => {
  const w = renderer(t), style = w.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); w.document.head.append(style);
  const rules = [...style.sheet.cssRules];
  const scopes = rules.find(rule => rule.selectorText?.includes('.main-menu, .menu-surface, .pathbar'));
  assert.equal(scopes.style.getPropertyValue('--text-icon-size'), '');
  assert.equal(scopes.style.getPropertyValue('--icon-size'), 'var(--icon-base-size)');
  for (const kind of ['', 'git', 'zip']) {
    const host = w.document.createElement('span'); host.className = 'pathbar'; host.innerHTML = w.CommanderIcons.location(kind); w.document.body.append(host);
    const icon = host.firstElementChild, box = w.getComputedStyle(icon);
    assert.equal(icon.dataset.iconReviewed, `location:${kind || 'favorites'}`);
    assert.equal(box.width, 'var(--icon-size)'); assert.equal(box.height, 'var(--icon-size)');
    assert.equal(icon.querySelectorAll('.codicon-star-full').length, 1);
    const badge = icon.querySelector('[data-location-badge]');
    assert.equal(Boolean(badge), Boolean(kind));
    if (badge) {
      const size = w.getComputedStyle(badge);
      assert.equal(size.width, 'var(--icon-size)'); assert.equal(size.height, 'var(--icon-size)');
      assert.equal(size.getPropertyValue('--icon-size'), 'var(--icon-badge-size)');
      assert.equal(size.left, '-2px'); assert.equal(size.bottom, '-2px');
    }
  }
  assert.throws(() => w.CommanderIcons.location('unknown'), /unknown/i);
});
