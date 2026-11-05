const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOrganizeNotesFixture } = require('../scripts/showcases/organize-notes-fixture.cjs');

async function setup(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-notes-test-'));
  const fixture = await createOrganizeNotesFixture(parent, { timeout: 80, interval: 5 });
  t.after(async () => { await fixture.cleanup(); await fs.rmdir(parent); });
  const create = { activeDirectory: fixture.left, targetDirectory: fixture.left, selected: [], dialog: 'New text file', input: 'Draft-A.txt|Draft-B.txt', controlReady: true };
  const move = { activeDirectory: fixture.left, otherDirectory: fixture.right, transferSource: fixture.left, selected: fixture.sources, dialog: 'Move', input: fixture.right, filter: '*.*', policy: 'ask', individualNames: false, controlReady: true };
  const rename = { activeDirectory: fixture.right, selected: fixture.moved, dialog: 'Multi-rename', mask: '[N]_[C]', counter: '1', search: '', replacement: '', casing: 'keep', preview: [['Draft-A.txt', 'Draft-A_1.txt'], ['Draft-B.txt', 'Draft-B_2.txt']], controlReady: true };
  return { fixture, create, move, rename };
}

test('creates, moves and renames only the two controlled demo files', async t => {
  const h = await setup(t), f = h.fixture;
  assert.equal(path.basename(f.left), 'Drafts');
  assert.equal(path.basename(f.right), 'Handover');
  await f.confirm('create-notes', h.create, async () => { for (const name of f.sources) await fs.writeFile(name, '', { flag: 'wx' }); });
  await f.confirm('move-notes', h.move, async () => { for (let i = 0; i < 2; i++) await fs.rename(f.sources[i], f.moved[i]); });
  await f.confirm('batch-rename', h.rename, async () => { for (let i = 0; i < 2; i++) await fs.rename(f.moved[i], f.renamed[i]); });
  for (const name of f.renamed) assert.equal(await fs.readFile(name, 'utf8'), '');
  for (const name of [...f.sources, ...f.moved]) await assert.rejects(fs.stat(name), { code: 'ENOENT' });
});

test('rejects a changed destination, source, filename and rename preview before confirmation', async t => {
  const h = await setup(t), f = h.fixture; let calls = 0;
  await assert.rejects(f.confirm('create-notes', { ...h.create, input: '../Other.txt' }, async () => { calls++; }), /authorized fixture/);
  await f.confirm('create-notes', h.create, async () => { for (const name of f.sources) await fs.writeFile(name, '', { flag: 'wx' }); });
  for (const bad of [{ ...h.move, input: path.dirname(f.right) }, { ...h.move, selected: [f.sources[0], path.join(f.left, 'Foreign.txt')] }, { ...h.move, policy: 'overwrite' }]) {
    await assert.rejects(f.confirm('move-notes', bad, async () => { calls++; }), /authorized fixture/);
  }
  await f.confirm('move-notes', h.move, async () => { for (let i = 0; i < 2; i++) await fs.rename(f.sources[i], f.moved[i]); });
  await assert.rejects(f.confirm('batch-rename', { ...h.rename, preview: [['Draft-A.txt', 'Foreign.txt']] }, async () => { calls++; }), /authorized fixture/);
  assert.equal(calls, 0);
});

test('rejects an identity swap even when contents are identical', async t => {
  const h = await setup(t), f = h.fixture;
  await f.confirm('create-notes', h.create, async () => { for (const name of f.sources) await fs.writeFile(name, '', { flag: 'wx' }); });
  const hold = path.join(path.dirname(f.root), 'original-for-test');
  await fs.rename(f.sources[0], hold); await fs.writeFile(f.sources[0], '');
  try { await assert.rejects(f.confirm('move-notes', h.move, async () => {}), /identity changed/); }
  finally { await fs.unlink(f.sources[0]); await fs.rename(hold, f.sources[0]); }
});

test('does not report creation when no files were created', async t => {
  const h = await setup(t);
  await assert.rejects(h.fixture.confirm('create-notes', h.create, async () => {}), /result was not observed/);
});

test('rejects an unexpected destination entry before moving any notes', async t => {
  const h = await setup(t), f = h.fixture;
  await f.confirm('create-notes', h.create, async () => { for (const name of f.sources) await fs.writeFile(name, '', { flag: 'wx' }); });
  const extra = path.join(f.right, 'Unexpected.txt');
  await fs.writeFile(extra, 'foreign'); let triggered = false;
  try {
    await assert.rejects(f.confirm('move-notes', h.move, async () => { triggered = true; }), /Unexpected files/);
    assert.equal(triggered, false);
  } finally { await fs.unlink(extra); }
});
