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
    const button = header.querySelector('[data-sort]');
    const label = button.querySelector('.column-caption');
    assert.ok(label);
    assert.equal(header.getAttribute('role'), 'columnheader');
    assert.equal(label.textContent, 'Name');
    assert.equal(header.getAttribute('aria-sort'), 'ascending');
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
  const header = app.document.querySelector('.ag-header-cell');
  const computed = element => app.window.getComputedStyle(element);
  assert.equal(computed(header).borderRightWidth, '0px');
  assert.equal(app.rule('.file-table .ag-header-cell button').height, 'var(--icon-row-size)');
  assert.equal(app.rule('.file-table .ag-header-cell').fontSize, app.rule('.main-menu').fontSize);
  const label = header.querySelector('.column-caption');
  assert.ok(label);
  assert.equal(computed(label).whiteSpace, 'nowrap');
  assert.equal(computed(label).overflowWrap, 'normal');
  assert.equal(computed(label).textOverflow, 'ellipsis');
  const hover = app.rule('.file-table .ag-header-cell button:hover');
  assert.equal(hover?.background, 'transparent');
  assert.equal(hover.textDecoration, 'underline');
  assert.equal(app.rule('.ag-header-cell-resize').width, '7px');
  assert.equal(app.rule('.ag-header-cell-resize').right, '0px');
  assert.equal(app.rule('.ag-header-cell-resize::after').width, '1px');
  assert.equal(computed(app.row('README.md').querySelector('[data-filename]')).textOverflow, 'ellipsis');
});

test('file scrollbars retain native scrolling and use theme slider states', t => {
  const app = styledApp(t);
  assert.equal(app.rule('.list:has([data-file-grid])').overflow, 'hidden');
  assert.ok(app.document.querySelector('.ag-body-horizontal-scroll-viewport'));
  assert.equal(app.rule('[data-file-grid]').getPropertyValue('--ag-wrapper-border-radius'), '0');
  assert.equal(app.rule('.list::-webkit-scrollbar')?.width, '12px');
  assert.match(app.rule('.list::-webkit-scrollbar-thumb').backgroundColor, /--vscode-scrollbarSlider-background/);
  assert.match(app.rule('.list::-webkit-scrollbar-thumb:hover').backgroundColor, /--vscode-scrollbarSlider-hoverBackground/);
  assert.match(app.rule('.list::-webkit-scrollbar-thumb:active').backgroundColor, /--vscode-scrollbarSlider-activeBackground/);
  assert.equal(app.rule('.column-sort').flexShrink, '0');
  assert.equal(app.rule('.column-sort').getPropertyValue('--icon-size'), '');
  assert.equal(app.rule('.column-sort').alignSelf, 'center');
  assert.equal(app.rule('.file-table .ag-header-cell button:focus-visible').outlineStyle, 'solid');
});

test('cell renderers leave intrinsic width available for native content autosizing', t => {
  const app = styledApp(t);
  assert.equal(app.rule('.file-cell').width, '');
  assert.equal(app.rule('[data-file-grid] .ag-cell-wrapper, [data-file-grid] .ag-cell-value')?.width || '', '');
});

test('content measurement adds no blank tail and uses the styled scrollbar width', async t => {
  const app = styledApp(t);
  await new Promise(resolve => setTimeout(resolve, 80));
  for (const side of [0, 1]) {
    const grid = app.grid(side);
    assert.deepEqual(Array.from(grid.getAllDisplayedColumns(), column => column.getColId()), ['name', 'type', 'size', 'date']);
    const measured = grid.getColumn('date').getActualWidth();
    grid.setGridOption('autoSizePadding', 0);
    grid.autoSizeColumns(['date']);
    assert.equal(measured, grid.getColumn('date').getActualWidth(), 'initial measurement has no extra trailing padding');
    assert.equal(grid.getGridOption('scrollbarWidth'), parseFloat(app.rule('[data-file-grid] ::-webkit-scrollbar').width));
  }
});
