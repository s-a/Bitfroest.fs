const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const sets = [{ id: 'custom', name: 'Custom', columns: [
  { id: 'full', title: 'File <name>', field: '[=tc.fullname]', width: 340, align: 'left' },
  { id: 'bytes', title: 'Bytes', field: '[=tc.size]', width: 96, align: 'right' },
  { id: 'hidden', title: 'Hidden', field: '[=tc.ext]', visible: false },
  { id: 'plugin', title: 'Plugin', field: '[=wdx.foo]', width: 120, align: 'center' }
]}];
test('configured columns render real values, custom titles, alignment, visibility and explicit unavailable fields', t => {
  const app = createApp(t, null, { columnSettings: { sets, activeSet: 'custom' } });
  const headers = [...app.document.querySelectorAll('.pane.active th')];
  assert.deepEqual(headers.map(header => header.dataset.column), ['full', 'bytes', 'plugin']);
  assert.equal(headers[0].querySelector('button').textContent, 'File <name>');
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
  const pointer = (type, values) => { const event = new app.window.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value }); handle.dispatchEvent(event); };
  pointer('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
  pointer('pointermove', { clientX: 140 }); pointer('pointerup', {});
  assert.equal(app.document.querySelector('.pane.active col').width, '340');
  assert.equal(app.state().panes[0].sort, id);
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
