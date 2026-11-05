const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zip = require('@zip.js/zip.js');
const { createArchiveStoryFixture } = require('../scripts/showcases/archive-story-fixture.cjs');

test('archive story authorizes only the fixture pack and verifies the actual archive content', async t => {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-story-'));
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  const fixture = await createArchiveStoryFixture(run, { timeout: 500, interval: 10 });
  const snapshot = { controlReady: true, activeDirectory: fixture.left, otherDirectory: fixture.right, selected: [fixture.source], dialog: 'Pack selection', input: fixture.archive, paths: true, recursive: true, move: false, encryption: 'none' };
  let triggered = false;
  await assert.rejects(fixture.confirm('pack', { ...snapshot, move: true }, async () => { triggered = true; }), /authorized/);
  assert.equal(triggered, false);
  await fixture.confirm('pack', snapshot, async () => {
    const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add('Project-Plan.md', new zip.TextReader(await fs.readFile(fixture.source, 'utf8')));
    await fs.writeFile(fixture.archive, await writer.close(), { flag: 'wx' });
  });
  await fixture.verifyArchive();
  const open = { controlReady: true, realFilesystem: true, activeDirectory: fixture.right, selected: [fixture.archive], entryName: 'Project-Plan.zip', dialog: 'file-list' };
  await fixture.validateOpen(open);
  await assert.rejects(fixture.validateOpen({ ...open, selected: [fixture.source] }), /authorized/);
  const leave = { controlReady: true, realFilesystem: true, archive: fixture.archive, parent: fixture.right, parentSelected: true };
  await fixture.validateLeave(leave);
  await assert.rejects(fixture.validateLeave({ ...leave, parent: fixture.left }), /authorized/);
  await assert.rejects(fixture.confirm('pack', snapshot, async () => {}), /already completed/);
  const unpack = { controlReady: true, activeDirectory: fixture.right, selected: [fixture.archive], dialog: 'Unpack archive', input: fixture.unpacked, paths: true, overwrite: false, separate: false, filter: '*.*' };
  await fixture.validateUnpackInput({ ...unpack, input: fixture.left });
  await assert.rejects(fixture.validateUnpackInput({ ...unpack, selected: [fixture.source] }), /authorized/);
  await assert.rejects(fixture.validatePathEdit({ controlReady: true, realFilesystem: true, activeDirectory: fixture.left }), /authorized/);
  await fixture.confirm('unpack', unpack, async () => fs.copyFile(fixture.source, fixture.extracted, fs.constants.COPYFILE_EXCL));
  assert.equal(await fs.readFile(fixture.extracted, 'utf8'), await fs.readFile(fixture.source, 'utf8'));
  await fixture.validateShow({ controlReady: true, realFilesystem: true, activeDirectory: fixture.left, input: fixture.unpacked });
  await fixture.validatePathEdit({ controlReady: true, realFilesystem: true, activeDirectory: fixture.left });
  await assert.rejects(fixture.validateShow({ controlReady: true, realFilesystem: true, activeDirectory: fixture.left, input: fixture.right }), /authorized/);
});

test('archive story rejects a pre-existing destination and wrong ZIP content', async t => {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-story-'));
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  const fixture = await createArchiveStoryFixture(run);
  const snapshot = { controlReady: true, activeDirectory: fixture.left, otherDirectory: fixture.right, selected: [fixture.source], dialog: 'Pack selection', input: fixture.archive, paths: true, recursive: true, move: false, encryption: 'none' };
  await fs.writeFile(fixture.archive, 'not a zip');
  await assert.rejects(fixture.confirm('pack', snapshot, async () => {}), /authorized/);
  await assert.rejects(fixture.verifyArchive());
});
