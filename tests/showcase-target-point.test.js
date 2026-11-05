const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { findTargetPoint } = require('../scripts/showcases/gestures.cjs');

test('recording targets resolve global controls and pane-scoped file rows', () => {
  const dom = new JSDOM('<div data-pane="0"><button class="row-action">Copy</button><div data-file-row data-id="file-1" title="Notes.txt"><span data-filename>Notes.txt</span></div></div><button id="outside">Menu</button>');
  try {
    const doc = dom.window.document;
    doc.querySelector('[data-filename]').getBoundingClientRect = () => ({ left: 20, top: 30, width: 200, height: 24 });
    doc.querySelector('#outside').getBoundingClientRect = () => ({ left: 400, top: 10, width: 80, height: 28 });
    doc.querySelector('.row-action').getBoundingClientRect = () => ({ left: 12, top: 80, width: 100, height: 20 });
    assert.deepEqual(findTargetPoint({ selector: '[data-filename]', name: 'Notes.txt', side: 0 }, doc), { x: 70, y: 42 });
    assert.deepEqual(findTargetPoint({ selector: '#outside' }, doc), { x: 440, y: 24 });
    assert.deepEqual(findTargetPoint({ selector: '.row-action', side: 0 }, doc), { x: 62, y: 90 });
    assert.throws(() => findTargetPoint({ selector: '.missing' }, doc), /target missing/);
  } finally { dom.window.close(); }
});

test('recording reveals virtualized file rows before calculating their click point', () => {
  const dom = new JSDOM('<div data-pane="0"><div class="list"></div></div>');
  try {
    const doc = dom.window.document, pane = doc.querySelector('[data-pane="0"]');
    const calls = [];
    dom.window.agGrid = { getGridApi: id => {
      assert.equal(id, 'files-0');
      return {
        forEachNodeAfterFilterAndSort(callback) { callback({ data: { name: 'README.md' }, rowIndex: 42 }); },
        ensureIndexVisible(index, position) {
          calls.push([index, position]);
          const row = doc.createElement('div'); row.dataset.fileRow = ''; row.dataset.id = 'readme'; row.title = 'README.md';
          const name = doc.createElement('span'); name.dataset.filename = ''; name.textContent = 'README.md'; row.append(name); pane.append(row);
          name.getBoundingClientRect = () => ({ left: 20, top: 30, width: 200, height: 24 });
        }
      };
    } };
    assert.deepEqual(findTargetPoint({ selector: '[data-filename]', name: 'README.md', side: 0 }, doc), { x: 70, y: 42 });
    assert.deepEqual(calls, [[42, 'middle']]);
  } finally { dom.window.close(); }
});
