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
