const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

function styledApp(t, saved) {
  const app = createApp(t, saved);
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  return { ...app, rule: selector => [...style.sheet.cssRules].find(rule => rule.selectorText === selector)?.style };
}

test('menu heads stay text-only and file actions align with the right edge', t => {
  const app = styledApp(t);
  const heads = [...app.document.querySelectorAll('[data-main-menu] > button')];
  assert.ok(heads.length > 0);
  assert.equal(heads.some(head => head.querySelector('[data-menu-icon]')), false);
  assert.equal(app.rule('#header-actions').justifyContent, 'flex-end');
  assert.equal(app.rule('#header-actions .functionbar').justifyContent, 'flex-end');
  assert.equal(app.rule('.header-utilities').marginLeft, '0px');
  app.click(heads[0]);
  assert.ok(app.document.querySelector('[data-menu-action="search"] [data-menu-icon]'));
  app.click(app.row('README.md')); app.action('view');
  assert.equal(app.document.querySelector('[data-lister] [data-main-menu] > button [data-menu-icon]'), null);
});

test('file-action right clicks suppress all popup menus and retain text editing menus', t => {
  const app = styledApp(t);
  for (const button of app.document.querySelectorAll('#functionbar button')) {
    const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    button.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, button.textContent);
    const context = JSON.parse(button.closest('[data-vscode-context]').dataset.vscodeContext);
    assert.equal(context.preventDefaultContextMenuItems, true);
    assert.equal(context.webviewSection, 'fileActions');
    assert.equal(app.document.querySelector('[data-context-menu]'), null);
  }
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  app.document.querySelector('.path-input').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

test('ordinary file names have no empty marker gutter and parent rows contain only an ellipsis', t => {
  const app = styledApp(t);
  assert.equal(app.document.querySelector('.file-table').style.getPropertyValue('--file-marker-width'), '0px');
  assert.equal(app.rule('.filename::before').width, 'var(--file-marker-width, 0px)');
  assert.equal(app.rule('.file-table th.filename-column button').paddingLeft, app.rule('.parent-row .filename').paddingLeft);
  assert.match(app.rule('.file-table th.filename-column button').paddingLeft, /var\(--icon-base-size\)/);
  for (const parent of app.document.querySelectorAll('[data-parent]')) {
    assert.equal(parent.querySelector('.filename').textContent, '…');
    assert.equal(parent.querySelector('[data-icon-reviewed]'), null);
  }
  assert.equal(app.rule('.cut-marker, .hidden-marker').position, 'absolute');
});

test('all file names keep one shared text edge with single and combined markers', t => {
  const p = () => ({ tabs: ['C:/one'], tab: 0, selected: ['hidden'], cursor: 'hidden', filter: '', sort: 'name' });
  const app = styledApp(t, { version: 1, active: 0, panes: [p(), p()], folders: { 'C:/one': [
    { id: 'hidden', name: 'Hidden.txt', type: 'text', hidden: true },
    { id: 'normal', name: 'Normal.txt', type: 'text' }
  ] } });
  const table = app.document.querySelector('.pane.active .file-table');
  const hidden = app.row('Hidden.txt'), ordinary = app.row('Normal.txt');
  assert.equal(table.style.getPropertyValue('--file-marker-width'), '0px');
  assert.equal(app.rule('.filename').gap, '0px');
  assert.equal(ordinary.querySelector('.cut-marker,.hidden-marker'), null);
  assert.equal(app.rule('.filename::before').flex, '0 0 var(--file-marker-width, 0px)');
  app.action('clipboard-cut');
  assert.equal(table.style.getPropertyValue('--file-marker-width'), '16px');
  assert.ok(hidden.querySelector('.cut-marker')); assert.ok(hidden.querySelector('.hidden-marker'));
  assert.equal(hidden.querySelector('.hidden-marker').parentElement, hidden.querySelector('.fileicon').closest('.git-icon,.filename-icon'));
  app.action('clipboard-copy');
  assert.equal(table.style.getPropertyValue('--file-marker-width'), '8px');
  assert.ok(hidden.classList.contains('is-copied')); assert.equal(hidden.querySelector('.cut-marker'), null);
  const name = hidden.querySelector('[data-filename]');
  app.action('rename-one');
  assert.ok(name.querySelector('input.inline-rename'));
  app.key('Escape', {}, name.querySelector('input'));
  assert.equal(ordinary.querySelector('.filename').style.marginLeft, '');
});

test('address and popup icons use the same square with explicit centered alignment', t => {
  const app = styledApp(t);
  assert.equal(app.rule('.menu-icon').display, 'inline-block');
  assert.equal(app.rule('.menu-icon').alignSelf, 'center');
  assert.equal(app.rule('.menu-icon').getPropertyValue('--icon-size'), '');
  const address = app.rule('.pathbar');
  assert.equal(address.getPropertyValue('--icon-size'), '');
  const location = app.rule('.location-context-icon');
  assert.equal(location.width, 'var(--icon-size)');
  assert.equal(location.height, 'var(--icon-size)');
  const tab = app.document.querySelector('.tab');
  tab.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  for (const action of ['copy-path', 'close-tab']) {
    const icon = app.document.querySelector(`[data-context-action="${action}"] [data-menu-icon]`);
    assert.ok(icon);
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
  }
});

test('refresh glyph bounds and its rotation box retain the same center at every icon size', t => {
  const app = styledApp(t);
  const refresh = app.rule('[data-refresh-icon]');
  for (const size of [14, 16, 24]) {
    const width = refresh.width === 'var(--icon-size)' ? size : parseFloat(refresh.width);
    const height = refresh.height === 'var(--icon-size)' ? size : parseFloat(refresh.height);
    for (const name of ['refresh', 'loading']) {
      const fit = app.window.CommanderIconFontMetrics[name];
      const bounds = require('../scripts/true-type-metrics.cjs').readGlyph(fs.readFileSync(path.join(__dirname, '../media/codicon.ttf')), fit.codePoint);
      const centerX = size * fit.left + (bounds.bounds.xMin + bounds.bounds.xMax) * size * fit.fontScale / (2 * bounds.unitsPerEm);
      const centerY = size * (fit.top + fit.fontScale) - (bounds.bounds.yMin + bounds.bounds.yMax) * size * fit.fontScale / (2 * bounds.unitsPerEm);
      assert.ok(Math.abs(centerX - width / 2) < 1e-8, `${name}: horizontal rotation center at ${size}px`);
      assert.ok(Math.abs(centerY - height / 2) < 1e-8, `${name}: vertical rotation center at ${size}px`);
    }
  }
});

test('tab icons use the menu icon size and an explicitly centered box', t => {
  const app = styledApp(t), tab = app.rule('.tab-icon');
  assert.equal(tab.getPropertyValue('--icon-size'), app.rule('.menu-icon').getPropertyValue('--icon-size'));
  assert.equal(tab.alignSelf, 'center');
});

test('the favorite badge occupies a clipped lower-left recess separate from the main icon', t => {
  const app = styledApp(t), badge = app.rule('.location-favorite-badge');
  assert.equal(badge.left, '-2px'); assert.equal(badge.bottom, '-2px');
  assert.equal(badge.overflow, 'hidden');
  const main = app.rule('.location-context-icon:has([data-location-badge]) > :first-child');
  assert.ok(main?.clipPath.includes('polygon('));
});
