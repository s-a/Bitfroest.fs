const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { assertSafePointer } = require('../scripts/showcases/sequence.cjs');

test('recording may enter text and change safe options inside a dialog but never confirm', () => {
  const dom = new JSDOM('<dialog open><form><label><input id="query" type="text"></label><input id="regex" type="checkbox"><button id="advanced" type="button" role="tab">Advanced</button><button id="modal-cancel" type="button">Cancel</button><button id="modal-ok" type="submit">Search</button></form></dialog>');
  try {
    const doc = dom.window.document;
    assert.doesNotThrow(() => assertSafePointer(doc.querySelector('#query')));
    assert.doesNotThrow(() => assertSafePointer(doc.querySelector('#regex')));
    assert.doesNotThrow(() => assertSafePointer(doc.querySelector('#advanced')));
    assert.doesNotThrow(() => assertSafePointer(doc.querySelector('#modal-cancel')));
    assert.throws(() => assertSafePointer(doc.querySelector('#modal-ok')), /confirmation/);
  } finally { dom.window.close(); }
});
