const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStoryFixture } = require('../scripts/showcases/story-fixture.cjs');
const { fixtureSnapshot, installFixtureCompletion, inspectFixtureCompletion } = require('../scripts/showcases/gestures.cjs');
const { JSDOM } = require('jsdom');

test('fixture completion waits for a matching successful host reply and idle product state', () => {
  const dom = new JSDOM('<div id="panes"></div><div id="functionbar"></div><div id="status-progress-area"></div><div id="status-activity"></div><div id="status-message" data-outcome="info">File operation in progress…</div>');
  try {
    const doc = dom.window.document, folder = 'C:/demo/right/Handover';
    installFixtureCompletion(doc);
    const inspect = () => inspectFixtureCompletion('rename', { right: 'C:/demo/right', folder }, doc);
    const result = { type: 'filesystem-result', ok: true, state: { realFilesystem: true, folders: { [folder]: [{ name: 'Handover-Plan.md', type: 'markdown' }] } } };
    assert.equal(inspect().complete, false);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { ...result, navigationRequestId: 'directory-1' } }));
    assert.equal(inspect().complete, false);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: result }));
    assert.equal(inspect().complete, false);
    doc.querySelector('#status-progress-area').classList.add('is-idle');
    doc.querySelector('#status-activity').hidden = true;
    assert.equal(inspect().complete, false, 'a stale in-progress message must not be accepted');
    doc.querySelector('#status-message').dataset.outcome = 'success';
    doc.querySelector('#status-message').textContent = 'Entry renamed.';
    assert.equal(inspect().complete, true);
    dom.window.__showcaseCompletion.dispose();
  } finally { dom.window.close(); }
});

test('a successful transfer reply with a Markdown entry confirms the copy only after the product is idle', () => {
  const dom = new JSDOM('<div id="panes"></div><div id="functionbar"></div><div id="status-progress-area"></div><div id="status-activity"></div><div id="status-message" data-outcome="success">1 file copied, 0 skipped</div>');
  try {
    const doc = dom.window.document, folder = 'C:/demo/right/Handover';
    installFixtureCompletion(doc);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, operationId: 'transfer-0',
      state: { realFilesystem: true, folders: { [folder]: [{ name: 'Project-Plan.md', type: 'folder' }] } } } }));
    doc.querySelector('#status-progress-area').classList.add('is-idle');
    doc.querySelector('#status-activity').hidden = true;
    assert.equal(inspectFixtureCompletion('copy', { right: 'C:/demo/right', folder }, doc).complete, false);
    doc.querySelector('#status-progress-area').classList.remove('is-idle');
    doc.querySelector('#status-activity').hidden = false;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, operationId: 'transfer-1',
      state: { realFilesystem: true, folders: { [folder]: [{ name: 'Project-Plan.md', type: 'markdown' }] } } } }));
    assert.equal(inspectFixtureCompletion('copy', { right: 'C:/demo/right', folder }, doc).complete, false);
    doc.querySelector('#status-progress-area').classList.add('is-idle');
    doc.querySelector('#status-activity').hidden = true;
    assert.equal(inspectFixtureCompletion('copy', { right: 'C:/demo/right', folder }, doc).complete, true);
    dom.window.__showcaseCompletion.dispose();
  } finally { dom.window.close(); }
});

test('fixture completion rejects host failure and cancellation', () => {
  for (const result of [{ ok: false, error: 'Denied' }, { ok: true, cancelled: true }, { ok: true, operationOutcome: { errors: ['Failed'] } }]) {
    const dom = new JSDOM('<div id="panes"></div><div id="functionbar"></div><div id="status-progress-area" class="is-idle"></div><div id="status-activity" hidden></div>');
    try {
      installFixtureCompletion(dom.window.document);
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'filesystem-result', ...result } }));
      assert.ok(inspectFixtureCompletion('copy', { right: 'C:/demo/right', folder: 'C:/demo/right/Handover' }, dom.window.document).error);
      dom.window.__showcaseCompletion.dispose();
    } finally { dom.window.close(); }
  }
});

test('confirmation snapshot reads the active pane, selected file and real dialog controls', () => {
  const dom = new JSDOM('<dialog id="modal" open><h1 id="modal-title">Copy</h1><div data-transfer-source>C:/demo/left</div><input id="value" value="C:/demo/right"><input id="transfer-filter" value="*.*"><select id="transfer-policy"><option value="ask">Ask</option></select><input id="transfer-individual" type="checkbox"><button id="modal-confirm">Copy</button></dialog>');
  try {
    dom.window.CommanderHost = { getState: () => ({ active: 0, panes: [{ tabs: ['C:/demo/left'], tab: 0, selected: ['id-1'] }, { tabs: ['C:/demo/right'], tab: 0 }], folders: { 'C:/demo/left': [{ id: 'id-1', fsSource: 'C:/demo/left/Project-Plan.md' }] } }) };
    assert.deepEqual(fixtureSnapshot('copy', dom.window.document), { activeDirectory: 'C:/demo/left', otherDirectory: 'C:/demo/right', selected: ['C:/demo/left/Project-Plan.md'], dialog: 'Copy', input: 'C:/demo/right', controlReady: true, filter: '*.*', policy: 'ask', transferSource: 'C:/demo/left', individualNames: false });
    dom.window.document.querySelector('#modal-confirm').disabled = true;
    assert.equal(fixtureSnapshot('copy', dom.window.document).controlReady, false);
  } finally { dom.window.close(); }
});

test('story actions are restricted to the isolated fixture and verify actual results', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-story-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = await createStoryFixture(parent, { timeout: 100, interval: 5 });
  const base = { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true };
  let called = false;
  await assert.rejects(fixture.confirm('mkdir', { ...base, activeDirectory: parent }, async () => { called = true; }), /fixture/);
  assert.equal(called, false);
  const folder = path.join(fixture.right, 'Handover');
  await fixture.confirm('mkdir', base, () => fs.mkdir(folder));
  const opening = { activeDirectory: fixture.right, selected: [folder], entryType: 'folder', dialog: 'folder-list', controlReady: true };
  await assert.rejects(fixture.confirm('open', { ...opening, selected: [parent] }, async () => { called = true; }), /fixture/);
  assert.equal(called, false);
  await fixture.confirm('open', opening, async () => ({ activeDirectory: folder }));
  const source = path.join(fixture.left, 'Project-Plan.md'), copy = path.join(folder, 'Project-Plan.md');
  const transfer = { activeDirectory: fixture.left, otherDirectory: folder, transferSource: fixture.left, selected: [source], dialog: 'Copy', input: folder, filter: '*.*', policy: 'ask', individualNames: false, controlReady: true };
  await assert.rejects(fixture.confirm('copy', { ...transfer, input: parent }, async () => { called = true; }), /fixture/);
  assert.equal(called, false);
  await fixture.confirm('copy', transfer, () => fs.copyFile(source, copy));
  const rename = { activeDirectory: folder, selected: [copy], dialog: 'inline-rename', input: 'Handover-Plan.md', controlReady: true };
  const original = await fs.lstat(copy, { bigint: true });
  await fixture.confirm('rename', rename, async () => {
    await fs.copyFile(copy, path.join(folder, 'Handover-Plan.md'));
    const published = await fs.lstat(path.join(folder, 'Handover-Plan.md'), { bigint: true });
    assert.notEqual(`${original.dev}:${original.ino}`, `${published.dev}:${published.ino}`);
    await fs.unlink(copy);
  });
  await assert.rejects(fixture.confirm('rename', rename, async () => {}), /already completed/);
});

test('a missing or incorrect result is not treated as a successful confirmation', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-story-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = await createStoryFixture(parent, { timeout: 20, interval: 5 });
  await assert.rejects(fixture.confirm('mkdir', { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true }, async () => {}), /result/);
  await assert.rejects(fixture.confirm('mkdir', { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true }, async () => {}), /failed/);
});

test('fixture marker and source content are rechecked immediately before confirmation', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-story-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = await createStoryFixture(parent);
  await fs.writeFile(path.join(fixture.left, 'Project-Plan.md'), 'changed');
  let invoked = false;
  await assert.rejects(fixture.confirm('mkdir', { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true }, async () => { invoked = true; }), /fixture/);
  assert.equal(invoked, false);
});

test('replacing the created destination folder blocks the copy before input', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-story-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = await createStoryFixture(parent);
  const folder = path.join(fixture.right, 'Handover');
  await fixture.confirm('mkdir', { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true }, () => fs.mkdir(folder));
  await fixture.confirm('open', { activeDirectory: fixture.right, selected: [folder], entryType: 'folder', dialog: 'folder-list', controlReady: true }, async () => ({ activeDirectory: folder }));
  await fs.rename(folder, path.join(fixture.right, 'replaced'));
  await fs.mkdir(folder);
  let invoked = false;
  const source = path.join(fixture.left, 'Project-Plan.md');
  await assert.rejects(fixture.confirm('copy', { activeDirectory: fixture.left, otherDirectory: folder, transferSource: fixture.left, selected: [source], dialog: 'Copy', input: folder, filter: '*.*', policy: 'ask', individualNames: false, controlReady: true }, async () => { invoked = true; }), /identity/);
  assert.equal(invoked, false);
});

test('opening the folder requires list focus and the actual destination', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-story-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = await createStoryFixture(parent, { timeout: 20, interval: 5 });
  const folder = path.join(fixture.right, 'Handover');
  await fixture.confirm('mkdir', { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true }, () => fs.mkdir(folder));
  const opening = { activeDirectory: fixture.right, selected: [folder], entryType: 'folder', dialog: 'folder-list', controlReady: true };
  let invoked = false;
  await assert.rejects(fixture.confirm('open', { ...opening, controlReady: false }, async () => { invoked = true; }), /fixture/);
  assert.equal(invoked, false);
  await assert.rejects(fixture.confirm('open', opening, async () => ({ activeDirectory: fixture.right })), /result/);
});

test('renaming requires the original name to disappear and the new file to retain its content', async t => {
  for (const problem of ['old-name-remains', 'wrong-content']) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-story-test-'));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const fixture = await createStoryFixture(parent, { timeout: 30, interval: 5 });
    const folder = path.join(fixture.right, 'Handover'), source = path.join(fixture.left, 'Project-Plan.md'), copy = path.join(folder, 'Project-Plan.md'), target = path.join(folder, 'Handover-Plan.md');
    await fixture.confirm('mkdir', { activeDirectory: fixture.right, targetDirectory: fixture.right, selected: [], dialog: 'New folder', input: 'Handover', controlReady: true }, () => fs.mkdir(folder));
    await fixture.confirm('open', { activeDirectory: fixture.right, selected: [folder], entryType: 'folder', dialog: 'folder-list', controlReady: true }, async () => ({ activeDirectory: folder }));
    await fixture.confirm('copy', { activeDirectory: fixture.left, otherDirectory: folder, transferSource: fixture.left, selected: [source], dialog: 'Copy', input: folder, filter: '*.*', policy: 'ask', individualNames: false, controlReady: true }, () => fs.copyFile(source, copy));
    const rename = { activeDirectory: folder, selected: [copy], dialog: 'inline-rename', input: 'Handover-Plan.md', controlReady: true };
    await assert.rejects(fixture.confirm('rename', rename, async () => {
      if (problem === 'old-name-remains') await fs.copyFile(copy, target);
      else { await fs.writeFile(target, 'wrong'); await fs.unlink(copy); }
    }), /result/);
  }
});
