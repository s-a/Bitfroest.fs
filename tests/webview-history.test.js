const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');

const fixture = (realFilesystem = false) => ({ version: 1, realFilesystem, snapshotId: 'history', active: 0,
  panes: [{ tabs: ['/three', '/other'], tab: 0, sort: 'name', selected: [], tabStates: [{ path: '/three', history: ['/one', '/two', '/three'], historyIndex: 2 }, { path: '/other', history: ['/other'], historyIndex: 0 }] },
    { tabs: ['/other'], tab: 0, selected: [] }], folders: { '/one': [], '/two': [], '/three': [], '/other': [] } });
const pane = (app, side = 0) => app.document.querySelector(`[data-pane="${side}"]`);
const button = (app, direction, side = 0) => pane(app, side).querySelector(`[data-history="${direction}"]`);
function context(app, target) {
  assert.ok(target);
  const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  return app.document.querySelector('[data-context-menu]');
}

test('header arrows navigate the target pane without sorting and reflect history boundaries', t => {
  const app = createApp(t, fixture());
  assert.ok(pane(app).querySelector('[data-column="name"] [data-history="back"]'));
  assert.equal(button(app, 'forward').getAttribute('aria-disabled'), 'true');
  const sort = app.state().panes[0].sort;
  app.click(button(app, 'back').querySelector('svg'));
  assert.equal(app.state().panes[0].tabs[0], '/two');
  assert.equal(app.state().panes[0].sort, sort);
  app.click(button(app, 'forward'));
  assert.equal(app.state().panes[0].tabs[0], '/three');
  app.click(button(app, 'back', 1));
  assert.equal(app.state().panes[1].tabs[0], '/other');
  assert.equal(app.state().panes[0].tabs[0], '/three');
});

test('either arrow opens the full tab history and direct jumps retain forward entries', t => {
  const app = createApp(t, fixture());
  let menu = context(app, button(app, 'forward'));
  assert.deepEqual([...menu.querySelectorAll('[data-history-index]')].map(item => item.textContent.trim()), ['/one', '/two', '/three']);
  assert.equal(menu.querySelector('[aria-current="location"]').dataset.historyIndex, '2');
  app.click(menu.querySelector('[data-history-index="0"]'));
  assert.equal(app.state().panes[0].tabs[0], '/one');
  assert.deepEqual(app.state().panes[0].tabStates[0].history, ['/one', '/two', '/three']);
  assert.equal(button(app, 'back').getAttribute('aria-disabled'), 'true');
  menu = context(app, button(app, 'back'));
  app.click(menu.querySelector('[data-history-index="2"]'));
  assert.equal(app.state().panes[0].tabs[0], '/three');
});

test('history keyboard menu restores focus on Escape and rejects a stale tab selection', t => {
  const app = createApp(t, fixture());
  const origin = button(app, 'back'); assert.ok(origin); origin.focus();
  app.key('F10', { shiftKey: true }, origin);
  assert.ok(app.document.querySelector('[data-history-index]'));
  app.key('Escape');
  assert.equal(app.document.querySelector('[data-context-menu]'), null);
  assert.equal(app.document.activeElement, origin);
  const stale = context(app, origin).querySelector('[data-history-index="0"]');
  app.action('next-tab'); app.click(stale);
  assert.equal(app.state().panes[0].tabs[1], '/other');
  assert.equal(app.state().panes[0].tab, 1);
});

test('history selection sends the existing real filesystem navigation request', t => {
  const app = createApp(t, fixture(true));
  app.click(context(app, button(app, 'back')).querySelector('[data-history-index="0"]'));
  const requests = app.messages.filter(message => message.type === 'filesystem-navigate');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/one');
  assert.equal(requests[0].side, 0);
});

test('focused history arrows handle Enter and Space independently of file list keys', t => {
  const app = createApp(t, fixture());
  button(app, 'back').focus(); app.key('Enter');
  assert.equal(app.state().panes[0].tabs[0], '/two');
  button(app, 'forward').focus(); app.key(' ');
  assert.equal(app.state().panes[0].tabs[0], '/three');
});

test('keyboard history context stays on the arrow when a file has the cursor', t => {
  const saved = fixture();
  saved.folders['/three'] = [{ id: 'file', name: 'file.txt', type: 'text', size: 1 }];
  const app = createApp(t, saved);
  app.click(app.row('file.txt').querySelector('[data-filename]'));
  const origin = button(app, 'back'); origin.focus(); app.key('F10', { shiftKey: true });
  assert.ok(app.document.querySelector('[data-history-index]'));
});

test('history icons switch from outline to fill on hover and focus, with disabled buttons unchanged', t => {
  const app = createApp(t, fixture());
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8').replaceAll(':hover', '.test-hover').replaceAll(':focus-visible', '.test-focus');
  app.document.head.append(style);
  const display = element => app.window.getComputedStyle(element).display;
  for (const state of ['test-hover', 'test-focus']) {
    const back = button(app, 'back'), forward = button(app, 'forward');
    assert.equal(display(back.querySelector('.history-outline')), 'flex');
    assert.equal(display(back.querySelector('.history-filled')), 'none');
    back.classList.add(state); forward.classList.add(state);
    assert.equal(display(back.querySelector('.history-outline')), 'none');
    assert.equal(display(back.querySelector('.history-filled')), 'flex');
    assert.equal(display(forward.querySelector('.history-outline')), 'flex');
    assert.equal(display(forward.querySelector('.history-filled')), 'none');
    back.classList.remove(state); forward.classList.remove(state);
  }
  assert.equal(button(app, 'back').querySelector('svg').dataset.iconReviewed, 'status:forward');
  assert.equal(button(app, 'back').querySelector('.history-filled svg').dataset.iconReviewed, 'status:forward-fill');
  assert.equal(app.window.getComputedStyle(button(app, 'back').querySelector('svg')).transform, 'scaleX(-1)');
  assert.equal(app.window.getComputedStyle(button(app, 'back')).width, '8px');
  assert.equal(app.window.getComputedStyle(button(app, 'back').querySelector('svg')).width, '8px');
  assert.equal(app.window.getComputedStyle(button(app, 'back').querySelector('svg')).height, '8px');
  const header = pane(app).querySelector('[data-column="name"]');
  const controls = header.querySelector('.history-controls');
  assert.equal(app.window.getComputedStyle(controls).position, 'absolute');
  const rules = [...style.sheet.cssRules].filter(rule => rule.selectorText);
  const padding = element => rules.filter(rule => element.matches(rule.selectorText) && rule.style.getPropertyValue('padding-left'))
    .at(-1)?.style.getPropertyValue('padding-left');
  assert.equal(padding(header.querySelector('[data-sort]')), padding(pane(app).querySelector('.parent-row .filename')));
  const rule = selector => rules.find(rule => rule.selectorText === selector)?.style;
  assert.equal(rule('.file-table .ag-header-cell .history-controls button').getPropertyValue('max-width'), 'calc(var(--icon-base-size) / 2)');
  assert.equal(rule('.history-controls svg').getPropertyValue('max-width'), 'calc(var(--icon-base-size) / 2)');
  assert.equal(rule('.history-controls svg').getPropertyValue('max-height'), 'calc(var(--icon-base-size) / 2)');
});

test('history menu selects its own pane and supports keyboard selection without starting a column drag', t => {
  const saved = fixture();
  saved.panes[1] = { tabs: ['/three'], tab: 0, selected: [], tabStates: [{ path: '/three', history: ['/one', '/two', '/three'], historyIndex: 2 }] };
  const app = createApp(t, saved);
  const origin = button(app, 'back', 1);
  const dragging = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
  origin.dispatchEvent(dragging);
  assert.equal(dragging.defaultPrevented, true);
  context(app, origin);
  app.key('Home'); app.key('ArrowDown'); app.key('Enter');
  assert.equal(app.state().active, 1);
  assert.equal(app.state().panes[1].tabs[0], '/two');
  assert.equal(app.state().panes[0].tabs[0], '/three');
});
