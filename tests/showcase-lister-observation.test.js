const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { viewerEvidence, verifyViewerObservation } = require('../scripts/showcases/lister-observation.cjs');

test('reads the actual focused viewer selection and visible file title', () => {
  const dom = new JSDOM('<div class="lister"><div class="lister-heading"><span>C:/demo/Project-Plan.md</span></div><textarea>review the delivery date</textarea></div>');
  try {
    const area = dom.window.document.querySelector('textarea');
    area.getBoundingClientRect = () => ({ width: 300, height: 100, left: 0, top: 0, right: 300, bottom: 100 }); area.focus(); area.setSelectionRange(11, 24);
    assert.deepEqual(viewerEvidence(dom.window.document), { path: 'C:/demo/Project-Plan.md', visible: true, focused: true, selection: 'delivery date' });
  } finally { dom.window.close(); }
});

test('accepts one observed host match only after a clear baseline and visible selection', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lister-observation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Project-Plan.md'), bytes = Buffer.from('Launch: delivery date.\n');
  await fs.writeFile(file, bytes);
  let verified = false;
  const fixture = { file, findText: 'delivery date', verify: async values => { assert.deepEqual(values, [file]); verified = true; } };
  const before = { path: file, visible: true, focused: true, selection: '' };
  const after = { ...before, selection: fixture.findText };
  const start = bytes.indexOf(fixture.findText), result = { type: 'lister-result', requestId: 'lister-0123456789abcdef-8', ok: true, match: { start, end: start + Buffer.byteLength(fixture.findText) } };
  const evidence = await verifyViewerObservation({ fixture, bytes, before, after, events: [result], isolated: true });
  assert.equal(verified, true); assert.equal(evidence.observedRequestId, result.requestId);
  await assert.rejects(verifyViewerObservation({ fixture, bytes, before: after, after, events: [result], isolated: true }), /baseline/);
  await assert.rejects(verifyViewerObservation({ fixture, bytes, before, after, events: [result, result], isolated: true }), /ambiguous/);
  await assert.rejects(verifyViewerObservation({ fixture, bytes, before, after: { ...after, focused: false }, events: [result], isolated: true }), /visibl/);
  await assert.rejects(verifyViewerObservation({ fixture, bytes, before, after, events: [result], isolated: false }), /isolated/);
});
