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

test('the location row stays anchored to the panel viewport while columns resize', async t => {
  const app = createApp(t);
  for (const side of [0, 1]) {
    const pane = app.document.querySelector(`[data-pane="${side}"]`);
    const address = pane.querySelector('.pathbar');
    const group = address.closest('.location-header');
    assert.equal(group.parentElement, pane.querySelector('[data-file-grid]'), 'address width belongs to the viewport, not the columns');
    assert.equal(pane.querySelectorAll('.pathbar').length, 1);
    for (const width of [80, 800, 120]) {
      const last = app.grid(side).getAllDisplayedColumns().at(-1).getColId();
      app.grid(side).setColumnWidths([{ key: last, newWidth: width }]);
      assert.equal(address.closest('.ag-header-group-cell'), null);
      assert.equal(group.parentElement, pane.querySelector('[data-file-grid]'));
      assert.equal(group.style.width, '');
    }
    assert.equal(address.lastElementChild.dataset.refresh, '');
    assert.ok(pane.querySelector('.ag-header-row [data-column="date"]'));
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

test('the viewport address retains a long branch when columns move or hide', async t => {
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
    assert.equal(group.parentElement, section.querySelector('[data-file-grid]'));
    assert.equal(grid.getAllDisplayedColumns().at(-1).getColId(), 'type');
    assert.ok(group.querySelector('[data-refresh]'));
    assert.equal(group.querySelector('[data-git-branch]').textContent, `(${branch})`);
    app.click(group.querySelector('[data-git-branch]'));
    assert.equal(app.messages.at(-1).type, 'git-branches');
    assert.equal(app.messages.at(-1).path, directory);
  }
  for (const size of [12, 28, 48]) {
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { iconSize: size } } }));
    for (const side of [0, 1]) assert.equal(app.grid(side).getGridOption('groupHeaderHeight'), Math.max(26, app.window.CommanderIcons.layout().control + 6));
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

test('address text selection cannot start native text dragging or column dragging', t => {
  const app = createApp(t);
  for (const pane of app.document.querySelectorAll('.pane')) {
    const group = pane.querySelector('.location-header');
    let headerStarts = 0, transfers = 0;
    group.addEventListener('mousedown', () => headerStarts++);
    group.addEventListener('touchstart', () => headerStarts++);
    group.addEventListener('pointerdown', () => headerStarts++);
    app.click(pane.querySelector('[data-path-edit]'));
    const input = pane.querySelector('.path-input');
    input.setSelectionRange(0, 3);
    const columns = JSON.stringify(app.grid(Number(pane.dataset.pane)).getColumnState());
    for (const target of [input, pane.querySelector('[data-breadcrumb]')]) {
      for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
        const event = new app.window.Event(type, { bubbles: true, cancelable: true });
        if (type === 'touchstart') {
          Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: 10, clientY: 10 }] });
          Object.defineProperty(event, 'changedTouches', { value: event.touches });
        }
        target.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'text selection keeps its native default');
      }
      const drag = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(drag, 'dataTransfer', { value: { setData() { transfers++; } } });
      target.dispatchEvent(drag);
      assert.equal(drag.defaultPrevented, true, 'address text must not become a draggable payload');
    }
    assert.equal(headerStarts, 0);
    assert.equal(transfers, 0);
    assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, 3);
    assert.equal(JSON.stringify(app.grid(Number(pane.dataset.pane)).getColumnState()), columns);
  }
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
