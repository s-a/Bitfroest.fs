const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('cursor, marking and panel focus changes retain both lists and their rows', t => {
  const app = createApp(t);
  const lists = [...app.document.querySelectorAll('.list')];
  const rows = [...app.document.querySelectorAll('tr[data-id]')];
  const unchanged = () => {
    lists.forEach((list, side) => assert.equal(app.document.querySelectorAll('.list')[side], list));
    rows.forEach((row, index) => assert.equal(app.document.querySelectorAll('tr[data-id]')[index], row));
  };
  app.key('ArrowDown'); unchanged();
  assert.ok(app.state().panes[0].cursor);
  app.key(' '); unchanged();
  assert.equal(app.state().panes[0].selected.length, 1);
  app.action('toggle-selection-next'); unchanged();
  assert.equal(app.state().panes[0].selected.length, 0);
  app.action('select-all'); unchanged();
  assert.ok(app.state().panes[0].selected.length > 1);
  app.action('invert'); unchanged();
  assert.equal(app.state().panes[0].selected.length, 0);
  app.action('clear'); unchanged();
  app.key('Tab'); unchanged();
  assert.equal(app.state().active, 1);
  assert.equal(app.document.activeElement, lists[1]);
});

test('clicking the current tab focuses its panel without replacing either list', t => {
  const app = createApp(t);
  const lists = [...app.document.querySelectorAll('.list')];
  lists[1].scrollTop = 90;
  app.click(app.document.querySelector('[data-pane="1"] [data-tab="0"]'));
  lists.forEach((list, side) => assert.equal(app.document.querySelectorAll('.list')[side], list));
  assert.equal(app.state().active, 1);
  assert.equal(app.document.activeElement, lists[1]);
  assert.equal(lists[1].scrollTop, 90);
});

test('cancelling file action dialogs retains lists, selection and scroll position', t => {
  const app = createApp(t);
  app.key('ArrowDown');
  const lists = [...app.document.querySelectorAll('.list')];
  const selection = [...app.state().panes[0].selected];
  lists[0].scrollTop = 80;
  for (const action of ['mkdir', 'copy', 'move', 'delete']) {
    app.action(action);
    assert.equal(app.document.querySelector('#modal').open, true);
    app.click(app.document.querySelector('#modal-cancel'));
    assert.equal(app.document.querySelector('#modal').open, false);
    lists.forEach((list, side) => assert.equal(app.document.querySelectorAll('.list')[side], list));
    assert.deepEqual(app.state().panes[0].selected, selection);
    assert.equal(lists[0].scrollTop, 80);
    assert.equal(app.document.activeElement, lists[0]);
  }
});

test('icon acknowledgements resolve row identities in linear work without replacing lists or selection', t => {
  let reads = 0;
  const items = Array.from({ length: 250 }, (_, index) => ({ get id() { reads++; return String(index); }, name: `item-${index}.txt`, type: 'text', size: index }));
  const pane = path => ({ tabs: [path], tab: 0, selected: ['0'], cursor: '0', sort: 'name', filter: '' });
  const app = createApp(t, { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': items, '/right': [] } });
  const list = app.document.querySelector('.pane.active .list'); reads = 0;
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'icons', icons: {} } }));
  t.diagnostic(`Icon identity reads for ${items.length} rows: ${reads}`);
  assert.ok(reads <= items.length * 3, `identity reads must be linear; got ${reads} for ${items.length} rows`);
  assert.equal(app.document.querySelector('.pane.active .list'), list);
  assert.equal(app.row('item-0.txt').getAttribute('aria-selected'), 'true');
});

test('validating a multi-file right drag uses bounded identity lookups and retains the captured selection', t => {
  let reads = 0;
  const items = Array.from({ length: 250 }, (_, index) => ({ get id() { reads++; return String(index); }, name: `item-${index}.txt`, type: 'text', size: index }));
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const left = pane('/left'); left.selected = items.map(file => file.id); left.cursor = '0';
  const app = createApp(t, { version: 1, active: 0, panes: [left, pane('/right')], folders: { '/left': items, '/right': [] } });
  function pointer(type, target, x) {
    const event = new app.window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ button: 2, buttons: type === 'pointerup' ? 0 : 2, pointerId: 1, clientX: x, clientY: 10 })) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  }
  const target = app.document.querySelector('[data-pane="1"] .list');
  pointer('pointerdown', app.row('item-0.txt'), 10); reads = 0;
  pointer('pointermove', target, 600); pointer('pointerup', target, 600);
  t.diagnostic(`Drag identity reads for ${items.length} marked rows: ${reads}`);
  assert.ok(reads <= items.length * 10, `drag identity reads must be linear; got ${reads}`);
  assert.equal(app.messages.filter(message => message.type === 'choose-drop-action').length, 1);
  assert.equal(app.state().panes[0].selected.length, items.length);
});

test('selection painting does not repeatedly scan a large marked selection for every row', t => {
  let reads = 0;
  const items = Array.from({ length: 250 }, (_, index) => ({ id: String(index), name: `item-${index}.txt`, type: 'text', size: index }));
  const marked = new Proxy(items.map(file => file.id), { get(target, key, receiver) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key, receiver); } });
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, sort: 'name', filter: '' });
  const left = { ...pane('/left'), selected: marked, cursor: '0' };
  const app = createApp(t, { version: 1, active: 0, panes: [left, pane('/right')], folders: { '/left': items, '/right': [] } });
  reads = 0;
  app.document.querySelector('.list').dispatchEvent(new app.window.Event('focusin', { bubbles: true }));
  t.diagnostic(`Selection membership reads for ${items.length} marked rows: ${reads}`);
  assert.ok(reads <= items.length * 20, `selection membership work must stay linear; got ${reads}`);
  assert.equal(app.document.querySelectorAll('.pane.active tr.selected').length, items.length);
});
