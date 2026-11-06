const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

function styledApp(t, options = {}) {
  let style;
  const app = createApp(t, null, { ...options, beforeApp(context) {
    style = context.document.createElement('style');
    style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
    context.document.head.append(style);
    options.beforeApp?.(context);
  } });
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

test('the address has a viewport containing block and equal vertical button clearance at each icon size', t => {
  const app = styledApp(t);
  for (const size of [12, 16, 28, 48]) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { iconSize: size } } }));
    for (const pane of app.document.querySelectorAll('.pane')) {
      const address = pane.querySelector('.location-header .pathbar');
      const wrapper = address.parentElement;
      assert.equal(wrapper.parentElement, pane.querySelector('[data-file-grid]'));
      assert.equal(address.closest('.ag-header-group-cell'), null);
      const rowHeight = parseFloat(pane.querySelector('.ag-header-row').style.height);
      assert.equal(rowHeight, Math.max(26, app.window.BitfroestIcons.layout().control + 6));
      const style = app.window.getComputedStyle(address);
      assert.equal(style.paddingTop, '3px'); assert.equal(style.paddingBottom, '3px');
      assert.equal(style.borderBottomWidth, '0px');
      assert.equal(app.window.getComputedStyle(address.querySelector('[data-refresh]')).position, 'static');
    }
  }
});

test('content measurement retains the native sizing margin and uses the styled scrollbar width', async t => {
  const app = styledApp(t);
  await new Promise(resolve => setTimeout(resolve, 80));
  for (const side of [0, 1]) {
    const grid = app.grid(side);
    assert.deepEqual(Array.from(grid.getAllDisplayedColumns(), column => column.getColId()), ['name', 'type', 'size', 'date']);
    const measured = grid.getColumn('date').getActualWidth();
    grid.setGridOption('autoSizePadding', undefined);
    grid.autoSizeColumns(['date']);
    assert.equal(measured, grid.getColumn('date').getActualWidth(), 'initial measurement matches the native sizing defaults');
    assert.equal(grid.getGridOption('scrollbarWidth'), parseFloat(app.rule('[data-file-grid] ::-webkit-scrollbar').width));
  }
});

test('Quick Diff defers file column measurement until both file lists are visible again', async t => {
  const observers = new Map();
  const extraWidth = 40;
  let updated = false;
  const app = styledApp(t, {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { observers.set(target, this.callback); }
      unobserve(target) { observers.delete(target); }
      disconnect() {}
    },
    beforeApp({ window }) {
      const prototype = window.HTMLElement.prototype;
      const { get } = Object.getOwnPropertyDescriptor(prototype, 'offsetWidth');
      Object.defineProperty(prototype, 'offsetWidth', { configurable: true, get() {
        const pane = this.closest('[data-pane]');
        if (pane?.matches('.quick-diff-source, .has-quick-diff')) return 0;
        const width = get.call(this);
        return updated && pane && this.matches('form[style*="position: fixed"]') ? width + extraWidth : width;
      } });
    }
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  const grids = [app.grid(0), app.grid(1)];
  const widths = () => grids.map(grid => grid.getColumn('date').getActualWidth());
  const before = widths();
  const button = app.document.querySelector('[data-pane="0"] [data-quick-diff-toggle]');
  app.click(button);
  assert.equal(button.dataset.mode, 'folder');

  updated = true;
  app.window.dispatchEvent(new app.window.MessageEvent('message', {
    data: { type: 'file-settings', settings: { iconSize: 28 } }
  }));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(widths(), before, 'hidden grids retain their measured column widths');

  button.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  assert.equal(button.dataset.mode, 'off');
  for (const target of app.document.querySelectorAll('[data-file-grid]')) {
    observers.get(target)?.([{ target }]);
  }
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(widths(), before.map(width => width + extraWidth));
});
