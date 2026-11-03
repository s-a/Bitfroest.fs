const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('both file panels use the community grid and retain their address and status controls', t => {
  const app = createApp(t);
  for (const pane of app.document.querySelectorAll('.pane')) {
    assert.ok(pane.querySelector('[role="grid"]'));
    assert.equal(pane.querySelector('table.file-table'), null);
    assert.ok(pane.querySelector('.path-address'));
    assert.ok(pane.querySelector('.pane-status'));
    assert.ok(pane.querySelector('[data-file-row] [data-filename]'));
  }
});

test('the location row spans every displayed column above the individual headings', async t => {
  const app = createApp(t);
  for (const side of [0, 1]) {
    const pane = app.document.querySelector(`[data-pane="${side}"]`);
    const address = pane.querySelector('.pathbar');
    const group = address.closest('.ag-header-group-cell');
    assert.ok(group, 'the location belongs to the grid group header');
    assert.equal(pane.querySelectorAll('.pathbar').length, 1);
    const displayed = app.grid(side).getAllDisplayedColumns();
    assert.equal(parseFloat(group.style.width), displayed.reduce((sum, column) => sum + column.getActualWidth(), 0));
    assert.equal(address.lastElementChild.dataset.refresh, '');
    assert.ok(group.closest('.ag-header-row').nextElementSibling.querySelector('[data-column="date"]'));
    const input = address.querySelector('input'); input.focus(); input.value = '/unfinished'; input.setSelectionRange(2, 5);
    app.grid(side).refreshHeader();
    await Promise.resolve();
    assert.ok(pane.querySelector('.path-input') === input);
    assert.ok(app.document.activeElement === input);
    assert.equal(input.value, '/unfinished');
    assert.equal(input.selectionStart, 2);
    assert.ok(input.closest('.path-address').classList.contains('is-editing'));
  }
  const left = app.document.querySelector('[data-pane="0"] .path-input');
  left.focus(); app.grid(0).refreshHeader();
  const right = app.document.querySelector('[data-pane="1"] [data-favorites]');
  right.focus();
  await Promise.resolve();
  assert.ok(app.document.activeElement === right, 'a pending header refresh cannot steal focus from the other panel');
});

test('the grouped address retains a long branch and follows the last visible column', async t => {
  const directory = '/work/' + 'long-path/'.repeat(12).slice(0, -1);
  const pane = () => ({ tabs: [directory], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'branch-layout', active: 0, panes: [pane(), pane()], folders: { [directory]: [] } });
  const request = app.messages.find(message => message.type === 'git-status');
  const branch = 'feature/' + 'long-branch-'.repeat(15);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { ...request, type: 'git-status-result', directories: { [directory]: { ok: true, repository: true, branch, statuses: {} } } } }));
  for (const side of [0, 1]) {
    const grid = app.grid(side), section = app.document.querySelector(`[data-pane="${side}"]`);
    const address = section.querySelector('.pathbar');
    assert.equal(address.querySelector('[data-git-branch]').textContent, `(${branch})`);
    assert.equal(address.querySelector('input').value, directory);
    assert.ok(address.querySelector('[data-location-icon="git"]'));
    grid.setColumnsVisible(['date'], false);
    grid.moveColumns(['size'], 0);
    grid.setColumnWidths([{ key: 'type', newWidth: 180 }]);
    await Promise.resolve();
    const group = section.querySelector('.location-header');
    assert.equal(parseFloat(group.style.width), grid.getAllDisplayedColumns().reduce((sum, column) => sum + column.getActualWidth(), 0));
    assert.equal(grid.getAllDisplayedColumns().at(-1).getColId(), 'type');
    assert.ok(group.querySelector('[data-refresh]'));
    assert.equal(group.querySelector('[data-git-branch]').textContent, `(${branch})`);
    app.click(group.querySelector('[data-git-branch]'));
    assert.equal(app.messages.at(-1).type, 'git-branches');
    assert.equal(app.messages.at(-1).path, directory);
  }
  for (const size of [12, 28, 48]) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { iconSize: size } } }));
    for (const side of [0, 1]) assert.equal(app.grid(side).getGridOption('groupHeaderHeight'), Math.max(26, app.window.CommanderIcons.layout().control + 3));
  }
});

test('address focus keeps file navigation keys out of the file selection', t => {
  const app = createApp(t);
  app.click(app.row('README.md'));
  const before = app.state().panes[0];
  const location = app.document.querySelector('.pane.active [data-favorites]');
  location.focus();
  app.key('ArrowDown', {}, location);
  assert.equal(app.state().panes[0].cursor, before.cursor);
  assert.deepEqual(app.state().panes[0].selected, before.selected);
  assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).list, false);
});

test('hiding and restoring every column keeps one usable address in each panel', t => {
  const app = createApp(t);
  for (const visible of [false, true]) {
    const settings = { activeSet: 'custom', sets: [{ id: 'custom', name: 'Custom', columns: [{ id: 'name', title: 'Name', field: '[=file.name]', width: 200, visible }] }] };
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'column-settings', settings } }));
    for (const pane of app.document.querySelectorAll('.pane')) {
      assert.equal(pane.querySelectorAll('.pathbar').length, 1);
      assert.equal(Boolean(pane.querySelector('.location-header .path-input')), visible);
      app.click(pane.querySelector('[data-path-edit]'));
      assert.ok(app.document.activeElement === pane.querySelector('input.path-input'));
      app.key('Escape');
    }
  }
});

test('file activation, marking and inline rename retain file identities through grid rows', t => {
  const app = createApp(t);
  const row = app.document.querySelector('.pane.active [data-file-row][data-id]');
  assert.ok(row);
  const id = row.dataset.id;
  app.click(row.querySelector('[data-filename]'));
  assert.equal(app.state().panes[0].cursor, id);
  assert.deepEqual(app.state().panes[0].selected, [id]);
  app.action('rename-one');
  assert.ok(row.querySelector('.inline-rename'));
  app.key('Escape', {}, row.querySelector('.inline-rename'));
  assert.equal(row.querySelector('.inline-rename'), null);
  assert.equal(app.state().panes[0].cursor, id);
});

test('empty directories retain an explicit empty-state hint below their parent entry', t => {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': [], '/right': [] } });
  assert.equal(app.document.querySelector('.pane.active .grid-empty').textContent, 'Keine Einträge');
  assert.ok(app.document.querySelector('.pane.active [data-parent]'));
});
