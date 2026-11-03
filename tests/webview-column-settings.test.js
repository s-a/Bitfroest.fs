const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createApp } = require('./support/webview.cjs');

const sets = [{ id: 'custom', name: 'Custom', columns: [
  { id: 'full', title: 'File <name>', field: '[=tc.fullname]', width: 340, align: 'left' },
  { id: 'bytes', title: 'Bytes', field: '[=tc.size]', width: 96, align: 'right' },
  { id: 'hidden', title: 'Hidden', field: '[=tc.ext]', visible: false },
  { id: 'plugin', title: 'Plugin', field: '[=wdx.foo]', width: 120, align: 'center' }
]}];
const configured = t => createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
async function settled(app, side = 0) {
  for (let attempt = 0; attempt < 100 && app.grid(side).getGridOption('rowBuffer') !== 10; attempt++) await delay(5);
  assert.equal(app.grid(side).getGridOption('rowBuffer'), 10, 'content measurement releases the complete row buffer');
}
const width = (app, key, side = 0) => app.grid(side).getColumn(key).getActualWidth();
const resize = (app, key, value, side = 0) => app.grid(side).setColumnWidths([{ key, newWidth: value }], true, 'uiColumnResized');

test('standard date headers sort complete dates and retain folder ordering', t => {
  const pane = () => ({ tabs: ['/left'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const files = [{ id: 'nov', name: 'November', type: 'folder', date: '02.11.2026 16:15:40' }, { id: 'aug', name: 'August', type: 'folder', date: '31.08.2026 19:09:55' }, { id: 'oct', name: 'October', type: 'folder', date: '30.10.2026 16:33:26' }];
  const catalog = require('../media/commander-column-settings').catalog;
  const app = createApp(t, { version: 1, active: 0, panes: [pane(), pane()], folders: { '/left': files } }, { columnSettings: { sets: [{ id: 'standard', name: 'Standard', columns: catalog }], activeSet: 'standard' } });
  const order = () => { const ids = []; app.grid().forEachNodeAfterFilterAndSort(node => { if (files.some(file => file.id === node.id)) ids.push(node.id); }); return ids; };
  app.click(app.document.querySelector('[data-sort="date"]'));
  assert.deepEqual(order(), ['aug', 'oct', 'nov']);
  app.click(app.document.querySelector('[data-sort="date"]'));
  assert.deepEqual(order(), ['nov', 'oct', 'aug']);
});

test('Linux masks Windows-only fields in restored column preferences', t => {
  const catalog = require('../media/commander-column-settings').catalog;
  const columns = catalog.map(column => ({ ...column, visible: ['name', 'archive', 'versionString'].includes(column.id) }));
  const app = createApp(t, null, { platform: 'linux', columnSettings: { sets: [{ id: 'standard', name: 'Standard', columns }], activeSet: 'standard' } });
  assert.equal(app.document.querySelector('.ag-header [data-column="archive"]'), null);
  assert.ok(app.document.querySelector('.ag-header [data-column="versionString"]'));
});

test('configured headings, real values, alignment and unavailable fields remain accessible', t => {
  const app = configured(t);
  const headers = [...app.document.querySelectorAll('.pane.active .ag-header-cell')];
  assert.deepEqual(headers.map(header => header.dataset.column), ['full', 'bytes', 'plugin']);
  assert.equal(headers[0].querySelector('.column-caption').textContent, 'Vollständiger Dateiname');
  assert.equal(app.row('README.md').querySelector('[data-cell="full"] [data-filename]').textContent, 'README.md');
  assert.equal(app.row('README.md').querySelector('[data-cell="bytes"]').textContent, '3264');
  assert.ok(app.row('README.md').querySelector('[data-cell="bytes"]').classList.contains('column-align-right'));
  assert.match(app.row('README.md').querySelector('[data-cell="plugin"]').textContent, /Nicht verfügbar.*wdx.foo/);
  assert.equal(JSON.parse(headers[0].dataset.vscodeContext).webviewSection, 'columns');
});

test('configuration changes retain paths and selected files while replacing columns', t => {
  const app = createApp(t); app.click(app.row('README.md')); const before = app.state();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'column-settings', settings: { sets, activeSet: 'custom' } } }));
  assert.equal(app.document.querySelector('.pane.active .ag-header-cell').dataset.column, 'full');
  assert.deepEqual(app.state().panes[0].selected, before.panes[0].selected);
  assert.deepEqual(app.state().panes[0].tabs, before.panes[0].tabs);
});

test('an all-hidden column set remains configurable and explains the empty view', t => {
  const app = createApp(t, null, { columnSettings: { sets: [{ id: 'empty', name: 'Empty', columns: [{ id: 'name', field: '[=tc.name]', visible: false }] }], activeSet: 'empty' } });
  assert.match(app.document.querySelector('.pane.active .list').textContent, /Keine sichtbaren Spalten/);
  assert.ok(app.document.querySelector('.pane.active [role="grid"]'));
});

test('custom IDs and HTML-like titles remain inert when sorting and resizing through the grid API', async t => {
  const id = 'odd"][data-evil="yes';
  const app = createApp(t, null, { columnSettings: { activeSet: 'unsafe', sets: [{ id: 'unsafe', name: 'Unsafe', columns: [{ id, title: '<img src=x onerror=alert(1)>', field: '[=tc.fullname]', width: 300 }] }] } });
  await settled(app);
  const header = app.document.querySelector('.pane.active .ag-header-cell');
  assert.equal(header.dataset.column, id); assert.equal(header.querySelector('img'), null);
  assert.equal(app.document.querySelector('[data-evil]'), null);
  app.click(header.querySelector('.column-caption'));
  resize(app, id, 360); await delay(5);
  assert.equal(width(app, id), 360);
  assert.equal(app.state().panes[0].sort, id);
});

test('column reorder uses the grid state and leaves the opposite pane unchanged', async t => {
  const app = configured(t); await settled(app);
  const other = app.grid(1).getColumnState().map(column => column.colId);
  app.grid().moveColumns(['bytes'], 0); await delay(5);
  assert.equal(app.grid().getColumnState()[0].colId, 'bytes');
  assert.equal(app.state().panes[0].columns[0].key, 'bytes');
  assert.deepEqual(app.grid(1).getColumnState().map(column => column.colId), other);
});

test('manual widths remain stable during selection and refresh without being stored as preferences', async t => {
  const app = configured(t); await settled(app);
  const configuredWidth = app.state().panes[0].columns.find(column => column.key === 'full').width;
  resize(app, 'full', 280); await delay(5);
  app.click(app.row('README.md')); app.action('select-all');
  assert.equal(width(app, 'full'), 280);
  app.action('refresh');
  assert.equal(width(app, 'full'), 280);
  assert.equal(app.state().panes[0].columns.find(column => column.key === 'full').width, configuredWidth);
});

test('autosize includes content outside the viewport and releases rows back to virtual rendering', async t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const items = Array.from({ length: 160 }, (_, index) => ({ id: String(index), name: `item-${index}.txt`, type: 'text' }));
  items.at(-1).name = 'z'.repeat(100) + '.txt';
  const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': items, '/right': [] } });
  await settled(app);
  assert.ok(width(app, 'name') >= 800);
  assert.ok(app.document.querySelectorAll('.pane.active [data-file-row][data-id]').length < items.length);
  app.grid().ensureIndexVisible(160, 'bottom');
  assert.equal(app.grid().getDisplayedRowAtIndex(160).data.name, items.at(-1).name);
});

test('directory navigation retains measured columns and only resizes for different content', async t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const folder = { id: 'child', name: 'child', type: 'folder' };
  const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [folder], '/left/child': [{ ...folder, id: 'deeper' }],
    '/left/child/child': [{ id: 'long', name: 'z'.repeat(100) + '.txt', type: 'text' }], '/right': []
  } });
  await settled(app);
  const grid = app.grid(), other = app.grid(1);
  const before = grid.getColumnState().map(({ colId, width }) => ({ colId, width }));
  const intermediate = [];
  grid.addEventListener('columnResized', () => intermediate.push(grid.getColumnState().map(({ colId, width }) => ({ colId, width }))));
  const open = () => app.row('child').querySelector('[data-filename]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  open();
  assert.equal(app.grid(), grid, 'navigation reuses the measured grid');
  assert.deepEqual(grid.getColumnState().map(({ colId, width }) => ({ colId, width })), before);
  await settled(app);
  assert.deepEqual(grid.getColumnState().map(({ colId, width }) => ({ colId, width })), before);
  assert.ok(intermediate.every(columns => JSON.stringify(columns) === JSON.stringify(before)), 'unchanged content never resets widths during measurement');
  assert.equal(app.document.querySelector('.pane.active [data-history="back"]').getAttribute('aria-disabled'), 'false');
  resize(app, 'size', 310); await delay(5);
  open(); await settled(app);
  assert.ok(width(app, 'name') >= 800, 'new longer content still triggers autosizing');
  assert.equal(width(app, 'size'), 310, 'navigation preserves explicit widths');
  assert.equal(app.grid(1), other);
  assert.equal(other.isDestroyed(), false);
});

test('native separator double-click measures content again without changing file selection', async t => {
  const app = configured(t); await settled(app);
  app.click(app.row('README.md')); const selected = app.state().panes[0].selected;
  resize(app, 'bytes', 390); await delay(5);
  const handle = app.document.querySelector('.pane.active [col-id="bytes"] .ag-header-cell-resize');
  handle.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  await settled(app);
  assert.ok(width(app, 'bytes') < 390);
  assert.deepEqual(app.state().panes[0].selected, selected);
});

test('a manual resize made during initial measurement keeps the chosen width', async t => {
  const app = configured(t);
  resize(app, 'full', 280);
  await settled(app);
  assert.equal(width(app, 'full'), 280);
  assert.equal(app.grid().getColumn('full').getFlex(), null);
});

test('headers handle Enter without activating the current file', t => {
  const app = createApp(t); app.click(app.row('docs'));
  const before = app.state().panes[0].tabs;
  const header = app.document.querySelector('.pane.active [col-id="size"].ag-header-cell');
  header.focus(); app.key('Enter', {}, header);
  assert.deepEqual(app.state().panes[0].tabs, before);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('grids release their resources when the page is disposed', t => {
  const app = createApp(t), grids = [app.grid(0), app.grid(1)];
  app.window.dispatchEvent(new app.window.Event('pagehide'));
  assert.ok(grids.every(grid => grid.isDestroyed()));
});

test('directories show an empty size until an actual folder size is available', t => {
  const app = createApp(t);
  assert.equal(app.row('docs').querySelector('[data-cell="size"]').textContent, '');
  assert.notEqual(app.row('README.md').querySelector('[data-cell="size"]').textContent, '');
});
