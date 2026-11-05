const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDeletionStoryFixture } = require('../scripts/showcases/deletion-story-fixture.cjs');

async function setup(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-delete-test-'));
  const fixture = await createDeletionStoryFixture(parent, { timeout: 100, interval: 5 });
  t.after(async () => { await fixture.cleanup(); await fs.rmdir(parent); });
  const snapshot = { activeDirectory: fixture.left, selected: [fixture.discard],
    dialog: 'Delete permanently?', dialogFiles: ['Discard.tmp'], controlReady: true };
  return { fixture, snapshot };
}

test('only the designated disposable file is permanently removed and survivors remain intact', async t => {
  const { fixture, snapshot } = await setup(t);
  await fixture.confirm('delete-permanent', snapshot, async () => { await fs.unlink(fixture.discard); return { ok: true }; });
  await fixture.verifyAfterDelete();
  await assert.rejects(fs.stat(fixture.discard), { code: 'ENOENT' });
  assert.equal(await fs.readFile(fixture.keep, 'utf8'), 'Keep this project note.\n');
  assert.equal(await fs.readFile(fixture.other, 'utf8'), 'Keep this second note.\n');
  await assert.rejects(fixture.confirm('delete-permanent', snapshot, async () => {}), /completed/);
});

test('trash and permanent deletion use different fixture files and retain both survivors', async t => {
  const { fixture, snapshot } = await setup(t);
  const trash = { activeDirectory: fixture.left, selected: [fixture.recycle], dialog: 'Move to Trash?', dialogFiles: ['Recycle.tmp'], controlReady: true };
  let invoked = false;
  await assert.rejects(fixture.confirm('trash', { ...trash, selected: [fixture.discard] }, async () => { invoked = true; }), /authorized fixture/);
  assert.equal(invoked, false);
  const moved = path.join(path.dirname(fixture.root), 'simulated-trash.tmp');
  try {
    await fixture.confirm('trash', trash, () => fs.rename(fixture.recycle, moved));
    await fixture.verifyAfterTrash();
    assert.equal(await fs.readFile(fixture.discard, 'utf8'), 'Disposable showcase file.\n');
    await fixture.confirm('delete-permanent', snapshot, () => fs.unlink(fixture.discard));
    await fixture.verifyAfterDelete();
    assert.deepEqual(fixture.remainingNames.sort(), ['Keep.txt', 'Other.txt']);
  } finally { await fs.unlink(moved).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
});

test('rejects foreign paths, multiple selections and wrong confirmation dialogs before triggering', async t => {
  const { fixture, snapshot } = await setup(t);
  let calls = 0;
  for (const bad of [
    { ...snapshot, selected: [path.join(fixture.left, '..', 'foreign.tmp')] },
    { ...snapshot, selected: [fixture.discard, fixture.keep] },
    { ...snapshot, activeDirectory: path.dirname(fixture.left) },
    { ...snapshot, dialog: 'Move to Trash?' },
    { ...snapshot, dialogFiles: ['Discard.tmp', 'Keep.txt'] },
    { ...snapshot, controlReady: false }
  ]) await assert.rejects(fixture.confirm('delete-permanent', bad, async () => { calls++; }), /authorized fixture/);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(fixture.discard, 'utf8'), 'Disposable showcase file.\n');
});

test('rejects replacement of the fixture file before confirmation', async t => {
  const { fixture, snapshot } = await setup(t);
  const saved = path.join(fixture.left, 'saved-for-test');
  await fs.rename(fixture.discard, saved);
  await fs.writeFile(fixture.discard, 'Disposable showcase file.\n');
  let triggered = false;
  try {
    await assert.rejects(fixture.confirm('delete-permanent', snapshot, async () => { triggered = true; }), /identity changed/);
    assert.equal(triggered, false);
  } finally { await fs.unlink(fixture.discard); await fs.rename(saved, fixture.discard); }
});

test('does not report success when the confirmation leaves the file in place', async t => {
  const { fixture, snapshot } = await setup(t);
  await assert.rejects(fixture.confirm('delete-permanent', snapshot, async () => {}), /deletion was not observed/);
  await assert.rejects(fixture.verifyAfterDelete(), /still exists/);
});
