const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { validateCatalog } = require('../scripts/showcases/run.cjs');

test('archive actions and extraction path require the archive fixture', () => {
  const scene = { id: 'archive-story', title: 'Archive', description: 'Archive files.', paths: ['C:/demo/left', 'C:/demo/right'], captures: [{ id: 'story', format: 'gif', expect: '.pane', text: 'Plan', steps: [
    { type: 'fixture-path', selector: 'dialog[open] #value', path: 'unpacked' }, { type: 'confirm', action: 'archive-unpack', effect: 'Extract' }
  ] }] };
  assert.throws(() => validateCatalog([scene]), /fixture/i);
  assert.throws(() => validateCatalog([{ ...scene, fixture: 'handover' }]), /fixture/i);
  assert.doesNotThrow(() => validateCatalog([{ ...scene, fixture: 'archive-story' }]));
});
const { archiveSnapshot, installArchiveCompletion, inspectArchiveCompletion, inspectArchiveOpened, inspectArchiveProgress, inspectArchiveLeft, inspectArchiveExtracted } = require('../scripts/showcases/archive-state.cjs');

test('archive operation identity comes from matching real progress and rejects ambiguity', () => {
  const { dom, root } = harness();
  try {
    installArchiveCompletion(root);
    const send = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
    const fixture = { source: 'C:/demo/left/Project-Plan.md' };
    assert.equal(inspectArchiveProgress('pack', fixture, root).operationId, undefined);
    send({ type: 'filesystem-progress', operationId: 'zip-write-1-1', progress: { phase: 'preparing', currentPath: 'C:/demo/left/other.md' } });
    assert.equal(inspectArchiveProgress('pack', fixture, root).operationId, undefined);
    send({ type: 'filesystem-progress', operationId: 'zip-write-1-1', progress: { phase: 'preparing', currentPath: fixture.source } });
    assert.equal(inspectArchiveProgress('pack', fixture, root).operationId, 'zip-write-1-1');
    send({ type: 'filesystem-progress', operationId: 'zip-write-2-2', progress: { phase: 'preparing', currentPath: fixture.source } });
    assert.match(inspectArchiveProgress('pack', fixture, root).error, /ambiguous/i);
    dom.window.__showcaseArchiveCompletion.dispose();
    installArchiveCompletion(root);
    send({ type: 'filesystem-progress', operationId: 'zip-write-3-3', progress: { phase: 'copying', currentPath: 'Project-Plan.md' } });
    assert.equal(inspectArchiveProgress('unpack', fixture, root).operationId, 'zip-write-3-3');
    dom.window.__showcaseArchiveCompletion.dispose();
    installArchiveCompletion(root);
    send({ type: 'filesystem-result', ok: false, operationId: 'zip-write-4-4', error: 'Archive denied' });
    assert.match(inspectArchiveProgress('pack', fixture, root).error, /Archive denied/);
    dom.window.__showcaseArchiveCompletion.dispose();
  } finally { dom.window.close(); }
});

function harness() {
  const dom = new JSDOM('<body><section class="pane active"><div class="list" tabindex="0"></div></section><div id="panes"></div><div id="functionbar"></div><div id="status-progress-area" class="is-idle"></div><span id="status-activity" hidden></span><span id="status-message" data-outcome="success">File operation completed</span><dialog id="modal" open><div id="modal-title">Pack selection</div><input id="value" value="C:/demo/right/Project-Plan.zip"><button id="modal-confirm">Pack</button><input id="zip-paths" type="checkbox" checked><input id="zip-recursive" type="checkbox" checked><input id="zip-move" type="checkbox"><select id="zip-encryption"><option value="none">None</option></select></dialog></body>', { url: 'https://example.invalid' });
  const state = { realFilesystem: true, active: 0, panes: [{ tabs: ['C:/demo/left'], tab: 0, selected: ['file'] }, { tabs: ['C:/demo/right'], tab: 0, selected: [] }], folders: { 'C:/demo/left': [{ id: 'file', fsSource: 'C:/demo/left/Project-Plan.md' }] } };
  dom.window.BitfroestHost = { getState: () => state };
  return { dom, state, root: dom.window.document };
}

test('reads the actual pack and unpack dialog controls and selected filesystem entries', () => {
  const { dom, root } = harness();
  try {
    const pack = archiveSnapshot('pack', root);
    assert.deepEqual(pack.selected, ['C:/demo/left/Project-Plan.md']);
    assert.equal(pack.dialog, 'Pack selection'); assert.equal(pack.input, 'C:/demo/right/Project-Plan.zip');
    assert.deepEqual([pack.paths, pack.recursive, pack.move, pack.encryption, pack.controlReady], [true, true, false, 'none', true]);
    root.querySelector('#modal-title').textContent = 'Unpack archive';
    root.querySelector('#modal').insertAdjacentHTML('beforeend', '<input id="zip-overwrite" type="checkbox"><input id="zip-separate" type="checkbox"><input id="zip-filter" value="*.*">');
    const unpack = archiveSnapshot('unpack', root);
    assert.deepEqual([unpack.overwrite, unpack.separate, unpack.filter], [false, false, '*.*']);
  } finally { dom.window.close(); }
});

test('open checks selected ZIP and confirms navigation into the same archive', () => {
  const { dom, root, state } = harness();
  try {
    root.querySelector('#modal').remove(); root.querySelector('.list').focus();
    state.panes[0].tabs[0] = 'C:/demo/right'; state.panes[0].selected = ['archive'];
    state.folders['C:/demo/right'] = [{ id: 'archive', fsSource: 'C:/demo/right/Project-Plan.zip', name: 'Project-Plan.zip', type: 'archive' }];
    assert.equal(archiveSnapshot('open-archive', root).controlReady, true);
    const expected = { right: 'C:/demo/right', archive: 'C:/demo/right/Project-Plan.zip', operationId: 'zip-write-1-1' };
    assert.equal(inspectArchiveOpened(expected, root).complete, false);
    state.panes[0].tabs[0] = 'zip:sample'; state.archiveLocations = { 'zip:sample': { archive: expected.archive, parent: expected.right } };
    state.folders['zip:sample'] = [{ name: 'Project-Plan.md', archiveEntry: 'Project-Plan.md', archive: expected.archive }];
    assert.equal(inspectArchiveOpened(expected, root).complete, true);
    state.archiveLocations['zip:sample'].archive = 'C:/demo/right/other.zip';
    assert.equal(inspectArchiveOpened(expected, root).complete, false);
  } finally { dom.window.close(); }
});

test('leaving the archive and showing extracted files require the real expected locations', () => {
  const { dom, root, state } = harness();
  try {
    root.querySelector('#modal').remove(); root.querySelector('.list').focus();
    const expected = { right: 'C:/demo/right', archive: 'C:/demo/right/Project-Plan.zip', unpacked: 'C:/demo/unpacked', extracted: 'C:/demo/unpacked/Project-Plan.md' };
    state.panes[0].tabs[0] = 'zip:sample'; state.panes[0].selected = ['\u0000parent']; state.panes[0].cursor = '\u0000parent';
    state.archiveLocations = { 'zip:sample': { archive: expected.archive, parent: expected.right } };
    const leave = archiveSnapshot('leave-archive', root);
    assert.equal(leave.parentSelected, true); assert.equal(leave.archive, expected.archive);
    assert.equal(inspectArchiveLeft(expected, root).complete, false);
    state.panes[0].tabs[0] = expected.right; state.folders[expected.right] = [{ name: 'Project-Plan.zip', fsSource: expected.archive }];
    assert.equal(inspectArchiveLeft(expected, root).complete, true);
    state.panes[0].tabs[0] = expected.unpacked; state.folders[expected.unpacked] = [{ name: 'Project-Plan.md', fsSource: expected.extracted }];
    assert.equal(inspectArchiveExtracted(expected, root).complete, true);
    state.folders[expected.unpacked][0].fsSource = 'C:/elsewhere/Project-Plan.md';
    assert.equal(inspectArchiveExtracted(expected, root).complete, false);
  } finally { dom.window.close(); }
});

test('waits for host completion and idle status; errors and committed-but-unverified results fail', () => {
  const { dom, root } = harness();
  try {
    installArchiveCompletion(root);
    const event = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
    const expected = { right: 'C:/demo/right', archive: 'C:/demo/right/Project-Plan.zip', operationId: 'zip-write-1-1' };
    assert.equal(inspectArchiveCompletion('pack', expected, root).complete, false);
    event({ type: 'filesystem-result', ok: true, operationId: 'zip-write-1-1', state: { realFilesystem: true, folders: { 'C:/demo/right': [{ name: 'Project-Plan.zip', fsSource: expected.archive }] } } });
    assert.equal(inspectArchiveCompletion('pack', expected, root).complete, true);
    root.querySelector('#status-progress-area').classList.remove('is-idle');
    assert.equal(inspectArchiveCompletion('pack', expected, root).complete, false);
    event({ type: 'filesystem-result', ok: false, operationId: 'zip-write-2-2', error: 'unrelated' });
    assert.equal(inspectArchiveCompletion('pack', expected, root).complete, false);
    event({ type: 'filesystem-result', ok: false, operationId: expected.operationId, error: 'failed' });
    assert.match(inspectArchiveCompletion('pack', expected, root).error, /failed/);
    dom.window.__showcaseArchiveCompletion.dispose();
  } finally { dom.window.close(); }
});
