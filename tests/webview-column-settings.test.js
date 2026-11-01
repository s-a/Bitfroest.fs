const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('Linux runtime masks Windows-only fields even in restored visible column preferences', t => {
  const catalog = require('../media/commander-column-settings').catalog;
  const columns = catalog.map(column => ({ ...column, visible: ['name', 'archive', 'versionString'].includes(column.id) }));
  const app = createApp(t, null, { platform: 'linux', columnSettings: { sets: [{ id: 'standard', name: 'Standard', columns }], activeSet: 'standard' } });
  assert.equal(app.document.querySelector('thead [data-column="archive"]'), null);
  assert.ok(app.document.querySelector('thead [data-column="versionString"]'));
});
const sets = [{ id: 'custom', name: 'Custom', columns: [
  { id: 'full', title: 'File <name>', field: '[=tc.fullname]', width: 340, align: 'left' },
  { id: 'bytes', title: 'Bytes', field: '[=tc.size]', width: 96, align: 'right' },
  { id: 'hidden', title: 'Hidden', field: '[=tc.ext]', visible: false },
  { id: 'plugin', title: 'Plugin', field: '[=wdx.foo]', width: 120, align: 'center' }
]}];

test('filename fills remaining list width and follows pane resizing without widening metadata', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const section = app.document.querySelector('.pane.active'), list = section.querySelector('.list');
  const metadata = [...section.querySelectorAll('col')].filter(col => col.dataset.col !== 'full');
  const widths = metadata.map(col => Number(col.width));
  const remaining = widths.reduce((sum, width) => sum + width, 0);
  for (const available of [1200, 900, 1800]) {
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: available });
    app.window.dispatchEvent(new app.window.Event('resize'));
    assert.equal(Number(section.querySelector('[data-col="full"]').width), available - remaining);
    assert.equal(section.querySelector('table').style.width, `${available}px`);
    assert.deepEqual(metadata.map(col => Number(col.width)), widths);
  }
});

test('list resize observation updates filename width and is released on pagehide', t => {
  let observer;
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observer = this; }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  }
  const app = createApp(t, null, { ResizeObserver });
  assert.equal(observer.targets.size, 2);
  const list = app.document.querySelector('.pane.active .list');
  Object.defineProperty(list, 'clientWidth', { value: 1200 });
  observer.callback([{ target: list }]);
  assert.equal(list.querySelector('table').style.width, '1200px');
  const columns = [...list.querySelectorAll('col')];
  assert.equal(columns.reduce((sum, col) => sum + Number(col.width), 0), 1200);
  app.window.dispatchEvent(new app.window.Event('pagehide'));
  assert.equal(observer.targets.size, 0);
});

test('dragging columns reallocates space without exceeding the list width', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const section = app.document.querySelector('.pane.active'), list = section.querySelector('.list');
  Object.defineProperty(list, 'clientWidth', { value: 1200 });
  app.window.dispatchEvent(new app.window.Event('resize'));
  const name = section.querySelector('[data-col="full"]'), bytes = section.querySelector('[data-col="bytes"]');
  const originalName = Number(name.width), originalBytes = Number(bytes.width);
  function drag(key, delta) {
    const handle = section.querySelector(`[data-resize="${key}"]`);
    handle.closest('th').getBoundingClientRect = () => ({ width: Number(section.querySelector(`[data-col="${key}"]`).width) });
    for (const [type, clientX] of [['pointerdown', 100], ['pointermove', 100 + delta], ['pointerup', 100 + delta]]) handle.dispatchEvent(new app.window.MouseEvent(type, { bubbles: true, button: 0, clientX }));
  }
  drag('bytes', 40);
  assert.equal(Number(bytes.width), originalBytes + 40);
  assert.equal(Number(name.width), originalName - 40);
  assert.equal(section.querySelector('table').style.width, '1200px');
  drag('full', 100);
  assert.ok(Math.abs(Number(name.width) - (originalName + 60)) <= 1);
  assert.equal(section.querySelector('table').style.width, '1200px');
  assert.equal([...section.querySelectorAll('col')].reduce((sum, col) => sum + Number(col.width), 0), 1200);
});

test('all visible columns fit narrow lists and attribute headers use the short default', t => {
  const app = createApp(t), section = app.document.querySelector('.pane.active'), list = section.querySelector('.list');
  assert.equal(section.querySelector('[data-column="attributes"] button').textContent, 'Attr.');
  for (const available of [500, 240, 80, 1, 1500]) {
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: available });
    app.window.dispatchEvent(new app.window.Event('resize'));
    const widths = [...section.querySelectorAll('col')].map(col => Number(col.width));
    assert.ok(widths.every(width => width >= 0));
    assert.equal(widths.reduce((sum, width) => sum + width, 0), available);
    assert.equal(section.querySelector('table').style.width, `${available}px`);
  }
});

test('filename text is ellipsized even with a following source path', t => {
  const app = createApp(t), style = app.document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  const filename = app.row('README.md').querySelector('[data-filename]');
  filename.textContent = 'long-filename-'.repeat(50);
  filename.after(app.document.createElement('span'));
  const computed = app.window.getComputedStyle(filename);
  assert.equal(computed.overflow, 'hidden');
  assert.equal(computed.textOverflow, 'ellipsis');
  assert.equal(computed.whiteSpace, 'nowrap');
  assert.ok(['0', '0px'].includes(computed.minWidth));
  assert.equal(filename.textContent, 'long-filename-'.repeat(50));
});

test('a view without a filename column also fits the available width', t => {
  const metadataSets = sets.map(set => ({ ...set, columns: set.columns.filter(column => column.id !== 'full') }));
  const app = createApp(t, null, { columnSettings: { sets: metadataSets, activeSet: 'custom' } });
  const list = app.document.querySelector('.pane.active .list');
  for (const available of [900, 180, 20]) {
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: available });
    app.window.dispatchEvent(new app.window.Event('resize'));
    assert.equal([...list.querySelectorAll('col')].reduce((sum, col) => sum + Number(col.width), 0), available);
    assert.equal(list.querySelector('table').style.width, `${available}px`);
  }
});
test('configured columns render fixed field headings, real values, alignment and unavailable fields', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const headers = [...app.document.querySelectorAll('.pane.active th')];
  assert.deepEqual(headers.map(header => header.dataset.column), ['full', 'bytes', 'plugin']);
  assert.equal(headers[0].querySelector('button').textContent, 'Vollständiger Dateiname');
  assert.equal(app.row('README.md').querySelector('[data-cell="full"] [data-filename]').textContent, 'README.md');
  assert.equal(app.row('README.md').querySelector('[data-cell="bytes"]').textContent, '3264');
  assert.equal(app.row('README.md').querySelector('[data-cell="bytes"]').classList.contains('column-align-right'), true);
  assert.match(app.row('README.md').querySelector('[data-cell="plugin"]').textContent, /Nicht verfügbar.*wdx.foo/);
  assert.equal(JSON.parse(headers[0].closest('thead').dataset.vscodeContext).webviewSection, 'columns');
});
test('configuration broadcasts replace the active columns without changing paths or selected files', t => {
  const app = createApp(t); app.click(app.row('README.md')); const before = app.state();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'column-settings', settings: { sets, activeSet: 'custom' } } }));
  assert.equal(app.document.querySelector('.pane.active th').dataset.column, 'full');
  assert.deepEqual(app.state().panes[0].selected, before.panes[0].selected);
  assert.deepEqual(app.state().panes[0].tabs, before.panes[0].tabs);
});
test('a set with no visible columns stays configurable and visibly explains its empty view', t => {
  const hidden = [{ id: 'empty', name: 'Empty', columns: [{ id: 'name', title: 'Name', field: '[=tc.name]', visible: false }] }];
  const app = createApp(t, null, { columnSettings: { sets: hidden, activeSet: 'empty' } });
  assert.match(app.document.querySelector('.pane.active .list').textContent, /Keine sichtbaren Spalten/);
  assert.equal(app.document.querySelector('.pane.active thead').dataset.vscodeContext.includes('columns'), true);
});

test('custom IDs and titles remain data during rendering, sorting and pointer resizing', t => {
  const id = 'odd"][data-evil="yes';
  const app = createApp(t, null, { columnSettings: { activeSet: 'unsafe', sets: [{ id: 'unsafe', name: 'Unsafe', columns: [{ id, title: '<img src=x onerror=alert(1)>', field: '[=tc.fullname]', width: 300 }] }] } });
  const header = app.document.querySelector('.pane.active th');
  assert.equal(header.dataset.column, id); assert.equal(header.querySelector('img'), null);
  assert.equal(app.document.querySelector('[data-evil]'), null);
  app.click(header.querySelector('button'));
  const handle = app.document.querySelector('.pane.active [data-resize]');
  const originalWidth = Number(app.document.querySelector('.pane.active col').width);
  const pointer = (type, values) => { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value }); handle.dispatchEvent(event); };
  pointer('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
  pointer('pointermove', { clientX: 140 }); pointer('pointerup', {});
  assert.equal(Number(app.document.querySelector('.pane.active col').width), originalWidth + 40);
  assert.equal(app.state().panes[0].sort, id);
});

test('loaded columns fit actual rendered values and resize movements outside the handle stay independent', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const section = app.document.querySelector('.pane.active');
  const full = section.querySelector('[data-col="full"]');
  assert.equal(Number(full.width), Math.max(section.querySelector('[data-column="full"] .column-caption').textContent.length * 8 + 10 + 20, ...[...section.querySelectorAll('[data-cell="full"]')].map(cell => cell.textContent.trim().length * 8 + 30)));
  const plugin = section.querySelector('[data-col="plugin"]');
  assert.ok(Number(plugin.width) >= app.row('README.md').querySelector('[data-cell="plugin"]').textContent.length * 8 + 16);
  const handle = section.querySelector('[data-resize="full"]'), start = Number(full.width);
  const pointer = (target, type, values) => { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value }); target.dispatchEvent(event); };
  pointer(handle, 'pointerdown', { button: 0, clientX: 100, pointerId: 1 });
  pointer(app.document, 'pointermove', { clientX: 160, pointerId: 1 });
  pointer(app.document, 'pointerup', { pointerId: 1 });
  assert.equal(Number(full.width), start + 60);
  const total = [...section.querySelectorAll('col')].reduce((sum, col) => sum + Number(col.width), 0);
  assert.equal(section.querySelector('table').style.width, `${total}px`);
  app.click(section.querySelector('[data-sort="bytes"]'));
  assert.equal(Number(section.querySelector('[data-col="full"]').width), start + 60);
});

test('automatic widths follow font changes while manually resized widths stay fixed', async t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const section = app.document.querySelector('.pane.active');
  const handle = section.querySelector('[data-resize="full"]');
  for (const [type, clientX] of [['pointerdown', 100], ['pointermove', 150], ['pointerup', 150]]) handle.dispatchEvent(new app.window.MouseEvent(type, { bubbles: true, button: 0, clientX }));
  const manual = Number(section.querySelector('[data-col="full"]').width);
  const automatic = Number(section.querySelector('[data-col="plugin"]').width);
  app.window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 16 }) });
  section.querySelectorAll('td').forEach(cell => { cell.style.font = '24px sans-serif'; });
  app.document.body.style.setProperty('--vscode-font-size', '24px');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Number(section.querySelector('[data-col="full"]').width), manual);
  assert.ok(Number(section.querySelector('[data-col="plugin"]').width) > automatic);
});

test('filesystem names containing quotes, ampersands and selector punctuation stay selectable and renameable', t => {
  const name = 'notes" & [draft]#.txt', id = `fs:/left/${name}`;
  const p = directory => ({ tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  const saved = { version: 1, active: 0, realFilesystem: true, snapshotId: 'one', panes: [p('/left'),p('/right')], folders: { '/left': [{ id, name, type: 'text', size: 4, content: 'text', fsSource: `/left/${name}` }], '/right': [] } };
  const app = createApp(t, saved);
  const rendered = app.row(name); assert.ok(rendered); assert.equal(rendered.dataset.id, id);
  app.click(rendered); app.key('n');
  assert.equal(app.state().panes[0].cursor, id);
  app.key('Escape'); app.action('rename-one');
  assert.equal(app.document.querySelector('.inline-rename').value, name);
  app.key('Escape', {}, app.document.querySelector('.inline-rename'));
  app.key('ArrowDown');
  assert.equal(app.state().panes[0].cursor, id);
});

test('configured alignment does not depend on inline style attributes blocked by the host policy', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  assert.equal(app.row('README.md').querySelector('[data-cell="bytes"]').hasAttribute('style'), false);
});

test('conditional empty metadata suppresses its decoration in the rendered column while unknown providers remain explicit', t=>{
 const custom=[{id:'conditional',name:'Conditional',columns:[{id:'name',title:'Name',field:'[=tc.fullname]'},{id:'extra',title:'Extra',field:'Present[=" Created "tc.creationdate.YMD"!"]'},{id:'unknown',title:'Provider',field:'[="Duration "media.duration" seconds"]'}]}];
 const app=createApp(t,null,{columnSettings:{sets:custom,activeSet:'conditional'}});
 assert.equal(app.row('README.md').querySelector('[data-cell="extra"]').textContent,'Present');
 assert.match(app.row('README.md').querySelector('[data-cell="unknown"]').textContent,/media.duration/);
});

test('automatic filename width keeps room for text beside wide metadata in both panels', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  for (const section of app.document.querySelectorAll('[data-pane]')) {
    const list = section.querySelector('.list');
    const p = app.state().panes[Number(section.dataset.pane)];
    const measured = p.columns.find(column => column.key === 'full').width;
    const otherMinimum = p.columns.filter(column => column.visible !== false && column.key !== 'full').reduce((sum, column) => sum + column.minWidth, 0);
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 400 });
    app.window.dispatchEvent(new app.window.Event('resize'));
    assert.ok(Number(section.querySelector('[data-col="full"]').width) >= Math.min(measured, 400 - otherMinimum));
    assert.equal([...section.querySelectorAll('col')].reduce((sum, col) => sum + Number(col.width), 0), 400);
  }
});

test('double-clicking the filename separator fits visible content after the complete pointer sequence', t => {
  const app = createApp(t), section = app.document.querySelector('[data-pane="1"]'), list = section.querySelector('.list');
  Object.defineProperty(list, 'clientWidth', { value: 1200 }); app.window.dispatchEvent(new app.window.Event('resize'));
  const before = app.state(), handle = section.querySelector('[data-resize="name"]');
  const desired = before.panes[1].columns.find(column => column.key === 'name').width;
  assert.ok(Number(section.querySelector('[data-col="name"]').width) > desired);
  for (let click = 1; click <= 2; click++) {
    handle.closest('th').getBoundingClientRect = () => ({ width: Number(section.querySelector('[data-col="name"]').width) });
    for (const type of ['pointerdown', 'pointerup']) handle.dispatchEvent(new app.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 100, detail: click }));
    app.click(handle, { detail: click });
  }
  handle.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  assert.equal(Number(section.querySelector('[data-col="name"]').width), desired);
  assert.equal(app.state().panes[1].sort, before.panes[1].sort);
  assert.deepEqual(app.state().panes[1].tabs, before.panes[1].tabs);
  app.click(section.querySelector('[data-sort="date"]'));
  assert.equal(Number(section.querySelector('[data-col="name"]').width), desired);
  assert.ok(parseFloat(section.querySelector('table').style.width) <= 1200);
});

test('autosize includes icon and cell padding without an empty marker gutter', t => {
  const p = () => ({ tabs: ['/left'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const name = 'abcdefghijklmnopqrst';
  const app = createApp(t, { version: 1, active: 0, panes: [p(), p()], folders: { '/left': [{ id: 'long', name, type: 'folder' }] } });
  const col = app.document.querySelector('[data-pane="0"] [data-col="name"]');
  assert.equal(Number(col.width), name.length * 8 + 30);
});

test('autosize includes the aligned filename header inset and measures the header font separately', t => {
  const p = () => ({ tabs: ['/left'], tab: 0, selected: [], cursor: null, filter: '', sort: 'full' });
  const app = createApp(t, { version: 1, active: 0, panes: [p(), p()], folders: { '/left': [{ id: 'a', name: 'a', type: 'folder', hidden: true }] } },
    { columnSettings: { sets: [{ id: 'wide', name: 'Wide', columns: [{ id: 'full', field: '[=file.fullname] [=file.ext]', width: 100 }] }], activeSet: 'wide' } });
  const section = app.document.querySelector('.pane.active');
  const caption = section.querySelector('.column-caption');
  const style = app.document.createElement('style');
  style.textContent = '.file-table th button { font: 12px serif; } .file-table td { font: 13px monospace; }';
  app.document.head.append(style);
  const fonts = [];
  app.window.HTMLCanvasElement.prototype.getContext = () => ({ font: '', measureText(text) { fonts.push(this.font); return { width: text.length * 8 }; } });
  section.querySelector('[data-resize="full"]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  assert.ok(Number(section.querySelector('col').width) >= caption.textContent.length * 8 + 24 + 21);
  assert.ok(fonts.includes('12px serif')); assert.ok(fonts.includes('13px monospace'));
});

test('double-clicking a metadata separator preserves its measured width when the other minima fit', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const section = app.document.querySelector('.pane.active'), list = section.querySelector('.list');
  const desired = Number(section.querySelector('[data-col="plugin"]').width);
  Object.defineProperty(list, 'clientWidth', { value: 400 }); app.window.dispatchEvent(new app.window.Event('resize'));
  section.querySelector('[data-resize="plugin"]').dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  assert.equal(Number(section.querySelector('[data-col="plugin"]').width), desired);
  app.window.dispatchEvent(new app.window.Event('resize'));
  assert.equal(Number(section.querySelector('[data-col="plugin"]').width), desired);
  assert.ok(parseFloat(section.querySelector('table').style.width) <= 400);
});

test('dragging the filename separator smaller leaves the chosen width visible', t => {
  const app = createApp(t), section = app.document.querySelector('.pane.active'), list = section.querySelector('.list');
  Object.defineProperty(list, 'clientWidth', { value: 1200 }); app.window.dispatchEvent(new app.window.Event('resize'));
  const before = Number(section.querySelector('[data-col="name"]').width), handle = section.querySelector('[data-resize="name"]');
  handle.closest('th').getBoundingClientRect = () => ({ width: before });
  for (const [type, clientX] of [['pointerdown', 300], ['pointermove', 200], ['pointerup', 200]]) handle.dispatchEvent(new app.window.MouseEvent(type, { bubbles: true, button: 0, clientX }));
  assert.equal(Number(section.querySelector('[data-col="name"]').width), before - 100);
  assert.ok(parseFloat(section.querySelector('table').style.width) < 1200);
});
