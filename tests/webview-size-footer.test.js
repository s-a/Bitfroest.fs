const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('file-list footer formats total and selected size units', async t => {
  const cases = [[24, '24 B'], [2 * 1024, '2.0 KB'], [3 * 1024 ** 2, '3.0 MB'], [1.5 * 1024 ** 3, '1.5 GB'], [2 * 1024 ** 4, '2.0 TB']];
  for (const [size, expected] of cases) await t.test(expected, async t => {
    const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
    const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
      '/left': [{ id: 'item', name: 'item.bin', type: 'text', size }], '/right': []
    } });
    await new Promise(resolve => setImmediate(resolve));
    const footer = () => app.document.querySelector('.pane.active .pane-status').textContent;
    assert.ok(footer().endsWith(expected));
    app.click(app.document.querySelector('[data-id="item"]'), { ctrlKey: true });
    assert.ok(footer().endsWith(expected));
  });
});
