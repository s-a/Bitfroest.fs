const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { validateCatalog } = require('../scripts/showcases/run.cjs');
const { validateSequence } = require('../scripts/showcases/sequence.cjs');
const { fixtureSnapshot, installFixtureCompletion, inspectNotesCompletion } = require('../scripts/showcases/gestures.cjs');

test('notes actions require their own fixture', () => {
  const steps = ['create-notes', 'move-notes', 'batch-rename'].map(action => ({ type: 'confirm', action, effect: 'Apply notes' }));
  steps.push({ type: 'key', key: 'Ctrl+A' }, { type: 'key', key: 'Ctrl+M' });
  const scene = { id: 'notes', title: 'Notes', description: 'Organize notes.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{ id: 'story', format: 'gif', expect: '.pane', text: 'Notes', steps }] };
  assert.doesNotThrow(() => validateSequence(steps));
  assert.throws(() => validateCatalog([scene]), /fixture/i);
  assert.throws(() => validateCatalog([{ ...scene, fixture: 'handover' }]), /fixture/i);
  assert.doesNotThrow(() => validateCatalog([{ ...scene, fixture: 'organize-notes' }]));
});

test('reads the actual multi-rename preview and configuration', () => {
  const dom = new JSDOM('<dialog id="modal" open><span id="modal-title">Multi-rename</span><button id="modal-confirm"></button><input id="mask" value="[N]_[C]"><input id="counter" value="1"><input id="search"><input id="replacement"><select id="casing"><option value="keep">Keep</option></select><table><tbody id="rename-preview"><tr><td>Draft-A.txt</td><td>Draft-A_1.txt</td></tr></tbody></table></dialog>');
  const root = dom.window.document;
  dom.window.CommanderHost = { getState: () => ({ active: 1, panes: [{ tabs: ['C:/demo/left'], tab: 0 }, { tabs: ['C:/demo/right'], tab: 0, selected: ['a'] }], folders: { 'C:/demo/right': [{ id: 'a', fsSource: 'C:/demo/right/Draft-A.txt' }] } }) };
  const snapshot = fixtureSnapshot('batch-rename', root);
  assert.deepEqual(snapshot.preview, [['Draft-A.txt', 'Draft-A_1.txt']]);
  assert.equal(snapshot.mask, '[N]_[C]'); assert.equal(snapshot.counter, '1'); assert.equal(snapshot.casing, 'keep');
  dom.window.close();
});

test('requires matching successful host state and visible idle completion', () => {
  const dom = new JSDOM('<div id="status-progress-area" class="is-idle"></div><div id="status-activity" hidden></div><div id="panes"></div><div id="functionbar"></div><div id="status-message" data-outcome="success">Files created</div>');
  const root = dom.window.document, fixture = { left: 'C:/demo/left', right: 'C:/demo/right' };
  installFixtureCompletion(root);
  const response = { type: 'filesystem-result', ok: true, state: { realFilesystem: true, folders: { [fixture.left]: [{ name: 'Draft-A.txt', type: 'text' }, { name: 'Draft-B.txt', type: 'text' }], [fixture.right]: [] } } };
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: response }));
  assert.equal(inspectNotesCompletion('create-notes', fixture, root).complete, true);
  root.querySelector('#status-message').textContent = 'File operation in progress';
  assert.equal(inspectNotesCompletion('create-notes', fixture, root).complete, false);
  root.querySelector('#status-message').textContent = 'Files created'; response.state.folders[fixture.left].pop();
  assert.equal(inspectNotesCompletion('create-notes', fixture, root).complete, false);
  dom.window.__showcaseCompletion.dispose(); dom.window.close();
});

test('move requires its real transfer response and rename requires the final names', () => {
  const dom = new JSDOM('<div id="status-progress-area" class="is-idle"></div><div id="status-activity" hidden></div><div id="panes"></div><div id="functionbar"></div><div id="status-message" data-outcome="success">2 files moved, 0 skipped</div>');
  const root = dom.window.document, fixture = { left: 'C:/demo/left', right: 'C:/demo/right' };
  installFixtureCompletion(root);
  const response = { type: 'filesystem-result', operationId: 'transfer-checkpoint-123-1', ok: true, state: { realFilesystem: true, folders: { [fixture.left]: [], [fixture.right]: [{ name: 'Draft-A.txt', type: 'text' }, { name: 'Draft-B.txt', type: 'text' }] } } };
  const send = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send(response);
  assert.equal(inspectNotesCompletion('move-notes', fixture, root).complete, false);
  response.operationId = 'transfer-123-2'; send(response);
  assert.equal(inspectNotesCompletion('move-notes', fixture, root).complete, true);
  root.querySelector('#status-message').textContent = '2 entries renamed';
  assert.equal(inspectNotesCompletion('batch-rename', fixture, root).complete, false);
  response.state.folders[fixture.right] = [{ name: 'Draft-A_1.txt', type: 'text' }, { name: 'Draft-B_2.txt', type: 'text' }]; send(response);
  assert.equal(inspectNotesCompletion('batch-rename', fixture, root).complete, true);
  send({ type: 'filesystem-result', ok: false, error: 'Write failed' });
  assert.match(inspectNotesCompletion('batch-rename', fixture, root).error, /Write failed/);
  dom.window.__showcaseCompletion.dispose(); dom.window.close();
});
