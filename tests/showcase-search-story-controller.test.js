const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { searchSnapshot, viewerMatch } = require('../scripts/showcases/search-story-state.cjs');
const { createSearchStoryFixture } = require('../scripts/showcases/search-story-fixture.cjs');
const { createSearchStoryController } = require('../scripts/showcases/search-story-controller.cjs');

test('reads search controls, selected result and viewer text from the DOM', () => {
  const dom = new JSDOM('<dialog data-file-search open><input name="name" value="Project-Plan.md"><input name="searchIn" value="C:/demo/project"><input type="checkbox" name="nameRegex"><input type="checkbox" name="archives"><input type="checkbox" name="selectedOnly"><button data-search-start></button><select data-search-results><option>C:/demo/project/documents/Project-Plan.md</option></select><button data-search-view></button></dialog><div class="lister"><div class="lister-heading"><span>C:/demo/project/documents/Project-Plan.md</span></div><textarea>review the delivery date</textarea></div><dialog id="modal" open><input id="lister-query" value="delivery date"><button id="modal-confirm"></button></dialog>');
  try {
    const doc = dom.window.document;
    assert.equal(searchSnapshot('start', doc).name, 'Project-Plan.md');
    assert.equal(searchSnapshot('view', doc).selectedPath, 'C:/demo/project/documents/Project-Plan.md');
    const text = doc.querySelector('textarea'); text.setSelectionRange(11, 24); text.getBoundingClientRect = () => ({ width: 400, height: 200 });
    assert.equal(viewerMatch(doc).selection, 'delivery date');
    assert.equal(searchSnapshot('find', doc).query, 'delivery date');
  } finally { dom.window.close(); }
});

async function setup(t, mutation = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-search-controller-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = await createSearchStoryFixture(dir), bytes = await fs.readFile(fixture.file), start = bytes.indexOf(fixture.findText);
  const snapshots = {
    start: { ready: true, name: fixture.query, searchIn: fixture.left, archives: false, nameRegex: false, selectedOnly: false },
    view: { ready: true, paths: [fixture.file], selectedPath: fixture.file },
    find: { ready: true, query: fixture.findText, viewerPath: fixture.file, optionsChecked: false }
  };
  const viewer = { path: fixture.file, visible: true, focused: true, selection: '' }, calls = [];
  const search = { type: 'search-progress', searchId: 'search-0123456789abcdef-1', path: fixture.left };
  const observer = type => ({
    waitProgress: async () => ({ ...search, ...mutation.progress }),
    waitComplete: async id => ({ type: 'search-complete', searchId: mutation.completionId || id, results: [{ fsSource: fixture.file }], errors: [] }),
    waitOpen: async () => ({ viewer: { ...viewer, ...mutation.viewer }, events: [{ type: 'lister-result', requestId: 'lister-0123456789abcdef-1', ok: true, id: 'session', view: { text: bytes.toString('utf8') } }] }),
    waitMatch: async () => ({ viewer: { ...viewer, selection: fixture.findText, ...mutation.matchViewer }, events: [{ type: 'lister-result', requestId: 'lister-0123456789abcdef-2', ok: true, match: { start, end: start + Buffer.byteLength(fixture.findText) } }] }),
    dispose: async () => calls.push(`disposed:${type}`)
  });
  const driver = createSearchStoryController({ fixture, readSnapshot: async action => snapshots[action], ensureIsolation: async () => mutation.isolated !== false,
    observe: async type => observer(type), activate: async action => calls.push(`action:${action}`) });
  return { driver, fixture, snapshots, calls };
}

test('uses observed root progress, host matches and real fixture text in order', async t => {
  const h = await setup(t);
  await h.driver.execute('start'); await h.driver.execute('view'); await h.driver.execute('find');
  assert.deepEqual(h.calls, ['action:start', 'disposed:search', 'action:view', 'disposed:viewer-open', 'action:find', 'disposed:viewer-find']);
});

test('rejects a non-fixture search, a mismatched completion and a nonexclusive run', async t => {
  const scope = await setup(t); scope.snapshots.start.searchIn = path.dirname(scope.fixture.root);
  await assert.rejects(scope.driver.execute('start'), /authorized/); assert.deepEqual(scope.calls, []);
  const mismatch = await setup(t, { completionId: 'search-0123456789abcdef-2' });
  await assert.rejects(mismatch.driver.execute('start'), /does not match/); assert.ok(mismatch.calls.includes('disposed:search'));
  const nonexclusive = await setup(t, { isolated: false });
  await assert.rejects(nonexclusive.driver.execute('start'), /isolated/);
});

test('rejects a wrong visible file or an invisible viewer selection', async t => {
  const wrong = await setup(t, { viewer: { path: 'C:/elsewhere.txt' } });
  await wrong.driver.execute('start'); await assert.rejects(wrong.driver.execute('view'), /not visibly opened/);
  const hidden = await setup(t, { matchViewer: { visible: false } });
  await hidden.driver.execute('start'); await hidden.driver.execute('view'); await assert.rejects(hidden.driver.execute('find'), /visibl/);
});
