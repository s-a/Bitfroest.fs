const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

function styledApp(t, options) {
  const app = createApp(t, null, options);
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  const rule = selector => [...style.sheet.cssRules].find(rule => rule.selectorText === selector)?.style;
  return { ...app, rule };
}

test('column captions retain complete names and independent sort indicators in both panes', t => {
  const app = styledApp(t);
  for (const pane of app.document.querySelectorAll('.pane')) {
    const header = pane.querySelector('[data-column="name"]');
    const button = header.querySelector('button');
    const label = button.querySelector('.column-caption');
    assert.ok(label);
    assert.equal(button.title, label.textContent);
    assert.equal(button.getAttribute('aria-label'), label.textContent);
    assert.equal(header.getAttribute('aria-sort'), 'ascending');
    assert.equal(button.querySelector('.column-sort').getAttribute('aria-hidden'), 'true');
    app.click(button);
    assert.equal(pane.querySelector('[data-column="name"]').getAttribute('aria-sort'), 'descending');
    app.click(pane.querySelector('[data-sort="size"]'));
    assert.equal(pane.querySelector('[data-column="name"]').getAttribute('aria-sort'), 'none');
    assert.equal(pane.querySelector('[data-column="size"]').getAttribute('aria-sort'), 'ascending');
  }
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});

test('column heads share the menu font and keep captions on one line', t => {
  const app = styledApp(t);
  const header = app.document.querySelector('th');
  const computed = element => app.window.getComputedStyle(element);
  assert.equal(computed(header).borderRightWidth, '0px');
  assert.equal(app.rule('.file-table th button').height, 'var(--icon-row-size)');
  assert.equal(app.rule('.file-table th').fontSize, app.rule('.main-menu').fontSize);
  const label = header.querySelector('.column-caption');
  assert.ok(label);
  assert.equal(computed(label).whiteSpace, 'nowrap');
  assert.equal(computed(label).overflowWrap, 'normal');
  assert.equal(computed(label).textOverflow, 'ellipsis');
  const hover = app.rule('.file-table th button:hover');
  assert.equal(hover?.background, 'transparent');
  assert.equal(hover.textDecoration, 'underline');
  assert.equal(app.rule('.column-resize').width, '7px');
  assert.equal(app.rule('.column-resize::after').width, '1px');
  assert.equal(computed(app.row('README.md').querySelector('[data-filename]')).textOverflow, 'ellipsis');
});

test('file scrollbars retain native scrolling and use theme slider states', t => {
  const app = styledApp(t);
  assert.equal(app.window.getComputedStyle(app.document.querySelector('.list')).overflow, 'auto');
  assert.equal(app.rule('.list::-webkit-scrollbar')?.width, '12px');
  assert.match(app.rule('.list::-webkit-scrollbar-thumb').backgroundColor, /--vscode-scrollbarSlider-background/);
  assert.match(app.rule('.list::-webkit-scrollbar-thumb:hover').backgroundColor, /--vscode-scrollbarSlider-hoverBackground/);
  assert.match(app.rule('.list::-webkit-scrollbar-thumb:active').backgroundColor, /--vscode-scrollbarSlider-activeBackground/);
  assert.equal(app.rule('.column-sort').flexShrink, '0');
  assert.equal(app.rule('.column-sort').getPropertyValue('--icon-size'), '');
  assert.equal(app.rule('.column-sort').alignSelf, 'center');
  assert.equal(app.rule('.file-table th button:focus-visible').outlineStyle, 'solid');
});
