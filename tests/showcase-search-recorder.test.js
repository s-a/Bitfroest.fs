const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { validateCatalog } = require('../scripts/showcases/run.cjs');
const { validateSequence } = require('../scripts/showcases/sequence.cjs');
const { searchIsolation, installSearchObservation, inspectSearchObservation, searchCompletedVisible, searchViewGeometry } = require('../scripts/showcases/search-story-state.cjs');

test('search actions require the dedicated fixture', () => {
  const steps = ['search-start', 'search-view', 'search-find'].map(action => ({ type: 'confirm', action, effect: 'Inspect' }));
  const scene = { id: 'search', title: 'Search', description: 'Find a file.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{ id: 'story', format: 'gif', expect: '.pane', text: 'Find', steps }] };
  assert.doesNotThrow(() => validateSequence(steps));
  assert.throws(() => validateCatalog([scene]), /fixture/i);
  assert.throws(() => validateCatalog([{ ...scene, fixture: 'handover' }]), /fixture/i);
  assert.doesNotThrow(() => validateCatalog([{ ...scene, fixture: 'search-story' }]));
});

test('search isolation requires the idle product and one expected surface', () => {
  const dom = new JSDOM('<div id="status-progress-area" class="is-idle"></div><span id="status-activity" hidden></span><div id="panes"></div><div id="functionbar"></div><dialog data-file-search open><button data-search-start></button></dialog>');
  const root = dom.window.document;
  dom.window.CommanderHost = { getState: () => ({ realFilesystem: true }) };
  assert.equal(searchIsolation('start', root), true);
  root.querySelector('#status-progress-area').classList.remove('is-idle');
  assert.equal(searchIsolation('start', root), false);
  root.querySelector('#status-progress-area').classList.add('is-idle');
  root.body.insertAdjacentHTML('beforeend', '<div class="lister"></div>');
  assert.equal(searchIsolation('start', root), false);
  dom.window.close();
});

test('records actual host messages and rejects a second observer', () => {
  const dom = new JSDOM(''), root = dom.window.document;
  installSearchObservation(root);
  assert.throws(() => installSearchObservation(root), /active/i);
  const data = { type: 'search-progress', searchId: 'search-0123456789abcdef-1', path: 'C:/demo' };
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'unrelated' } }));
  assert.deepEqual(inspectSearchObservation(root), [data]);
  dom.window.__showcaseSearchObservation.dispose(); dom.window.close();
});

test('completed search must show its result and completion status', () => {
  const dom = new JSDOM('<dialog data-file-search open><p data-search-status>Search completed · 1</p><section><select data-search-results><option>Project-Plan.md</option></select></section></dialog>');
  const root = dom.window.document, list = root.querySelector('select');
  list.getBoundingClientRect = () => ({ width: 100, height: 40 });
  assert.equal(searchCompletedVisible(root), true);
  root.querySelector('section').hidden = true;
  assert.equal(searchCompletedVisible(root), false);
  root.querySelector('section').hidden = false; root.querySelector('p').textContent = 'Searching…';
  assert.equal(searchCompletedVisible(root), false);
  dom.window.close();
});

test('viewer button is clickable only when visible and unobstructed inside the search dialog', () => {
  const dom = new JSDOM('<dialog data-file-search open><button data-search-view>View</button></dialog>');
  const root = dom.window.document, dialog = root.querySelector('dialog'), button = root.querySelector('button');
  dialog.getBoundingClientRect = () => ({ left: 50, right: 650, top: 50, bottom: 550, width: 600, height: 500 });
  button.getBoundingClientRect = () => ({ left: 400, right: 460, top: 700, bottom: 730, width: 60, height: 30 });
  root.elementFromPoint = () => dialog;
  assert.equal(searchViewGeometry(root).visible, false);
  button.getBoundingClientRect = () => ({ left: 400, right: 460, top: 400, bottom: 430, width: 60, height: 30 });
  assert.equal(searchViewGeometry(root).visible, false);
  root.elementFromPoint = (x, y) => x === 430 && y === 415 ? button : dialog;
  assert.equal(searchViewGeometry(root).visible, true);
  button.disabled = true;
  assert.equal(searchViewGeometry(root).visible, false);
  dom.window.close();
});
